/**
 * backtest.ts — "Backtest this game": given how everyone actually played a
 * real J-Archive game, how would YOUR chance of winning have changed under
 * different Daily Double wagering strategies?
 *
 * Pure module (no DOM, no fetch, no `self`): the worker message
 * `backtestGame` (sim-worker.ts) and the CLI (`scripts/backtest.ts`) both
 * call `backtestGame` below and only differ in how they ship the result.
 *
 * Inputs: a `GameRecord` (app/src/lib/jarchive.ts — every played clue with
 * the scoreboard before/after it and the board left afterwards) and the
 * podium seat of the contestant being analysed.
 *
 * What is computed:
 *
 * 1. **Calibration.** All three players are fitted from their own box score
 *    in this game, the way scripts/dd-advisor.ts does it: precision
 *    p = correct/(correct+wrong), raw attempt rate = attempts/clues played,
 *    then the app's `calibrateOpponent` sets b from the Coryat (b×p from
 *    the score, split by precision). Buzzer speed is each player's share of
 *    the clues won (the engine only uses buzzer speed as a relative weight
 *    between players who know the answer, so shares are rescaled with the
 *    fastest player at 1.0). Final Jeopardy accuracy follows the app's
 *    `playerFrom2Axis` convention, 0.3 + 0.4·p clamped to [0.2, 0.8] — a
 *    single FJ clue can't calibrate it.
 *
 * 2. **Per-DD rows.** For each Daily Double you hit, the game is resumed
 *    from the recorded scoreboard and board at that moment and rolled
 *    forward N times per arm (`simulateFromState`), once per wagering arm:
 *    actual wager / equity-optimal / all-in / the $5 minimum. The DD's
 *    outcome is NOT taken from the record: a wager is chosen before the
 *    clue is read, so every arm draws right/wrong from your calibrated
 *    precision (the same draw in every arm — see pairing below). Using the
 *    recorded outcome would make "all-in" trivially best whenever you
 *    happened to be right.
 *
 * 3. **Game-level summary.** Each strategy applied at EVERY Daily Double
 *    you hit, chained through the record: from your first DD, the arm's
 *    wager is placed, right/wrong is drawn, and the game then follows the
 *    record (everyone else's clues, and yours, exactly as they happened —
 *    your score just carries the counterfactual shift) up to your next DD,
 *    where the arm wagers again from the counterfactual scoreboard; after
 *    your last DD the rest of the game is rolled forward with the engine.
 *    When all your DDs are in Double Jeopardy this is your win chance from
 *    the start of DJ (the record is deterministic until the first DD).
 *
 * Pairing: every arm of a row (and of the summary) uses the same seed for
 * rollout i, so the DD outcome draw and the whole subsequent game are
 * identical across arms until the wager itself changes the state. Arm
 * differences are therefore far better resolved than the absolute levels;
 * `deltaSe` is the paired standard error of (arm − actual).
 *
 * Judgment calls (all surfaced in `notes`):
 *  - Opponents' DD wagers: past DDs are already baked into the recorded
 *    scoreboard (their actual wagers); DDs still unfound when the rollout
 *    resumes use the engine's 'aggressive' preset (75% of score), as do
 *    YOUR later, simulated DDs — so a per-DD row isolates the effect of
 *    that one wager.
 *  - Equity arm: Double-Jeopardy DDs use the app's V(S) table (the actual
 *    Optimal strategy) when one is supplied. Jeopardy-round DDs — the table
 *    only models DJ-and-later states — and any DD when no table is supplied
 *    fall back to a direct Monte Carlo wager search (`searchEquityWager`,
 *    common random numbers, a separate seed stream from the evaluation so
 *    the chosen wager isn't selected on the evaluation's own noise).
 *    Callers can ask for `equityFallback: 'skip'` instead.
 *  - You keep the board after your DD (real rule): rollouts use tracked
 *    board control with you as the controller.
 *  - DD accuracy is your flat calibrated precision (Tesauro's model), for
 *    both the counterfactual DD and simulated ones (`ddDifficultyScaling:
 *    false`).
 */

