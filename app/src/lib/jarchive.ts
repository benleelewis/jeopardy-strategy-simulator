/**
 * jarchive.ts — parse a single J-Archive `showgame.php` page into a
 * clue-by-clue game record, and reconstruct the running score before/after
 * every clue.
 *
 * Why this exists: J-Archive publishes each clue's order, value, Daily Double
 * wager, and who was right/wrong — but NOT the running scoreboard. Any
 * question of the form "what was the state when X hit that Daily Double?"
 * requires replaying the round. This module does that replay and
 * self-validates against the score checkpoints J-Archive *does* publish
 * (first commercial break, end of J round, end of DJ round), so a parsing
 * mistake surfaces as a checkpoint mismatch instead of a plausible-looking
 * wrong answer.
 *
 * This is the SHARED, pure half of the parser — HTML in, records out, no
 * `fs`/`path`/`fetch`. It has two callers with different I/O needs:
 *   - `scripts/lib/jarchive.ts` (Node CLI): wraps this with a disk cache
 *     (`data/jarchive-cache/`) and the actual `fetch`.
 *   - `app/api/jarchive.ts` (Vercel serverless function): wraps this with a
 *     `fetch` and Vercel's edge cache (`Cache-Control: s-maxage`) instead —
 *     serverless has no disk to cache to.
 *
 * Fetch policy (CLAUDE.md): single-URL fetch only, never a bulk scrape. Both
 * callers enforce this; this module never fetches anything itself.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export type Round = 'J' | 'DJ';

export interface Clue {
  round: Round;
  /** 1-indexed category column (1-6), left to right. */
  col: number;
  /** 1-indexed row (1-5), top to bottom. */
  row: number;
  category: string;
  /** Face value of the board square (unaffected by a DD wager). */
  boundValue: number;
  /** Selection order within the round (1-30). `null` = never revealed. */
  order: number | null;
  isDD: boolean;
  /** DD wager as printed by J-Archive (`DD: $10,000`). Null for non-DDs. */
  wager: number | null;
  /** Nickname of the correct responder, or null (triple stumper / DD miss). */
  right: string | null;
  /** Nicknames of players who responded incorrectly (excludes the literal
   *  "Triple Stumper" marker, which is a label and not a player). */
  wrong: string[];
}

export interface Checkpoint {
  label: string;
  /** Scores in `players` order. */
  scores: number[];
  /** Clue order number the checkpoint follows, when J-Archive states one. */
  afterClue: number | null;
  round: Round;
}

export interface ParsedGame {
  gameId: number | null;
  title: string;
  /** Podium nicknames, left to right — the names used in right/wrong cells. */
  players: string[];
  fullNames: string[];
  clues: Clue[];
  checkpoints: Checkpoint[];
  /** Final Jeopardy: per-player wager and correctness, in `players` order. */
  fj: { wagers: number[]; correct: boolean[]; finalScores: number[] } | null;
}

/** One replay step: the scoreboard immediately before and after a clue. */
export interface ReplayStep {
  clue: Clue;
  before: number[];
  after: number[];
  /** Clues still unrevealed in this round AFTER this clue resolves. */
  remainingValues: number[];
  /** Daily Doubles still unfound in this round AFTER this clue resolves. */
  remainingDDs: number;
}

export interface Replay {
  steps: ReplayStep[];
  /** Scores at the end of each round, by round. */
  endOfRound: Record<Round, number[]>;
  /** Checkpoint validation — empty `mismatches` means the replay is exact. */
  validation: {
    checked: number;
    mismatches: { label: string; expected: number[]; actual: number[] }[];
  };
}

// ─── Constants ───────────────────────────────────────────────────────────

const ROUND_VALUES: Record<Round, number[]> = {
  J: [200, 400, 600, 800, 1000],
  DJ: [400, 800, 1200, 1600, 2000],
};

// ─── Parse ───────────────────────────────────────────────────────────────

