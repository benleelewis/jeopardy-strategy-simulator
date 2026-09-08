/**
 * dd-advisor.ts — "what should that Daily Double wager have been?"
 *
 * Pulls a real position off J-Archive (or takes one on the command line),
 * calibrates all three players from what they actually did in that game, and
 * sweeps the whole wager range by direct Monte Carlo.
 *
 * Usage:
 *   npx tsx scripts/dd-advisor.ts --game 9501 --dd 3
 *   npx tsx scripts/dd-advisor.ts --game 9501 --dd DJ:23 --sims 20000
 *   npx tsx scripts/dd-advisor.ts --game 9501 --list
 *   npx tsx scripts/dd-advisor.ts --scores 19200,7800,7000 --round DJ \
 *       --clues-left 7 --dds-left 0 --p 0.86
 *
 * Options:
 *   --game <id>        J-Archive game_id (cached in data/jarchive-cache/)
 *   --dd <n|R:order>   Which DD: 1-based index in play order, or "DJ:23"
 *   --list             List the game's Daily Doubles with reconstructed scores
 *   --p <0..1>         P(the wagering player nails this clue). Default: their
 *                      calibrated precision from that game
 *   --sims <n>         Rollouts per grid score (default 6000)
 *   --step <$>         Wager grid step (default 200)
 *   --seed <n>         RNG base seed (default 12345)
 *   --opponents <k>    auto (default) | average | champion | grandChampion
 *   --scores a,b,c     Manual position; first entry is the wagering player
 *   --round J|DJ       Manual position round (default DJ)
 *   --clues-left <n>   Manual: clues left in the round after this DD
 *   --dds-left <n>     Manual: DDs left in the round after this DD
 */

import {
  fetchGameHtml, parseGame, replay, playerStats,
  type ParsedGame, type ReplayStep,
} from './lib/jarchive';
import { analyzeDD, optimalByPCorrect, lockBounds, type DDPosition } from './lib/dd-equity';
import { calibrateOpponent } from '../app/src/sim/calibrate';
import { OPPONENT_PROFILES } from '../app/src/sim/opponent-models';
import { DJ_VALUES, type Player, type SimConfig } from '../app/src/sim/sim-engine';

// ─── Args ────────────────────────────────────────────────────────────────

function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

const A = args();
const num = (k: string, d: number) => (A[k] === undefined ? d : Number(A[k]));

// ─── Formatting ──────────────────────────────────────────────────────────