import {
  simulateFromState,
  mulberry32,
  DEFAULT_CONFIG,
  type Player,
  type SimConfig,
  type SimState,
} from './sim-engine';
import { equityWager, type ValueTable } from './value-function';
import { calibrateOpponent } from './calibrate';
import type { GameRecord, RecordStep, Round } from '../lib/jarchive';

// ─── Constants ───────────────────────────────────────────────────────────

/** Rollouts per arm (per DD row, and for the summary). */
export const BACKTEST_ROLLOUTS_PER_ARM = 1500;
export const BACKTEST_DEFAULT_SEED = 0xBAC7E57;
/** Real-rules Daily Double minimum. */
export const MIN_DD_WAGER = 5;
/** Rollouts per candidate score in the direct-rollout equity search. */
export const EQUITY_SEARCH_ROLLOUTS = 400;
/** Candidate wagers in the direct-rollout equity search (plus the max). */
export const EQUITY_SEARCH_POINTS = 12;

const ROUND_TOP_VALUE: Record<Round, number> = { J: 1000, DJ: 2000 };
const SEARCH_SALT = 0x5EA2C4;
const SUMMARY_SALT = 0x50AA;

export type BacktestArm = 'actual' | 'equity' | 'allIn' | 'minimum';
export const BACKTEST_ARMS: readonly BacktestArm[] = ['actual', 'equity', 'allIn', 'minimum'];

export const ARM_LABELS: Record<BacktestArm, string> = {
  actual: 'Your actual wager',
  equity: 'Equity-optimal',
  allIn: 'All-in',
  minimum: 'Minimum ($5)',
};

// ─── Types ───────────────────────────────────────────────────────────────

export interface ArmEstimate {
  /** The wager this arm placed (for the summary: at your first DD). */
  wager: number;
  /** P(you win) — ties split as half a win. */
  winRate: number;
  /** Plain Monte Carlo standard error of `winRate`. */
  se: number;
  /** winRate − the actual arm's winRate (same seeds). */
  deltaVsActual: number;
  /** Paired standard error of `deltaVsActual` (0 for the actual arm). */
  deltaSe: number;
}

export type EquitySource = 'table' | 'rollout' | 'skipped';

export interface BacktestRow {
  /** Index into `record.steps`. */
  stepIndex: number;
  round: Round;
  order: number;
  clueValue: number;
  /** Your score before the DD. */
  scoreBefore: number;
  /** All scores before the DD, podium order. */
  allScoresBefore: number[];
  cluesRemainingAfter: number;
  actualWager: number;
  actualCorrect: boolean;
  /** P(right) used for every arm's outcome draw. */
  pCorrect: number;
  arms: Record<BacktestArm, ArmEstimate | null>;
  equitySource: EquitySource;
}

export interface BacktestSummary {
  /** Where the chain starts, in words: "the start of Double Jeopardy" or
   *  "your first Daily Double (Jeopardy round)". */
  fromLabel: string;
  /** Number of your DDs the chain wagers at. */
  ddCount: number;
  arms: Record<BacktestArm, ArmEstimate | null>;
}

export interface CalibratedPlayer extends Player {
  name: string;
}

export interface BacktestResult {
  you: string;
  seat: number;
  players: CalibratedPlayer[];
  rolloutsPerArm: number;
  seed: number;
  rows: BacktestRow[];
  /** Null when you hit no Daily Double. */
  summary: BacktestSummary | null;
  /** Plain-language notes on the judgment calls that applied. */
  notes: string[];
}