function decode(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(s: string): number {
  const m = s.replace(/[^0-9-]/g, '');
  return m === '' || m === '-' ? 0 : parseInt(m, 10);
}

/** Slice out one round's HTML by its wrapper div id. */
function roundSection(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return '';
  // Rounds are siblings; the next round div (or the footer) bounds this one.
  const rest = html.slice(start);
  const next = rest.slice(1).search(/id="(double_jeopardy_round|final_jeopardy_round|final_round)"/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function parseCategories(section: string): string[] {
  return [...section.matchAll(/class="category_name"[^>]*>([\s\S]*?)<\/td>/g)]
    .map(m => decode(m[1]));
}

/**
 * Extract the hidden "response" cell for one clue id. Bounded by the next
 * `id="clue_` marker rather than by a closing tag, because the cell contains
 * nested `<table>/<td>` markup for each responder.
 */
function responseBody(section: string, id: string): string {
  const anchor = section.indexOf(`id="${id}"`);
  if (anchor < 0) return '';
  const after = section.slice(anchor + id.length + 5);
  const next = after.indexOf('id="clue_');
  return next < 0 ? after : after.slice(0, next);
}

function parseRoundClues(section: string, round: Round): Clue[] {
  const categories = parseCategories(section);
  const clues: Clue[] = [];
  const printed: { row: number; value: number }[] = [];

  // Each clue's header carries id="clue_<R>_<col>_<row>_stuck", then the value
  // cell (plain or daily-double) and the order number.
  const headerRe = new RegExp(
    `id="clue_${round}_(\\d+)_(\\d+)_stuck"[\\s\\S]{0,400}?` +
    `class="(clue_value|clue_value_daily_double)"[^>]*>([^<]*)<\\/td>` +
    `[\\s\\S]{0,400}?class="clue_order_number"[^>]*>([\\s\\S]*?)<\\/td>`,
    'g',
  );

  for (const m of section.matchAll(headerRe)) {
    const col = parseInt(m[1], 10);
    const row = parseInt(m[2], 10);
    const isDD = m[3] === 'clue_value_daily_double';
    const valueText = m[4];
    const orderText = decode(m[5]);
    const order = /^\d+$/.test(orderText) ? parseInt(orderText, 10) : null;

    // The response cell for this clue lives further down the same table. It
    // ends at the next `id="clue_..."` (the following clue's header, or this
    // clue's trailing <var>) — NOT at the first `</td></tr>`, which would
    // stop inside the nested right/wrong table and silently drop the
    // responder names.
    const body = responseBody(section, `clue_${round}_${col}_${row}_r`);

    const right = [...body.matchAll(/class="right"[^>]*>([\s\S]*?)<\/td>/g)]
      .map(r => decode(r[1]))
      .filter(n => n.length > 0);
    const wrong = [...body.matchAll(/class="wrong"[^>]*>([\s\S]*?)<\/td>/g)]
      .map(r => decode(r[1]))
      .filter(n => n.length > 0 && n !== 'Triple Stumper');

    clues.push({
      round, col, row,
      category: categories[col - 1] ?? `Category ${col}`,
      boundValue: ROUND_VALUES[round][row - 1],
      order,
      isDD,
      wager: isDD ? money(valueText) : null,
      right: right[0] ?? null,
      wrong,
    });
    if (!isDD) printed.push({ row, value: money(valueText) });
  }

  // Games before the 2001-11-26 value doubling print $100–$500 / $200–$1,000.
  // A Daily Double square shows only its wager, so infer the round's scale
  // from the squares that do print a face value and apply it to every clue.
  const halved = printed.filter(p => p.value === ROUND_VALUES[round][p.row - 1] / 2).length;
  const full = printed.filter(p => p.value === ROUND_VALUES[round][p.row - 1]).length;
  if (halved > full) {
    for (const c of clues) c.boundValue /= 2;
  }

  return clues;
}

function parseCheckpoints(section: string, round: Round): Checkpoint[] {
  const out: Checkpoint[] = [];
  const re = /<h3>([^<]*Scores[^<]*)<\/h3>([\s\S]*?)<\/table>/g;
  for (const m of section.matchAll(re)) {
    const label = decode(m[1]);
    const cells = [...m[2].matchAll(/class="score_(positive|negative)"[^>]*>([^<]*)<\/td>/g)];
    if (cells.length < 3) continue;
    const scores = cells.slice(0, 3).map(c => {
      const v = money(c[2]);
      return c[1] === 'negative' ? -Math.abs(v) : v;
    });
    const after = label.match(/after clue (\d+)/i);
    out.push({ label, scores, afterClue: after ? parseInt(after[1], 10) : null, round });
  }
  return out;
}

export function parseGame(html: string): ParsedGame {
  const gameIdMatch = html.match(/game_id=(\d+)/);
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);

  const jSection = roundSection(html, 'jeopardy_round');
  const djSection = roundSection(html, 'double_jeopardy_round');

  // Podium order comes from a score table's nickname header row — the same
  // nicknames the right/wrong cells use.
  const nickRow = html.match(
    /class="score_player_nickname"[^>]*>([^<]*)<\/td>\s*<td class="score_player_nickname"[^>]*>([^<]*)<\/td>\s*<td class="score_player_nickname"[^>]*>([^<]*)<\/td>/,
  );
  const players = nickRow ? [decode(nickRow[1]), decode(nickRow[2]), decode(nickRow[3])] : [];

  const fullNames = [...html.matchAll(/<p class="contestants"[^>]*>\s*<a[^>]*>([^<]*)<\/a>/g)]
    .map(m => decode(m[1]));

  const clues = [...parseRoundClues(jSection, 'J'), ...parseRoundClues(djSection, 'DJ')];
  const checkpoints = [
    ...parseCheckpoints(jSection, 'J'),
    ...parseCheckpoints(djSection, 'DJ'),
  ];

  return {
    gameId: gameIdMatch ? parseInt(gameIdMatch[1], 10) : null,
    title: titleMatch ? decode(titleMatch[1]) : '',
    players,
    fullNames,
    clues,
    checkpoints,
    fj: parseFinalJeopardy(html, players),
  };
}

function parseFinalJeopardy(html: string, players: string[]): ParsedGame['fj'] {
  const start = html.indexOf('id="final_jeopardy_round"');
  if (start < 0 || players.length === 0) return null;
  const section = html.slice(start);

  // Each responder is a `<td class="right|wrong">Name</td>` followed (in the
  // next row of the same nested table) by a bare `<td>$wager</td>`.
  const rows = [...section.matchAll(
    /class="(right|wrong)"[^>]*>([^<]*)<\/td>[\s\S]{0,400}?<tr><td>\$?([\d,]+)<\/td><\/tr>/g,
  )];
  if (rows.length === 0) return null;

  const wagers = new Array(players.length).fill(0);
  const correct = new Array(players.length).fill(false);
  let matched = 0;
  for (const r of rows) {
    const idx = players.indexOf(decode(r[2]));
    if (idx < 0) continue;
    correct[idx] = r[1] === 'right';
    wagers[idx] = money(r[3]);
    matched++;
  }

  // "Final scores:" table, in podium order.
  const finalScores = parseNamedScoreRow(section, 'Final scores') ?? new Array(players.length).fill(0);

  return matched > 0 ? { wagers, correct, finalScores } : null;
}

/** Pull the score row under an `<h3>` whose text contains `label`. */
function parseNamedScoreRow(html: string, label: string): number[] | null {
  const re = new RegExp(`<h3>[^<]*${label}[\\s\\S]{0,200}?<table>([\\s\\S]*?)<\\/table>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  const cells = [...m[1].matchAll(/class="score_(positive|negative)"[^>]*>([^<]*)<\/td>/g)];
  if (cells.length < 3) return null;
  return cells.slice(0, 3).map(c => (c[1] === 'negative' ? -Math.abs(money(c[2])) : money(c[2])));
}

/**
 * J-Archive publishes its own Coryat score and R/W counts per player. These
 * are authoritative — parsing them beats recomputing them, and they double as
 * a check on the clue-level parse (see `playerStats`, which compares).
 */
export function parsePublishedCoryat(
  html: string,
  players: string[],
): { coryat: number; correct: number; wrong: number; dds: number }[] | null {
  const idx = html.indexOf('Coryat score');
  if (idx < 0) return null;
  const section = html.slice(idx, idx + 3000);
  const scores = [...section.matchAll(/class="score_(positive|negative)"[^>]*>([^<]*)<\/td>/g)]
    .slice(0, 3)
    .map(c => (c[1] === 'negative' ? -Math.abs(money(c[2])) : money(c[2])));
  const remarks = [...section.matchAll(/class="score_remarks"[^>]*>([\s\S]*?)<\/td>/g)]
    .slice(0, 3)
    .map(r => decode(r[1]));
  if (scores.length < 3 || remarks.length < 3) return null;

  return players.map((_, i) => {
    const r = remarks[i] ?? '';
    const rc = r.match(/(\d+)\s*R/);
    const wc = r.match(/(\d+)\s*W/);
    const dd = r.match(/including (\d+) DD/);
    return {
      coryat: scores[i],
      correct: rc ? parseInt(rc[1], 10) : 0,
      wrong: wc ? parseInt(wc[1], 10) : 0,
      dds: dd ? parseInt(dd[1], 10) : 0,
    };
  });
}

// ─── Replay ──────────────────────────────────────────────────────────────

/**
 * Replay the game clue-by-clue to recover the scoreboard before and after
 * every clue, then check the result against J-Archive's published score
 * checkpoints. Unrevealed clues (no order number) are skipped for scoring but
 * still counted as "on the board" for `remainingValues`, because from the
 * players' point of view at the time those squares were live.
 */
export function replay(game: ParsedGame): Replay {
  const n = game.players.length;
  const idxOf = (nickname: string) => game.players.indexOf(nickname);
  const steps: ReplayStep[] = [];
  const endOfRound = {} as Record<Round, number[]>;
  const scores = new Array(n).fill(0);

  for (const round of ['J', 'DJ'] as Round[]) {
    const roundClues = game.clues.filter(c => c.round === round);
    const played = roundClues
      .filter(c => c.order !== null)
      .sort((a, b) => (a.order as number) - (b.order as number));

    for (const clue of played) {
      const before = [...scores];
      const value = clue.isDD ? (clue.wager ?? 0) : clue.boundValue;

      for (const w of clue.wrong) {
        const i = idxOf(w);
        if (i >= 0) scores[i] -= value;
      }
      if (clue.right) {
        const i = idxOf(clue.right);
        if (i >= 0) scores[i] += value;
      }
      const remaining = roundClues.filter(
        c => c.order === null || (c.order as number) > (clue.order as number),
      );
      steps.push({
        clue,
        before,
        after: [...scores],
        remainingValues: remaining.map(c => c.boundValue),
        remainingDDs: remaining.filter(c => c.isDD).length,
      });
    }
    endOfRound[round] = [...scores];
  }

  // Validate against J-Archive's own checkpoints.
  const mismatches: Replay['validation']['mismatches'] = [];
  let checked = 0;
  for (const cp of game.checkpoints) {
    let actual: number[] | null = null;
    if (cp.afterClue !== null) {
      const step = steps.find(
        s => s.clue.round === cp.round && s.clue.order === cp.afterClue,
      );
      actual = step ? step.after : null;
    } else if (/end of the/i.test(cp.label)) {
      actual = endOfRound[cp.round];
    }
    if (!actual) continue;
    checked++;
    if (actual.some((v, i) => v !== cp.scores[i])) {
      mismatches.push({ label: cp.label, expected: cp.scores, actual });
    }
  }

  return { steps, endOfRound, validation: { checked, mismatches } };
}

// ─── Per-player stats (for skill calibration) ────────────────────────────

export interface PlayerStats {
  name: string;
  correct: number;
  wrong: number;
  /** Coryat: end-of-DJ score ignoring wagering — DDs count at face value. */
  coryat: number;
  ddsFound: number;
}

/**
 * Per-player correct/wrong counts and Coryat score, the inputs
 * `calibrateOpponent` (app/src/sim/calibrate.ts) expects. Coryat follows the
 * standard convention: Daily Doubles score as the face value of the square
 * (right = +value, wrong = -value), and Final Jeopardy is excluded.
 */
export function playerStats(game: ParsedGame): PlayerStats[] {
  return game.players.map(name => {
    let correct = 0, wrong = 0, coryat = 0, ddsFound = 0;
    for (const clue of game.clues) {
      if (clue.order === null) continue;
      if (clue.right === name) {
        correct++;
        coryat += clue.boundValue;
        if (clue.isDD) ddsFound++;
      }
      if (clue.wrong.includes(name)) {
        wrong++;
        coryat -= clue.boundValue;
        if (clue.isDD) ddsFound++;
      }
    }
    return { name, correct, wrong, coryat, ddsFound };
  });
}

// ─── API response shape (shared between the Vercel route and GameAnalyzer) ─

export interface JArchiveContestantSummary {
  name: string;
  correct: number;
  wrong: number;
  coryat: number;
  finalScore: number;
}

export interface JArchiveDDEvent {
  round: Round;
  clueValue: number;
  /** Nickname of whoever hit this DD (right or wrong), or null if nobody
   *  responded on record. */
  who: string | null;
  /** The DD-taker's own score immediately before this clue. */
  scoreBefore: number | null;
  wager: number;
  correct: boolean;
  /** The DD-taker's own score immediately after this clue. */
  scoreAfter: number | null;
  /** All three contestants' scores before this DD, in `players` order —
   *  `equityWager` (app/src/sim/value-function.ts) needs the whole board,
   *  not just the DD-taker's own score. */
  allScoresBefore: [number, number, number];
  /** Clues left in this DD's round after it resolves — the shape
   *  `equityWager`'s `cluesRemainingAfter` expects. Note the V(S) table it
   *  queries only models Double-Jeopardy-and-later states (see
   *  value-function.ts), so a Jeopardy-round DD is an approximation here,
   *  same as the rest of the app's equity tooling. */
  cluesRemainingAfter: number;
}

export interface JArchiveGameResponse {
  gameId: number;
  title: string;
  /** Podium nicknames, left to right. */
  players: string[];
  fullNames: string[];
  validation: {
    checked: number;
    mismatches: { label: string; expected: number[]; actual: number[] }[];
  };
  contestants: JArchiveContestantSummary[];
  dailyDoubles: JArchiveDDEvent[];
  /** Clue-by-clue record for "Backtest this game" (app/src/sim/backtest.ts).
   *  Optional: older cached responses and test fixtures may omit it, in
   *  which case the backtest button is not offered. */
  record?: GameRecord;
}

// ─── Backtest record (app/src/sim/backtest.ts's input) ───────────────────

/**
 * One played clue, reduced to what a strategy backtest needs: who gained or
 * lost what, and what the board looked like afterwards. Names are dropped in
 * favour of podium indices so the sim side never has to know nicknames.
 */
export interface RecordStep {
  round: Round;
  /** Selection order within the round. */
  order: number;
  boundValue: number;
  isDD: boolean;
  /** Podium index of the Daily Double taker, or -1 for a regular clue (or a
   *  DD nobody responded to on record). */
  ddPlayer: number;
  /** DD wager as recorded, or null for a regular clue. */
  wager: number | null;
  /** Whether the DD taker was right (DD only; false otherwise). */
  ddCorrect: boolean;
  /** Score change per player, podium order. Sums the wrong-answer
   *  penalties and the correct-answer credit for this clue. */
  deltas: number[];
  /** Scores before this clue, podium order. */
  before: number[];
  /** Scores after this clue, podium order. */
  after: number[];
  /** Face values still unrevealed in this round after this clue resolves. */
  remainingValuesAfter: number[];
  /** Daily Doubles still unfound in this round after this clue resolves. */
  remainingDDsAfter: number;
}

export interface GameRecord {
  /** Podium nicknames, left to right. */
  players: string[];
  /** Number of clues actually revealed (both rounds). */
  cluesPlayed: number;
  /** Per-player box score — `playerStats` minus the name. */
  stats: { correct: number; wrong: number; coryat: number }[];
  /** Scores at the end of the Jeopardy round (start of Double Jeopardy). */
  endOfJ: number[];
  /** Scores at the end of Double Jeopardy (going into Final). */
  endOfDJ: number[];
  /** Every played clue in play order, J round first. */
  steps: RecordStep[];
}

/**
 * Build the compact clue-by-clue record a strategy backtest consumes from a
 * parsed game. Pure — the same function serves the CLI (`scripts/backtest.ts`)
 * and the Vercel route (which ships it to the browser in the API response).
 */
export function gameRecord(game: ParsedGame): GameRecord {
  const rep = replay(game);
  const stats = playerStats(game).map(s => ({ correct: s.correct, wrong: s.wrong, coryat: s.coryat }));
  const steps: RecordStep[] = rep.steps.map(s => {
    const who = s.clue.right ?? s.clue.wrong[0] ?? null;
    const ddPlayer = s.clue.isDD && who !== null ? game.players.indexOf(who) : -1;
    return {
      round: s.clue.round,
      order: s.clue.order as number,
      boundValue: s.clue.boundValue,
      isDD: s.clue.isDD,
      ddPlayer,
      wager: s.clue.isDD ? (s.clue.wager ?? 0) : null,
      ddCorrect: s.clue.isDD && s.clue.right !== null,
      deltas: s.after.map((v, i) => v - s.before[i]),
      before: [...s.before],
      after: [...s.after],
      remainingValuesAfter: [...s.remainingValues],
      remainingDDsAfter: s.remainingDDs,
    };
  });
  return {
    players: [...game.players],
    cluesPlayed: steps.length,
    stats,
    endOfJ: [...(rep.endOfRound.J ?? new Array(game.players.length).fill(0))],
    endOfDJ: [...(rep.endOfRound.DJ ?? new Array(game.players.length).fill(0))],
    steps,
  };
}