const usd = (n: number) => (n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// ─── Player calibration ──────────────────────────────────────────────────

/**
 * Turn one game's box score into sim `Player`s via the app's own
 * `calibrateOpponent` (Coryat sets the b×p product; correct/wrong sets the
 * split). Final Jeopardy accuracy can't be estimated from a single FJ clue,
 * so it follows `playerFrom2Axis`'s convention of tracking precision.
 *
 * Caveat worth stating out loud: the Coryat used here is the FULL game's,
 * including clues played after the Daily Double being analyzed. That is
 * hindsight — it makes the players slightly better-known than they were at
 * the moment of the wager. It is the right call anyway, because the question
 * asked is "what was the best wager given who these players actually were,"
 * not "given what was knowable at the time."
 */
function calibrateFromGame(game: ParsedGame): Player[] {
  return playerStats(game).map(s => {
    const attempts = s.correct + s.wrong;
    const cal = calibrateOpponent({
      k: s.correct / (attempts + 1),
      b: attempts / 60,
      fj: 0.5,
      c: s.coryat,
    });
    return {
      b: cal.b,
      p: cal.p,
      buzzerSpeed: cal.b,
      fjAccuracy: Math.max(0.2, Math.min(0.8, 0.3 + cal.p * 0.4)),
    };
  });
}

function profilePlayer(key: string): Player {
  const prof = OPPONENT_PROFILES[key];
  if (!prof) throw new Error(`Unknown opponent profile "${key}"`);
  return { b: prof.b, p: prof.p, buzzerSpeed: prof.b, fjAccuracy: prof.fjAccuracy };
}

// ─── Position selection ──────────────────────────────────────────────────

function pickDD(steps: ReplayStep[], spec: string): ReplayStep {
  const dds = steps.filter(s => s.clue.isDD);
  const rc = spec.match(/^(J|DJ):(\d+)$/i);
  if (rc) {
    const found = dds.find(
      s => s.clue.round === rc[1].toUpperCase() && s.clue.order === parseInt(rc[2], 10),
    );
    if (!found) throw new Error(`No Daily Double at ${spec}`);
    return found;
  }
  const idx = parseInt(spec, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > dds.length) {
    throw new Error(`--dd must be 1..${dds.length} or "ROUND:order"`);
  }
  return dds[idx - 1];
}

/** Rotate a 3-player position so `seat` sits at index 0. */
function rotate<T>(arr: T[], seat: number): [T, T, T] {
  const rest = arr.filter((_, i) => i !== seat);
  return [arr[seat], rest[0], rest[1]];
}

// ─── Report ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config: SimConfig = {
    ddStrategy: 'aggressive',
    opponentDdStrategy: 'aggressive',
    includeFJ: true,
    rhoB: 0.2,
    rhoP: 0.2,
    boardControl: 'score-weighted',
    fjStrategy: 'standard',
    fjSecondPlaceStrategy: 'twoThirdsRule',
  };

  let pos: DDPosition;
  let label = 'manual position';
  let actualWager: number | null = null;
  let pDefault = 0.75;
  let names = ['You', 'Opp A', 'Opp B'];

  if (A.game) {
    const html = await fetchGameHtml(Number(A.game));
    const game = parseGame(html);
    const rep = replay(game);

    console.log(`\n${game.title}`);
    console.log(`Contestants: ${game.players.join(', ')}`);
    if (rep.validation.mismatches.length > 0) {
      console.log('\n!! Score reconstruction disagrees with J-Archive checkpoints:');
      for (const m of rep.validation.mismatches) {
        console.log(`   ${m.label} expected ${m.expected} got ${m.actual}`);
      }
      console.log('   Results below are NOT trustworthy — fix the parser first.\n');
    } else {
      console.log(`Score reconstruction verified against ${rep.validation.checked} J-Archive checkpoints.`);
    }

    const dds = rep.steps.filter(s => s.clue.isDD);
    if (A.list || !A.dd) {
      console.log('\nDaily Doubles:');
      dds.forEach((s, i) => {
        const who = s.clue.right ?? s.clue.wrong[0] ?? '?';
        const seat = game.players.indexOf(who);
        const board = game.players.map((n, j) => `${n} ${usd(s.before[j])}`).join(' | ');
        console.log(
          `  ${i + 1}. ${s.clue.round} clue ${s.clue.order}  "${s.clue.category}" (${usd(s.clue.boundValue)} square)\n` +
          `     ${who} bet ${usd(s.clue.wager ?? 0)} and was ${s.clue.right ? 'RIGHT' : 'WRONG'}\n` +
          `     before: ${board}   [${s.remainingValues.length} clues + ${s.remainingDDs} DD left in round]\n` +
          `     analyze with: --dd ${i + 1}   (seat ${seat})`,
        );
      });
      if (!A.dd) { console.log('\nPass --dd <n> to analyze one.\n'); return; }
    }

    const step = pickDD(rep.steps, String(A.dd));
    const who = step.clue.right ?? step.clue.wrong[0];
    const seat = game.players.indexOf(who);
    if (seat < 0) throw new Error(`Could not identify the DD player for --dd ${A.dd}`);

    const calibrated = calibrateFromGame(game);
    const players = A.opponents && A.opponents !== 'auto'
      ? ([calibrated[seat], profilePlayer(String(A.opponents)), profilePlayer(String(A.opponents))] as [Player, Player, Player])
      : rotate(calibrated, seat);

    pos = {
      scores: rotate(step.before, seat).map(Math.round) as [number, number, number],
      players,
      round: step.clue.round,
      remainingClueValues: step.remainingValues,
      remainingDDCount: step.remainingDDs,
    };
    names = rotate(game.players, seat);
    actualWager = step.clue.wager;
    pDefault = calibrated[seat].p;
    label = `${who}, ${step.clue.round} clue ${step.clue.order} — "${step.clue.category}" (${usd(step.clue.boundValue)} square)`;
  } else {
    if (!A.scores) throw new Error('Pass --game <id> or --scores a,b,c (see header for usage)');
    const scores = String(A.scores).split(',').map(Number) as [number, number, number];
    const round = (String(A.round ?? 'DJ').toUpperCase() as 'J' | 'DJ');
    const cluesLeft = num('clues-left', 7);
    const key = A.opponents && A.opponents !== 'auto' ? String(A.opponents) : 'average';
    const me = profilePlayer(key);
    pos = {
      scores,
      players: [me, profilePlayer(key), profilePlayer(key)],
      round,
      // Without a real board, assume the remaining clues are a representative
      // mix of the round's values rather than picking a convenient subset.
      remainingClueValues: Array.from(
        { length: cluesLeft },
        (_, i) => DJ_VALUES[i % DJ_VALUES.length],
      ),
      remainingDDCount: num('dds-left', 0),
    };
    pDefault = me.p;
  }

  const pCorrect = A.p !== undefined ? Number(A.p) : pDefault;
  const sims = num('sims', 6000);
  const step$ = num('step', 200);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`DAILY DOUBLE — ${label}`);
  console.log('='.repeat(72));
  console.log(`Position:  ${names.map((n, i) => `${n} ${usd(pos.scores[i])}`).join('   ')}`);
  console.log(`Board:     ${pos.remainingClueValues.length} clues left in ${pos.round} ` +
    `(${usd(pos.remainingClueValues.reduce((a, b) => a + b, 0))} still available), ` +
    `${pos.remainingDDCount} DD left`);
  console.log(`Players:   ${names.map((n, i) =>
    `${n} b=${pos.players[i].b.toFixed(2)} p=${pos.players[i].p.toFixed(2)}`).join('  |  ')}`);
  console.log(`Assumed P(correct on this DD) = ${pct(pCorrect)}`);
  console.log(`Monte Carlo: ${sims.toLocaleString()} rollouts per grid score, $${step$} wager grid`);

  const bounds = lockBounds(pos);
  console.log(`\nLOCK ALGEBRA (no simulation — worst case for you):`);
  console.log(`  Best any one opponent can still reach this round: ${usd(bounds.opponentCeiling)}` +
    `${bounds.ceilingExact ? '' : ' (upper bound — DDs still unfound)'}`);
  if (bounds.alreadyLocked) {
    console.log(`  You are ALREADY locked — a $0 wager wins the game outright.`);
  } else if (bounds.lockIfRight !== null) {
    console.log(`  Smallest wager that makes the game unloseable if you are RIGHT: ${usd(bounds.lockIfRight)}`);
  } else {
    console.log(`  No wager can guarantee a lock from here.`);
  }
  console.log(bounds.lockIfWrong !== null
    ? `  Largest wager that stays unloseable even if you are WRONG: ${usd(bounds.lockIfWrong)}`
    : `  Any wager reopens the game if you are wrong.`);
  console.log();

  const t0 = Date.now();
  const analysis = analyzeDD(pos, { sims, step: step$, pCorrect, config, seed: num('seed', 12345) });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const byWager = new Map(analysis.curve.map(c => [c.wager, c]));
  const at = (w: number) => byWager.get(w) ?? analysis.curve.reduce(
    (a, b) => (Math.abs(b.wager - w) < Math.abs(a.wager - w) ? b : a));

  console.log(`Win probability if the DD had never been found: ${pct(analysis.vBase)}`);
  console.log(`\n  wager      P(win)   if right   if wrong   lock after DJ (if right)`);
  console.log(`  ${'-'.repeat(64)}`);
  const showEvery = Math.max(1, Math.round(analysis.curve.length / 20));
  const shown = new Set<number>();
  for (let i = 0; i < analysis.curve.length; i++) {
    if (i % showEvery !== 0 && i !== analysis.curve.length - 1) continue;
    shown.add(analysis.curve[i].wager);
  }
  shown.add(analysis.best.wager);
  if (actualWager !== null) shown.add(at(actualWager).wager);
  for (const w of [...shown].sort((a, b) => a - b)) {
    const c = at(w);
    const marks = [
      c.wager === analysis.best.wager ? ' <- optimal' : '',
      actualWager !== null && c.wager === at(actualWager).wager ? ' <- actual bet' : '',
    ].join('');
    console.log(
      `  ${usd(c.wager).padEnd(9)} ${pct(c.equity).padStart(6)}   ` +
      `${pct(c.vWin).padStart(6)}    ${pct(c.vLose).padStart(6)}     ` +
      `${pct(c.pLockIfWin).padStart(6)}${marks}`,
    );
  }

  console.log(`\nOPTIMAL WAGER: ${usd(analysis.best.wager)}  →  ${pct(analysis.best.equity)} win probability`);
  console.log(`Statistically tied (within ${(analysis.plateau.tolerance * 100).toFixed(1)}pp): ` +
    `${usd(analysis.plateau.min)} – ${usd(analysis.plateau.max)}`);
  if (actualWager !== null) {
    const actual = at(actualWager);
    const gap = analysis.best.equity - actual.equity;
    console.log(`ACTUAL WAGER:  ${usd(actualWager)}  →  ${pct(actual.equity)} ` +
      `(${gap <= 0 ? 'optimal' : `${(gap * 100).toFixed(2)}pp below the best available`})`);
  }
  const se = analysis.grid[0].se;
  console.log(`Monte Carlo standard error on each P(win): ~${(se * 100).toFixed(2)}pp ` +
    `(common random numbers make wager-to-wager DIFFERENCES sharper than this).`);

  console.log(`\nOptimal wager vs. how sure you are of the clue:`);
  const sweep = optimalByPCorrect(analysis, [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
  for (const s of sweep) {
    console.log(`  P(correct)=${pct(s.p).padStart(6)}  ->  bet ${usd(s.wager).padEnd(9)} (${pct(s.equity)})`);
  }
  console.log(`\nDone in ${elapsed}s.\n`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