export interface BacktestOptions {
  /** Podium index of "you". */
  seat: number;
  rolloutsPerArm?: number;
  seed?: number;
  /** The app's V(S) table, when built — used for the equity arm at DJ DDs. */
  valueTable?: ValueTable;
  /** What to do for the equity arm when the table can't be used. */
  equityFallback?: 'rollout' | 'skip';
  /** Override P(right) on your DDs (default: your calibrated precision). */
  pCorrect?: number;
  /** Engine config overrides on top of `backtestConfig()`. */
  config?: Partial<SimConfig>;
  onProgress?: (pct: number) => void;
  isCancelled?: () => boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Real-rules maximum: the greater of your score and the round's top value. */
export function maxLegalWager(score: number, round: Round): number {
  return Math.max(score, ROUND_TOP_VALUE[round]);
}

/** Rotate a podium-order tuple so `seat` sits at index 0 (the engine's
 *  "you" slot), keeping the other two in podium order. */
export function rotateToSeat<T>(arr: readonly T[], seat: number): [T, T, T] {
  const rest = arr.filter((_, i) => i !== seat);
  return [arr[seat], rest[0], rest[1]];
}

/** Win credit from a final scoreboard (index 0 = you), ties split. */
export function winCredit(scores: readonly number[]): number {
  const max = Math.max(...scores);
  if (scores[0] < max) return 0;
  return 1 / scores.filter(s => s === max).length;
}

/** Seed for rollout `i` of a stream with base `base` — golden-ratio stride
 *  keeps neighbouring rollouts far apart in mulberry32's state space. */
export function rolloutSeed(base: number, i: number): number {
  return (base + Math.imul(i, 0x9E3779B9)) >>> 0;
}

/** Base seed for the row of the DD at `stepIndex`. */
export function rowSeed(seed: number, stepIndex: number): number {
  return (seed ^ Math.imul(stepIndex + 1, 0x85EBCA6B)) >>> 0;
}

/** Base seed for the game-level summary chain. */
export function summarySeed(seed: number): number {
  return (seed ^ SUMMARY_SALT) >>> 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** The engine config the backtest rolls forward with (see header). */
export function backtestConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    ...DEFAULT_CONFIG,
    ddStrategy: 'aggressive',
    opponentDdStrategy: 'aggressive',
    includeFJ: true,
    boardControl: 'tracked',
    ddDifficultyScaling: false,
    fjStrategy: 'standard',
    ...overrides,
  };
}

// ─── Calibration ─────────────────────────────────────────────────────────

/**
 * Fit all three players from this game's box score (see header, item 1).
 * Podium order is preserved; rotate with `rotateToSeat` before simulating.
 */
export function calibratePlayers(record: GameRecord): CalibratedPlayer[] {
  const totalCorrect = record.stats.reduce((a, s) => a + s.correct, 0);
  const shares = record.stats.map(s => (totalCorrect > 0 ? s.correct / totalCorrect : 1 / 3));
  const maxShare = Math.max(...shares, 1e-9);
  const cluesPlayed = Math.max(record.cluesPlayed, 1);

  return record.stats.map((s, i) => {
    const attempts = s.correct + s.wrong;
    const k = attempts > 0 ? s.correct / attempts : 0.5;
    const bRaw = clamp(attempts / cluesPlayed, 0.05, 0.95);
    const cal = calibrateOpponent({ k, b: bRaw, fj: 0.5, c: s.coryat });
    const p = clamp(cal.p, 0.05, 0.98);
    return {
      name: record.players[i],
      b: clamp(cal.b, 0.05, 0.95),
      p,
      buzzerSpeed: clamp(shares[i] / maxShare, 0.05, 1),
      fjAccuracy: clamp(0.3 + p * 0.4, 0.2, 0.8),
    };
  });
}

// ─── Single rollouts ─────────────────────────────────────────────────────

/** A position to resume from, already rotated so index 0 is you. */
export interface ResumePosition {
  round: Round;
  scores: [number, number, number];
  remainingClueValues: number[];
  remainingDDCount: number;
}

/**
 * One rollout of one arm from a Daily Double: draw right/wrong from
 * `pCorrect` (the FIRST rng draw, so every arm shares it), apply the wager,
 * then play the rest of the game. Returns the win credit.
 */
export function rolloutFromDD(
  pos: ResumePosition,
  wager: number,
  pCorrect: number,
  players: Player[],
  config: SimConfig,
  rng: () => number,
): number {
  const correct = rng() < pCorrect;
  const scores: [number, number, number] = [...pos.scores];
  scores[0] += correct ? wager : -wager;
  const state: SimState = {
    scores,
    round: pos.round,
    remainingClueValues: [...pos.remainingClueValues],
    remainingDDCount: pos.remainingDDCount,
    controller: 0,
  };
  return winCredit(simulateFromState(state, players, config, rng).scores);
}

/** P(win) from a resolved scoreboard, no wager pending. */
function rolloutFromScores(
  pos: ResumePosition,
  players: Player[],
  config: SimConfig,
  rng: () => number,
): number {
  const state: SimState = {
    scores: [...pos.scores],
    round: pos.round,
    remainingClueValues: [...pos.remainingClueValues],
    remainingDDCount: pos.remainingDDCount,
    controller: 0,
  };
  return winCredit(simulateFromState(state, players, config, rng).scores);
}

function positionOf(step: RecordStep, scoresPodium: readonly number[], seat: number): ResumePosition {
  return {
    round: step.round,
    scores: rotateToSeat(scoresPodium, seat),
    remainingClueValues: step.remainingValuesAfter,
    remainingDDCount: step.remainingDDsAfter,
  };
}

// ─── Equity wager search (direct rollout) ────────────────────────────────

/**
 * Equity-optimal wager by direct Monte Carlo: V(score) is estimated once per
 * candidate post-DD score with common random numbers, then
 * Equity(w) = p·V(S+w) + (1−p)·V(S−w) is maximised over a wager grid from
 * $5 to the legal maximum. Used where the V(S) table can't be (see header).
 */
export function searchEquityWager(
  pos: ResumePosition,
  pCorrect: number,
  players: Player[],
  config: SimConfig,
  seed: number,
  rollouts = EQUITY_SEARCH_ROLLOUTS,
  points = EQUITY_SEARCH_POINTS,
  hooks: { onRollouts?: (n: number) => void; isCancelled?: () => boolean } = {},
): { wager: number; equity: number } | null {
  const score = pos.scores[0];
  const maxW = maxLegalWager(score, pos.round);
  const wagers = new Set<number>([MIN_DD_WAGER, maxW]);
  for (let i = 1; i < points; i++) {
    wagers.add(Math.round((MIN_DD_WAGER + ((maxW - MIN_DD_WAGER) * i) / points) / 100) * 100);
  }
  const scoreSet = new Set<number>();
  for (const w of wagers) {
    scoreSet.add(score + w);
    scoreSet.add(score - w);
  }

  const v = new Map<number, number>();
  for (const s of scoreSet) {
    if (hooks.isCancelled?.()) return null;
    let wins = 0;
    for (let i = 0; i < rollouts; i++) {
      const rng = mulberry32(rolloutSeed(seed, i));
      wins += rolloutFromScores({ ...pos, scores: [s, pos.scores[1], pos.scores[2]] }, players, config, rng);
    }
    v.set(s, wins / rollouts);
    hooks.onRollouts?.(rollouts);
  }

  let best = { wager: MIN_DD_WAGER, equity: -Infinity };
  for (const w of [...wagers].sort((a, b) => a - b)) {
    const eq = pCorrect * (v.get(score + w) as number) + (1 - pCorrect) * (v.get(score - w) as number);
    if (eq > best.equity) best = { wager: w, equity: eq };
  }
  return best;
}

/** How many rollouts `searchEquityWager` will run for a position. */
export function equitySearchCost(
  pos: ResumePosition,
  rollouts = EQUITY_SEARCH_ROLLOUTS,
  points = EQUITY_SEARCH_POINTS,
): number {
  const score = pos.scores[0];
  const maxW = maxLegalWager(score, pos.round);
  const wagers = new Set<number>([MIN_DD_WAGER, maxW]);
  for (let i = 1; i < points; i++) {
    wagers.add(Math.round((MIN_DD_WAGER + ((maxW - MIN_DD_WAGER) * i) / points) / 100) * 100);
  }
  const scoreSet = new Set<number>();
  for (const w of wagers) {
    scoreSet.add(score + w);
    scoreSet.add(score - w);
  }
  return scoreSet.size * rollouts;
}

// ─── Estimates ───────────────────────────────────────────────────────────

function estimate(wager: number, wins: Float32Array, actualWins: Float32Array): ArmEstimate {
  const n = wins.length;
  let sum = 0;
  let dSum = 0;
  let dSq = 0;
  for (let i = 0; i < n; i++) {
    sum += wins[i];
    const d = wins[i] - actualWins[i];
    dSum += d;
    dSq += d * d;
  }
  const winRate = sum / n;
  const dMean = dSum / n;
  const dVar = n > 1 ? Math.max(0, (dSq - n * dMean * dMean) / (n - 1)) : 0;
  return {
    wager,
    winRate,
    se: Math.sqrt(Math.max(winRate * (1 - winRate), 0) / n),
    deltaVsActual: dMean,
    deltaSe: Math.sqrt(dVar / n),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────

/**
 * Run the backtest. Returns `null` if `isCancelled()` turned true. Throws
 * on a malformed record (wrong player count, seat out of range).
 */
export function backtestGame(record: GameRecord, opts: BacktestOptions): BacktestResult | null {
  const { seat } = opts;
  if (record.players.length !== 3) throw new Error('Backtest needs a 3-player game');
  if (seat < 0 || seat > 2) throw new Error(`seat must be 0..2, got ${seat}`);

  const n = opts.rolloutsPerArm ?? BACKTEST_ROLLOUTS_PER_ARM;
  const seed = (opts.seed ?? BACKTEST_DEFAULT_SEED) >>> 0;
  const equityFallback = opts.equityFallback ?? 'rollout';
  const config = backtestConfig(opts.config);
  const calibrated = calibratePlayers(record);
  const players = rotateToSeat(calibrated, seat);
  const you = players[0];
  const pCorrect = opts.pCorrect ?? you.p;
  const notes: string[] = [];

  const yourDDs = record.steps
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => step.isDD && step.ddPlayer === seat);

  const base: Omit<BacktestResult, 'rows' | 'summary'> = {
    you: record.players[seat],
    seat,
    players: calibrated,
    rolloutsPerArm: n,
    seed,
    notes,
  };

  if (yourDDs.length === 0) {
    return { ...base, rows: [], summary: null };
  }

  const canUseTable = (round: Round) => round === 'DJ' && opts.valueTable !== undefined;
  const equityYou = { knowledge: you.b * you.p, buzzerSpeed: you.buzzerSpeed };

  // ── Progress accounting ──
  const searchNeeded = (round: Round) => !canUseTable(round) && equityFallback === 'rollout';
  let plannedRollouts = 0;
  for (const { step } of yourDDs) {
    plannedRollouts += n * BACKTEST_ARMS.length;
    if (searchNeeded(step.round)) {
      plannedRollouts += equitySearchCost(positionOf(step, step.before, seat));
    }
  }
  // Summary: 4 arms × n, plus equity searches at counterfactual states
  // (one per distinct right/wrong history: 2^k states at your (k+1)-th DD).
  plannedRollouts += n * BACKTEST_ARMS.length;
  yourDDs.forEach(({ step }, k) => {
    if (searchNeeded(step.round)) {
      plannedRollouts += (1 << k) * equitySearchCost(positionOf(step, step.before, seat));
    }
  });
  let doneRollouts = 0;
  let lastPct = -1;
  const advance = (count: number) => {
    doneRollouts += count;
    const pct = Math.min(1, doneRollouts / plannedRollouts);
    if (pct - lastPct >= 0.02 || pct === 1) {
      lastPct = pct;
      opts.onProgress?.(pct);
    }
  };
  const cancelled = () => opts.isCancelled?.() === true;

  // ── Equity wager at a (possibly counterfactual) position ──
  const equityAt = (
    step: RecordStep,
    pos: ResumePosition,
    searchSeed: number,
  ): { wager: number; source: EquitySource } | null => {
    if (canUseTable(step.round)) {
      const cluesRemainingAfter = step.remainingValuesAfter.length;
      const w = equityWager(equityYou, pos.scores, cluesRemainingAfter, pCorrect, opts.valueTable as ValueTable);
      return { wager: w, source: 'table' };
    }
    if (equityFallback === 'skip') return { wager: NaN, source: 'skipped' };
    const found = searchEquityWager(pos, pCorrect, players, config, searchSeed, EQUITY_SEARCH_ROLLOUTS, EQUITY_SEARCH_POINTS, {
      onRollouts: advance,
      isCancelled: cancelled,
    });
    if (found === null) return null;
    return { wager: found.wager, source: 'rollout' };
  };

  const armWager = (
    arm: BacktestArm,
    step: RecordStep,
    pos: ResumePosition,
    equity: { wager: number; source: EquitySource },
  ): number | null => {
    switch (arm) {
      case 'actual': return step.wager ?? 0;
      case 'equity': return equity.source === 'skipped' ? null : equity.wager;
      case 'allIn': return maxLegalWager(pos.scores[0], step.round);
      case 'minimum': return MIN_DD_WAGER;
    }
  };

  // ── Per-DD rows ──
  const rows: BacktestRow[] = [];
  let usedTable = false;
  let usedRollout = false;
  let skippedEquity = false;

  for (const { step, i } of yourDDs) {
    if (cancelled()) return null;
    const pos = positionOf(step, step.before, seat);
    const rSeed = rowSeed(seed, i);
    const equity = equityAt(step, pos, (rSeed ^ SEARCH_SALT) >>> 0);
    if (equity === null) return null;
    if (equity.source === 'table') usedTable = true;
    if (equity.source === 'rollout') usedRollout = true;
    if (equity.source === 'skipped') skippedEquity = true;

    const winsByArm: Partial<Record<BacktestArm, Float32Array>> = {};
    const wagerByArm: Partial<Record<BacktestArm, number>> = {};
    for (const arm of BACKTEST_ARMS) {
      const w = armWager(arm, step, pos, equity);
      if (w === null) continue;
      const wins = new Float32Array(n);
      for (let g = 0; g < n; g++) {
        if ((g & 127) === 0 && cancelled()) return null;
        wins[g] = rolloutFromDD(pos, w, pCorrect, players, config, mulberry32(rolloutSeed(rSeed, g)));
      }
      winsByArm[arm] = wins;
      wagerByArm[arm] = w;
      advance(n);
    }

    const actualWins = winsByArm.actual as Float32Array;
    const arms = {} as Record<BacktestArm, ArmEstimate | null>;
    for (const arm of BACKTEST_ARMS) {
      const wins = winsByArm[arm];
      arms[arm] = wins ? estimate(wagerByArm[arm] as number, wins, actualWins) : null;
    }

    rows.push({
      stepIndex: i,
      round: step.round,
      order: step.order,
      clueValue: step.boundValue,
      scoreBefore: step.before[seat],
      allScoresBefore: [...step.before],
      cluesRemainingAfter: step.remainingValuesAfter.length,
      actualWager: step.wager ?? 0,
      actualCorrect: step.ddCorrect,
      pCorrect,
      arms,
      equitySource: equity.source,
    });
  }

  // ── Game-level summary: each arm applied at every DD you hit ──
  const sSeed = summarySeed(seed);
  const last = yourDDs[yourDDs.length - 1].step;
  // Equity wagers at counterfactual states, keyed by (dd index, outcome
  // history) so the rollout search runs once per distinct state.
  const equityCache = new Map<string, { wager: number; source: EquitySource }>();
  const equityFor = (k: number, history: number, pos: ResumePosition): { wager: number; source: EquitySource } | null => {
    const key = `${k}:${history}`;
    const hit = equityCache.get(key);
    if (hit) return hit;
    const step = yourDDs[k].step;
    const found = equityAt(step, pos, (sSeed ^ SEARCH_SALT ^ Math.imul(k * 64 + history + 1, 0x27D4EB2F)) >>> 0);
    if (found === null) return null;
    equityCache.set(key, found);
    return found;
  };

  const summaryWins: Partial<Record<BacktestArm, Float32Array>> = {};
  const summaryFirstWager: Partial<Record<BacktestArm, number>> = {};
  for (const arm of BACKTEST_ARMS) {
    if (arm === 'equity' && equityFallback === 'skip' && yourDDs.some(({ step }) => !canUseTable(step.round))) {
      continue;
    }
    const wins = new Float32Array(n);
    let firstWager: number | null = null;
    for (let g = 0; g < n; g++) {
      if ((g & 127) === 0 && cancelled()) return null;
      const rng = mulberry32(rolloutSeed(sSeed, g));
      let shift = 0;
      let history = 0;
      for (let k = 0; k < yourDDs.length; k++) {
        const step = yourDDs[k].step;
        const before = [...step.before];
        before[seat] += shift;
        const pos = positionOf(step, before, seat);
        let w: number;
        if (arm === 'equity') {
          const eq = equityFor(k, history, pos);
          if (eq === null) return null;
          w = eq.wager;
        } else {
          w = armWager(arm, step, pos, { wager: NaN, source: 'skipped' }) as number;
        }
        if (k === 0 && firstWager === null) firstWager = w;
        const correct = rng() < pCorrect;
        const yourAfter = before[seat] + (correct ? w : -w);
        shift = yourAfter - step.after[seat];
        history = history * 2 + (correct ? 1 : 0);
      }
      const finalScores = [...last.after];
      finalScores[seat] += shift;
      wins[g] = rolloutFromScores(positionOf(last, finalScores, seat), players, config, rng);
    }
    summaryWins[arm] = wins;
    summaryFirstWager[arm] = firstWager ?? 0;
    advance(n);
  }

  const summaryActual = summaryWins.actual as Float32Array;
  const summaryArms = {} as Record<BacktestArm, ArmEstimate | null>;
  for (const arm of BACKTEST_ARMS) {
    const wins = summaryWins[arm];
    summaryArms[arm] = wins ? estimate(summaryFirstWager[arm] as number, wins, summaryActual) : null;
  }
  const allDJ = yourDDs.every(({ step }) => step.round === 'DJ');
  const summary: BacktestSummary = {
    fromLabel: allDJ ? 'the start of Double Jeopardy' : 'your first Daily Double (Jeopardy round)',
    ddCount: yourDDs.length,
    arms: summaryArms,
  };

  // ── Notes ──
  notes.push(
    `Right/wrong on each Daily Double is drawn from ${record.players[seat]}'s calibrated precision ` +
    `(${Math.round(pCorrect * 100)}%), not taken from the record — a wager is chosen before the clue is read.`,
  );
  notes.push(
    "Opponents' Daily Doubles before each resume point use their actual recorded wagers (already in the scoreboard); " +
    'Daily Doubles still unfound when play resumes, yours included, use the aggressive preset (75% of score).',
  );
  if (usedTable) notes.push("Double Jeopardy equity wagers come from the app's Optimal (equity) value table.");
  if (usedRollout) {
    notes.push(
      opts.valueTable
        ? 'Jeopardy-round equity wagers come from a direct Monte Carlo wager search (the value table only models Double Jeopardy).'
        : 'No value table was supplied, so equity wagers come from a direct Monte Carlo wager search.',
    );
  }
  if (skippedEquity) notes.push('The equity arm was skipped where no value table applies.');
  notes.push('Final Jeopardy uses the app\'s standard wagering for everyone, with accuracy set from each player\'s precision (0.3 + 0.4·p).');

  opts.onProgress?.(1);
  return { ...base, rows, summary };
}

// ─── Plain-language formatting (shared by the UI and the CLI) ────────────

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The one-line headline: "With equity wagering at your Daily Doubles, your
 * chance of winning this game goes from 38% to 44% (± 2)."
 */
export function backtestHeadline(result: BacktestResult): string {
  if (!result.summary) return `${result.you} did not hit a Daily Double in this game.`;
  const actual = result.summary.arms.actual;
  const equity = result.summary.arms.equity;
  if (!actual) return 'The backtest produced no baseline.';
  if (!equity) {
    return `Your chance of winning this game, from ${result.summary.fromLabel}, was ${pct(actual.winRate)} ` +
      `(± ${Math.round(actual.se * 100)}) with your actual wagers. The equity arm was skipped: build the Optimal (equity) strategy first.`;
  }
  const pm = Math.max(1, Math.round(equity.deltaSe * 100));
  const plural = result.summary.ddCount === 1 ? 'Daily Double' : 'Daily Doubles';
  return `With equity wagering at your ${plural}, your chance of winning this game goes from ` +
    `${pct(actual.winRate)} to ${pct(equity.winRate)} (± ${pm}).`;
}
