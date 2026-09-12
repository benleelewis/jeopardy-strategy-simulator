/**
 * Jeopardy Strategy Simulator — Core Simulation Engine
 *
 * Pure functions, zero deps, designed to run in a Web Worker.
 *
 * Model (from Tesauro 2012 + Ben's DD paper):
 *   - Each player has (b, p) where b = buzz attempt rate, p = precision
 *   - Correlated buzz attempts (ρ_b = 0.2) and accuracy (ρ_p = 0.2)
 *   - Difficulty scaling by clue value
 *   - Wrong answer penalties (lose points + rebound chance)
 *   - Daily Doubles (1 in J, 2 in DJ, bottom-row bias)
 *   - Final Jeopardy (score-position wagering, correlated accuracy)
 *   - Board control (opt-in `'tracked'`: real rules for who picks the next
 *     square and who therefore hits a Daily Double)
 *
 * Randomness: every stochastic function takes an optional `rng: () => number`
 * (a drop-in replacement for Math.random, e.g. `mulberry32(seed)` below).
 * Omitting it preserves the original Math.random behavior exactly — this
 * threading is additive-only, never a behavior change for existing callers.
 *
 * E-3 note: `simulateRound`'s DD branch imports `equityWager` from
 * `./value-function`, which itself imports `simulateFromState` etc. back
 * from this file (value-function.ts rolls out games through this engine to
 * build V(S)). This is a deliberate circular ES module import — safe here
 * because both sides only reference the other's exports from inside
 * function bodies (never at module-evaluation time), which is the standard
 * safe pattern for circular imports. Kept minimal on purpose: this file
 * imports exactly one function (`equityWager`) plus one type (`ValueTable`,
 * `import type` — erased at compile time, zero runtime footprint).
 */

import { equityWager, type ValueTable } from './value-function';

// ─── Types ───────────────────────────────────────────────────────────

export interface Player {
  b: number;       // buzz attempt rate [0,1]
  p: number;       // precision (accuracy given buzz) [0,1]
  buzzerSpeed: number; // relative buzzer speed [0,1] — wins contested buzzes
  fjAccuracy: number;  // Final Jeopardy accuracy [0,1]
}

export type DDStrategy = 'off' | 'conservative' | 'aggressive' | 'truedd' | 'equity';

/**
 * `DDStrategy` minus `'equity'` — `ddWager`'s parameter type (E-3). Typing
 * `ddWager` to exclude `'equity'` (rather than adding an `'equity'` case
 * that would just re-throw) means the compiler itself enforces "equity
 * dispatch happens BEFORE `ddWager`": a caller holding a plain `DDStrategy`
 * cannot pass it to `ddWager` without first narrowing away `'equity'` (e.g.
 * `strategy === 'equity' ? ... : ddWager(strategy, ...)`, where the `else`
 * branch narrows automatically). See `simulateRound`'s DD branch.
 */
export type NonEquityDDStrategy = Exclude<DDStrategy, 'equity'>;

/**
 * Who controls the board when a Daily Double is hit.
 * - 'leader' (default): deterministic — highest score always controls.
 *   This is the original/current behavior and is regression-locked.
 * - 'score-weighted': stochastic — max(score, 0) + epsilon per player, so
 *   trailing (or negative-score) players occasionally control the board too.
 *   Without this option, deterministic leader-control biases any V(S) built
 *   from rollouts: "trailing players never get DDs" isn't true in real games.
 * - 'tracked': REAL board control per the show's rules. The controller is
 *   tracked clue by clue (see `simulateRound`): the last player to answer
 *   correctly controls the board; if nobody buzzed or everyone was wrong,
 *   the previous controller keeps it; the player who takes a DD keeps
 *   control whether right or wrong. The controller both chooses the next
 *   square (lowest unplayed index — the fixed top-down order) and is the
 *   one who hits a DD when they uncover it. Round starts: the J round's first selector
 *   is drawn uniformly (the returning champion's podium is not modeled);
 *   the DJ round's first selector is the lowest-scoring player after J
 *   (real rule; ties → lowest player index).
 *   'leader' / 'score-weighted' remain as the legacy de-biasing shims
 *   (PLAN.md E-0) with the original fixed top-down clue order.
 */
export type BoardControl = 'leader' | 'score-weighted' | 'tracked';

export interface SimConfig {
  /** Your (player 0) DD wagering strategy. */
  ddStrategy: DDStrategy;
  /**
   * Opponents' (players 1 and 2) DD wagering strategy. Defaults to
   * `ddStrategy` when omitted, so configs written before this split (E-0)
   * keep applying one strategy to everyone with no caller changes needed.
   * Scoping choice: `ddWagerFraction` below stays a single global override
   * (it predates the strategy split and no work item asked to split it) —
   * only the discrete `ddStrategy` enum is split per player here.
   */
  /**
   * Opponents never use 'equity' (E-3: out of scope for opponents) — typed
   * as `NonEquityDDStrategy` so a misconfiguration is a compile error, not
   * a silent runtime fallback.
   */
  opponentDdStrategy?: NonEquityDDStrategy;
  includeFJ: boolean;
  /** Buzz attempt correlation between players (Tesauro: 0.2) */
  rhoB: number;
  /** Right/wrong correlation between players (Tesauro: 0.2) */
  rhoP: number;
  /** Continuous DD wager fraction [0,1]. When set, overrides ddStrategy enum.
   *  0 = minimum bet, 0.5 = half of score, 1.0 = true daily double. */
  ddWagerFraction?: number;
  /** Board control model for Daily Doubles. Defaults to 'leader'. */
  boardControl?: BoardControl;
  /**
   * Disables `difficultyMultiplier` scaling entirely (treats every clue as
   * uniform difficulty) when `false`. Default (`undefined`) preserves the
   * existing scaling — E-4's paper-replication config sets this `false` to
   * match Ben's IYSE 6644 paper's stated limitation (no difficulty-by-value
   * term in that model).
   */
  difficultyScaling?: boolean;
  /**
   * Final Jeopardy wagering strategy (E-5). Default 'standard' (closed-form
   * lock/crush/two-thirds-rule wagering). 'equity' grid-searches YOUR wager
   * only; opponents always use 'standard'. See `simulateFinalJeopardy`.
   */
  fjStrategy?: 'standard' | 'equity';
  /**
   * Gates the two-thirds-rule upgrade for 2nd place's FJ wager under
   * `fjStrategy: 'standard'` (E-5). Default `'allIn'` — bets everything,
   * which is the ORIGINAL pre-E-5 behavior and is regression-locked.
   * `'twoThirdsRule'` is the documented upgrade (bet enough to cover 3rd
   * doubling rather than going all-in) — additive, off by default so the
   * seeded regression-lock snapshot stays byte-identical.
   */
  fjSecondPlaceStrategy?: 'allIn' | 'twoThirdsRule';
  /**
   * V(S) table (E-2) used by `ddStrategy: 'equity'` for YOUR (player 0)
   * wagers only. Undefined ⇒ equity DD falls back to the 'aggressive'
   * preset (documented, never a silent min-bet) — see `simulateRound`.
   */
  valueTable?: ValueTable;
  /**
   * Empirical Daily Double row placement priors (E-6), loaded from
   * `clue-stats.json` at app startup (9,064 complete games). When present,
   * `pickDDIndices` uses these instead of the hardcoded `DD_ROW_WEIGHTS`
   * folklore — same renormalization-over-open-rows behavior either way.
   * Undefined (the default — e.g. every existing test/caller) preserves
   * `DD_ROW_WEIGHTS` exactly, so the seeded regression lock is untouched.
   */
  ddRowWeights?: { J: number[]; DJ: number[] };
}

/**
 * The board-control model actually in effect for a config: the configured
 * value, defaulting to the `'leader'` shim. Exported so callers/tests can
 * see which model a config resolves to.
 */
export function resolveBoardControl(config: SimConfig): BoardControl {
  return config.boardControl ?? 'leader';
}

export const DEFAULT_CONFIG: SimConfig = {
  ddStrategy: 'aggressive',
  includeFJ: true,
  rhoB: 0.2,
  rhoP: 0.2,
  boardControl: 'leader',
};

export interface GameResult {
  scores: [number, number, number];
  winner: number; // 0 = you, 1/2 = opponents
  /** Clue-by-clue score history for replay: [clueIndex][playerIndex] */
  history?: [number, number, number][];
  ddEvents?: DDEvent[];
  /**
   * Board index of each clue in the order it was played, one entry per
   * regular/DD clue (FJ has none), aligned with `history` minus the FJ
   * entry. Under legacy board control this is simply 0..29 per round.
   * Only populated when `trackHistory` is true. Additive.
   */
  playOrder?: number[];
  /**
   * Who controlled the board (chose the square) for each played clue,
   * aligned with `playOrder`. `-1` under legacy board control, where no
   * controller is tracked between clues. Only with `trackHistory`.
   */
  controllers?: number[];
}

export interface DDEvent {
  round: 'J' | 'DJ';
  clueIndex: number;
  player: number;
  wager: number;
  correct: boolean;
  scoreBefore: number;
  scoreAfter: number;
  /**
   * Face value of the clue this Daily Double replaced (TODOS "P2 — GameDetail
   * DD event rows"). Optional: existing callers/tests that only asserted on
   * the fields above are unaffected.
   */
  clueValue?: number;
  /**
   * All three players' scores immediately before this DD was wagered — the
   * full score-state `equityWager` needs (its `scores` param), not just the
   * controller's own score. Index 0 is always "you", matching every other
   * `scores` tuple in this file. Optional/additive.
   */
  scoresBefore?: [number, number, number];
  /**
   * Clues remaining in the CURRENT round's clue list after this one — the
   * exact same quantity `simulateRound`'s equity dispatch passes as
   * `equityWager`'s `cluesRemainingAfter` argument, so a caller recomputing
   * an equity-optimal wager outside the engine (GameDetail) uses an
   * identical clues-remaining semantic. Optional/additive.
   */
  cluesRemainingAfter?: number;
  /**
   * Difficulty-adjusted precision (`player.p * difficultyMultiplier`) used as
   * `equityWager`'s `pCorrect` at this DD. Optional/additive — lets a caller
   * recompute what an equity-optimal wager would have been for this exact
   * event without re-deriving the difficulty scaling itself.
   */
  adjustedP?: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const J_VALUES = [200, 400, 600, 800, 1000];
/** Exported for value-function.ts (E-2), whose rollout table is scoped to
 *  Double-Jeopardy-and-later states and needs the round's value list to
 *  sample representative partial boards. */
export const DJ_VALUES = [400, 800, 1200, 1600, 2000];
// 6 categories × 5 values = 30 clues per round

/**
 * DD placement bias: probability weight by row (0=top, 4=bottom).
 * Bottom 3 rows heavily favored (from J-Archive analysis).
 */
const DD_ROW_WEIGHTS = [0.02, 0.04, 0.15, 0.31, 0.48];

// ─── Seeded RNG ────────────────────────────────────────────────────────

/**
 * Small seedable PRNG (mulberry32). Not cryptographic — just fast, simple,
 * and good enough entropy for Monte Carlo simulation and reproducible tests.
 * Returns a () => number in [0, 1), a drop-in replacement for Math.random.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Correlated random draws ─────────────────────────────────────────

/**
 * Generate correlated Bernoulli draws for N players.
 * Uses a latent Gaussian copula: shared factor + individual noise.
 * rho = correlation between any two players' draws.
 */
function correlatedBernoulli(probs: number[], rho: number, rng: () => number = Math.random): boolean[] {
  if (rho <= 0) return probs.map(p => rng() < p);

  const shared = gaussianRandom(rng);
  return probs.map(p => {
    const individual = gaussianRandom(rng);
    const latent = Math.sqrt(rho) * shared + Math.sqrt(1 - rho) * individual;
    // Convert probability to threshold via probit (inverse normal CDF)
    const threshold = probitApprox(p);
    return latent < threshold;
  });
}

/** Box-Muller transform for standard normal */
function gaussianRandom(rng: () => number = Math.random): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Approximate inverse normal CDF (probit function).
 * Rational approximation, accurate to ~4.5e-4.
 */
function probitApprox(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2,
    -2.759285104469687e2, 1.383577518672690e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2,
    -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1,
    -2.400758277161838e0, -2.549732539343734e0,
    4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1,
    2.445134137142996e0, 3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

// ─── Difficulty scaling ──────────────────────────────────────────────

/**
 * Difficulty multiplier for precision, by clue value.
 * Harder (higher $) clues have lower effective accuracy.
 * Calibrated from tsx prototype's Coryat model.
 */
function difficultyMultiplier(value: number, round: 'J' | 'DJ'): number {
  if (round === 'J') {
    return Math.max(0.3, 1 - (value / 1000) * 0.3);
  }
  return Math.max(0.25, 1 - (value / 2000) * 0.4);
}

/**
 * `difficultyMultiplier`, gated by `config.difficultyScaling` (E-4). Default
 * (`undefined`/`true`) preserves the original per-value scaling exactly —
 * the regression lock never sets this field, so its behavior is untouched.
 * `false` returns a flat 1 (uniform difficulty), matching the paper-
 * replication config's assumption (Ben's IYSE 6644 paper has no
 * difficulty-by-clue-value term).
 */
function effectiveDifficultyMultiplier(value: number, round: 'J' | 'DJ', config: SimConfig): number {
  if (config.difficultyScaling === false) return 1;
  return difficultyMultiplier(value, round);
}

// ─── Daily Double ────────────────────────────────────────────────────

/**
 * Weighted random pick over probabilities that (approximately) sum to 1.
 * r = rng(); subtract weights in order; fall back to the last index on
 * float rounding. Shared by DD row placement and (optionally) board control.
 */
function weightedPick(weights: number[], rng: () => number): number {
  let r = rng();
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Pick `count` distinct positions within `remainingValues` (a partial or full
 * round's clue list) where Daily Doubles land.
 *
 * Renormalizes DD_ROW_WEIGHTS over only the rows still represented in the
 * remaining clue list — a uniform draw over leftover slots would silently
 * wash out the empirical bottom-row bias (e.g. a board with only bottom-row
 * clues left must place DDs there with probability 1, not spread them
 * uniformly across whatever's left).
 *
 * Full-board equivalence (regression lock): when every row is still active
 * (the ordinary full 30-clue board), this reduces to exactly the original
 * two-draw algorithm (row via DD_ROW_WEIGHTS, then category uniformly among
 * the 6 categories in that row) — same rng call sequence, same math, so
 * seeded full-game results are bit-identical to the pre-refactor engine.
 */
function pickDDIndices(
  remainingValues: number[],
  round: 'J' | 'DJ',
  count: number,
  rng: () => number,
  // E-6: empirical row weights (clue-stats.json), when supplied by the
  // caller, replace the DD_ROW_WEIGHTS folklore fallback. Defaulting the
  // parameter (rather than reading config directly) keeps this function's
  // full-board-equivalence regression lock trivially inspectable: every
  // existing call site that doesn't pass a 5th arg is byte-identical.
  rowWeights: number[] = DD_ROW_WEIGHTS,
): Set<number> {
  const roundValues = round === 'J' ? J_VALUES : DJ_VALUES;

  // Bucket remaining clue positions by row (row = index of the value within
  // the round's 5 row values — J/DJ values are distinct per row).
  const rowBuckets: number[][] = roundValues.map(() => []);
  remainingValues.forEach((v, i) => {
    const row = roundValues.indexOf(v);
    if (row >= 0) rowBuckets[row].push(i);
  });

  const activeRowIdx: number[] = [];
  for (let row = 0; row < rowBuckets.length; row++) {
    if (rowBuckets[row].length > 0) activeRowIdx.push(row);
  }

  const fullBoard = activeRowIdx.length === roundValues.length;
  const activeWeights = fullBoard
    ? rowWeights // raw weights, untouched — preserves the regression lock exactly
    : (() => {
        const total = activeRowIdx.reduce((sum, row) => sum + rowWeights[row], 0);
        return activeRowIdx.map(row => rowWeights[row] / total);
      })();

  const ddIndices = new Set<number>();
  const maxPossible = remainingValues.length;
  while (ddIndices.size < count && ddIndices.size < maxPossible) {
    const pick = weightedPick(activeWeights, rng);
    const row = activeRowIdx[pick];
    const bucket = rowBuckets[row];
    const posInBucket = Math.floor(rng() * bucket.length);
    ddIndices.add(bucket[posInBucket]);
  }

  return ddIndices;
}

/**
 * Pick which player controls the board when a Daily Double is hit.
 * See `BoardControl` doc comment for the two modes.
 */
function pickController(
  scores: [number, number, number],
  boardControl: BoardControl,
  rng: () => number,
): number {
  if (boardControl === 'score-weighted') {
    const epsilon = 1; // keeps a $0-or-negative player's weight nonzero
    const weights = scores.map(s => Math.max(s, 0) + epsilon);
    const total = weights.reduce((a, b) => a + b, 0);
    return weightedPick(weights.map(w => w / total), rng);
  }
  // 'leader' (default, original behavior): highest score controls the board —
  // a simplification that's realistic for strong players who tend to keep it.
  return scores[0] >= scores[1] && scores[0] >= scores[2] ? 0
    : scores[1] >= scores[2] ? 1 : 2;
}

/**
 * Exhaustiveness guard: if DDStrategy ever gains a member ddWager doesn't
 * handle (e.g. a future 'equity' — which per the engine's design dispatches
 * BEFORE ddWager and must never reach this switch), TypeScript fails to
 * compile here instead of silently falling through to `minWager`.
 */
function assertNeverDDStrategy(strategy: never): never {
  throw new Error(`Unhandled DD strategy: ${String(strategy)}`);
}

/**
 * Calculate DD wager based on strategy and current score.
 * Modeling simplification: minWager = maxClueValue (not the real-rules $5
 * floor) — kept as-is for these heuristic presets; a future equity search
 * (E-3) uses the real $5 floor and documents that divergence separately.
 */
export function ddWager(strategy: NonEquityDDStrategy, score: number, maxClueValue: number, wagerFraction?: number): number {
  if (strategy === 'off') return 0;
  const minWager = maxClueValue; // minimum DD wager is the max clue value in the round
  const safeScore = Math.max(score, minWager);

  // Continuous fraction overrides discrete strategy when present
  if (wagerFraction !== undefined) {
    return Math.max(minWager, Math.round(safeScore * wagerFraction));
  }

  switch (strategy) {
    case 'conservative':
      return Math.max(minWager, Math.round(safeScore * 0.25));
    case 'aggressive':
      return Math.max(minWager, Math.round(safeScore * 0.75));
    case 'truedd':
      return Math.max(minWager, safeScore);
    default:
      return assertNeverDDStrategy(strategy);
  }
}

// ─── Buzzer resolution ───────────────────────────────────────────────

/**
 * Given players who know the answer, determine who buzzes in first.
 * Uses buzzerSpeed as relative weight (like v2 prototype).
 * Returns player index, or -1 if nobody buzzes.
 */
function resolveBuzzer(knowsAnswer: boolean[], players: Player[], rng: () => number = Math.random): number {
  const weights: number[] = [];
  let totalWeight = 0;
  for (let i = 0; i < players.length; i++) {
    const w = knowsAnswer[i] ? players[i].buzzerSpeed : 0;
    weights.push(w);
    totalWeight += w;
  }

  // NaN guard: if nobody is eligible, skip
  if (totalWeight <= 0) return -1;

  let rand = rng() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return i;
  }
  return weights.length - 1;
}

// ─── Core simulation ─────────────────────────────────────────────────

/** Build a full round's 30-clue list: 6 categories × the round's 5 row values, in board order.
 *  Exported for value-function.ts's (E-2) partial-board sampling. */
export function buildFullBoard(values: number[]): number[] {
  const clues: number[] = [];
  for (let cat = 0; cat < 6; cat++) {
    for (const v of values) {
      clues.push(v);
    }
  }
  return clues;
}

// ─── Tracked board control: board model, DD placement, square selection ──

/**
 * A round's board under `'tracked'` board control. Squares are addressed
 * by index into the round's clue list (the same index space as
 * `DDEvent.clueIndex`). Typed arrays: the per-clue selection scan reads
 * them in a tight loop and allocates nothing.
 */
export interface RoundBoard {
  /** Number of squares (≤ 30). */
  n: number;
  /** Face value per square. */
  values: number[];
  /** Row per square (0 = top … 4 = bottom); -1 if the value is not one of
   *  the round's five row values. */
  rows: Int8Array;
  /** Column per square (0..5), or -1 when unknown (a partial board entered
   *  via `simulateFromState` carries values only). */
  cols: Int8Array;
  /** 1 once the square has been played. */
  played: Uint8Array;
  /** 1 if the square holds a Daily Double (placement is hidden from the
   *  players; square selection never reads it). */
  isDD: Uint8Array;
  playedCount: number;
  /** Lowest index that might still be unplayed — the 'default' order's cursor. */
  nextDefault: number;
  /** Daily Doubles placed on this board and not yet uncovered. */
  ddRemaining: number;
  /** Bitmask of columns whose DD has already been uncovered. A DJ round's
   *  two DDs never share a column, so these columns are DD-free. */
  ddFoundColMask: number;
}

/**
 * Build a `RoundBoard` from a flat clue list. When `cols` is omitted and the
 * list is a full 30-square board (as built by `buildFullBoard`: category-
 * major, 5 rows per category), columns are derived as `floor(i / 5)`;
 * otherwise columns are unknown (-1) and the same-column DD constraint is
 * simply not applied.
 */
export function createRoundBoard(values: number[], round: 'J' | 'DJ', cols?: ArrayLike<number>): RoundBoard {
  const n = values.length;
  const roundValues = round === 'J' ? J_VALUES : DJ_VALUES;
  const rows = new Int8Array(n);
  const colArr = new Int8Array(n);
  const fullBoard = n === 30 && cols === undefined;
  for (let i = 0; i < n; i++) {
    rows[i] = roundValues.indexOf(values[i]);
    colArr[i] = cols !== undefined ? cols[i] : fullBoard ? Math.floor(i / 5) : -1;
  }
  return {
    n,
    values,
    rows,
    cols: colArr,
    played: new Uint8Array(n),
    isDD: new Uint8Array(n),
    playedCount: 0,
    nextDefault: 0,
    ddRemaining: 0,
    ddFoundColMask: 0,
  };
}

/**
 * Place `count` Daily Doubles on a tracked-mode board. Each DD lands on a
 * square with probability ∝ rowWeights[row] over the squares still
 * eligible — not already a DD and (when columns are known) not in a column
 * that already holds one (Tesauro 2012: "the two second-round DDs never
 * appear in the same column"; row set independently of column).
 *
 * On a full board this is the legacy `pickDDIndices` distribution for the
 * first DD (row ∝ weight, column uniform) plus the real-rules column
 * constraint for the second. On a partial board it is the Bayesian
 * posterior of a DD placed on the full board and not yet uncovered
 * (∝ weight per remaining SQUARE) — the model a Bayesian DD seeker would
 * compute, so a seeking strategy built on top of this is calibrated rather
 * than fooled by its own simulator. (Legacy mode's per-row renormalization
 * is left untouched for the regression lock.)
 */
function placeDailyDoubles(board: RoundBoard, count: number, rowWeights: number[], rng: () => number): void {
  const { n, rows, cols, isDD } = board;
  for (let k = 0; k < count; k++) {
    let z = 0;
    for (let i = 0; i < n; i++) {
      if (isDD[i] === 1) continue;
      if (cols[i] >= 0 && (board.ddFoundColMask & (1 << cols[i])) !== 0) continue;
      const r = rows[i];
      if (r >= 0) z += rowWeights[r];
    }
    if (z <= 0) break; // nowhere eligible left (or all-zero weights)
    let draw = rng() * z;
    let placed = -1;
    for (let i = 0; i < n; i++) {
      if (isDD[i] === 1) continue;
      if (cols[i] >= 0 && (board.ddFoundColMask & (1 << cols[i])) !== 0) continue;
      const r = rows[i];
      if (r < 0) continue;
      draw -= rowWeights[r];
      placed = i;
      if (draw <= 0) break;
    }
    if (placed < 0) break;
    isDD[placed] = 1;
    board.ddRemaining++;
    // Reserve the column so the next DD avoids it; the mask is reset to
    // "found so far" once placement is done (see simulateRound).
    if (cols[placed] >= 0) board.ddFoundColMask |= 1 << cols[placed];
  }
  board.ddFoundColMask = 0;
}

/** Lowest unplayed index: top-to-bottom within a category, categories
 *  left-to-right — today's fixed clue order. */
function chooseSquareDefault(board: RoundBoard): number {
  const { played } = board;
  let i = board.nextDefault;
  while (i < board.n && played[i] === 1) i++;
  board.nextDefault = i;
  return i;
}

/** Real rule: the lowest-scoring player after the Jeopardy round selects
 *  first in Double Jeopardy (ties → lowest player index). */
export function lowestScoreIndex(scores: [number, number, number]): number {
  let idx = 0;
  for (let i = 1; i < 3; i++) if (scores[i] < scores[idx]) idx = i;
  return idx;
}

/**
 * Simulate a (possibly partial) round of Jeopardy or Double Jeopardy.
 *
 * `clueValues` is the flat list of remaining clue values — the full 30-clue
 * board for a fresh round, or a shorter list for a partial board entered
 * via `simulateFromState`. `ddCount` is how many (still-unrevealed) Daily
 * Doubles remain to be placed among them.
 *
 * Board control (see `BoardControl`): under the legacy shims the clues are
 * played in list order and `pickController` decides who hits a DD — the
 * regression-locked path, byte-identical to the original engine. Under
 * `'tracked'` the controller is a real tracked player who picks each
 * square (top-down order for now); `initialController` is
 * who starts the round (`-1` ⇒ one uniform draw — the J-round rule when
 * no returning champion is modeled; callers pass `lowestScoreIndex` for DJ).
 *
 * DRY: handles both rounds with parameterized clue values.
 * Returns updated scores and events.
 */
export function simulateRound(
  players: Player[],
  scores: [number, number, number],
  clueValues: number[],
  ddCount: number,
  round: 'J' | 'DJ',
  config: SimConfig,
  trackHistory: boolean,
  rng: () => number = Math.random,
  initialController = -1,
): {
  scores: [number, number, number];
  history: [number, number, number][];
  ddEvents: DDEvent[];
  playOrder: number[];
  controllers: number[];
} {
  const history: [number, number, number][] = [];
  const ddEvents: DDEvent[] = [];
  const playOrder: number[] = [];
  const controllers: number[] = [];

  const clues = clueValues;
  const n = clues.length;
  const roundValues = round === 'J' ? J_VALUES : DJ_VALUES;
  const maxClueValue = roundValues[roundValues.length - 1];
  const boardControl = resolveBoardControl(config);
  const tracked = boardControl === 'tracked';

  // Place Daily Doubles. Legacy: pickDDIndices (renormalized over the rows
  // still in play; E-6: config.ddRowWeights[round] replaces the
  // DD_ROW_WEIGHTS folklore fallback). Tracked: placeDailyDoubles on a
  // RoundBoard, same priors, plus the real-rules column constraint.
  const rowWeights = config.ddRowWeights?.[round] ?? DD_ROW_WEIGHTS;
  let ddIndices: Set<number> | null = null;
  let board: RoundBoard | null = null;
  let controller = -1;
  if (tracked) {
    board = createRoundBoard(clues, round);
    if (config.ddStrategy !== 'off') placeDailyDoubles(board, ddCount, rowWeights, rng);
    controller = initialController >= 0 && initialController < 3
      ? initialController
      : Math.floor(rng() * 3);
  } else {
    ddIndices = config.ddStrategy !== 'off'
      ? pickDDIndices(clues, round, ddCount, rng, config.ddRowWeights?.[round])
      : new Set<number>();
  }

  for (let played = 0; played < n; played++) {
    // Which square is played next: list order (legacy) or the tracked
    // controller's choice.
    let i: number;
    let isDD: boolean;
    if (board !== null) {
      i = chooseSquareDefault(board);
      board.played[i] = 1;
      board.playedCount++;
      isDD = board.isDD[i] === 1;
      if (isDD) {
        board.ddRemaining--;
        if (board.cols[i] >= 0) board.ddFoundColMask |= 1 << board.cols[i];
      }
    } else {
      i = played;
      isDD = ddIndices!.has(i);
    }
    if (trackHistory) {
      playOrder.push(i);
      controllers.push(controller);
    }

    const value = clues[i];
    const dm = effectiveDifficultyMultiplier(value, round, config);
    const cluesRemainingAfter = n - played - 1;

    if (isDD && config.ddStrategy !== 'off') {
      // Daily Double: the tracked controller uncovered it; under the legacy
      // shims board control is modeled by pickController (see BoardControl).
      const ddController = tracked ? controller : pickController(scores, boardControl, rng);
      const player = players[ddController];
      // Per-player DD strategy: your (player 0) wagering heuristic can
      // differ from opponents'. opponentDdStrategy defaults to ddStrategy
      // for backward compatibility with configs written before this split.
      const controllerStrategy = ddController === 0
        ? config.ddStrategy
        : (config.opponentDdStrategy ?? config.ddStrategy);
      const adjustedP = player.p * dm;

      // E-3: equity dispatch happens HERE, before ddWager — 'equity' never
      // reaches ddWager's switch (its parameter type statically excludes
      // 'equity', so the `else` branch below is the only way to satisfy the
      // compiler). YOUR player (controller 0) only; a misconfigured
      // opponentDdStrategy of 'equity' (out of scope, E-3) or a missing
      // valueTable both fall back to 'aggressive' — documented, never a
      // silent min-bet.
      let wager: number;
      if (ddController === 0 && controllerStrategy === 'equity') {
        if (config.valueTable) {
          wager = equityWager(
            { knowledge: player.b * player.p, buzzerSpeed: player.buzzerSpeed },
            scores,
            cluesRemainingAfter,
            adjustedP,
            config.valueTable,
          );
        } else {
          wager = ddWager('aggressive', scores[ddController], maxClueValue, config.ddWagerFraction);
        }
      } else {
        const safeStrategy: NonEquityDDStrategy = controllerStrategy === 'equity' ? 'aggressive' : controllerStrategy;
        wager = ddWager(safeStrategy, scores[ddController], maxClueValue, config.ddWagerFraction);
      }

      const correct = rng() < adjustedP;
      const scoreBefore = scores[ddController];
      // Full 3-player snapshot before mutation — see DDEvent.scoresBefore doc.
      const scoresBeforeSnapshot: [number, number, number] = [...scores] as [number, number, number];

      if (correct) {
        scores[ddController] += wager;
      } else {
        scores[ddController] -= wager;
      }
      // Real rule: the player who took the DD keeps the board either way —
      // `controller` is unchanged.

      ddEvents.push({
        round,
        clueIndex: i,
        player: ddController,
        wager,
        correct,
        scoreBefore,
        scoreAfter: scores[ddController],
        clueValue: value,
        scoresBefore: scoresBeforeSnapshot,
        // Same quantity fed to equityWager's cluesRemainingAfter just above
        // — kept consistent for GameDetail's out-of-engine recomputation.
        cluesRemainingAfter,
        adjustedP,
      });
    } else {
      // Regular clue
      // Correlated buzz attempts
      const buzzProbs = players.map(p => p.b);
      const attempts = correlatedBernoulli(buzzProbs, config.rhoB, rng);

      // For those who attempt, check accuracy with difficulty scaling
      const accuracyProbs = players.map(p => p.p * dm);
      const knowsAnswer = correlatedBernoulli(accuracyProbs, config.rhoP, rng)
        .map((correct, idx) => correct && attempts[idx]);

      const winner = resolveBuzzer(knowsAnswer, players, rng);

      if (winner >= 0) {
        scores[winner] += value;
        // Real rule: a correct answer takes the board.
        if (tracked) controller = winner;
      } else if (attempts.some(a => a)) {
        // Someone buzzed but got it wrong — wrong answer penalty
        // Pick the fastest buzzer among those who attempted
        const attemptPlayers = attempts.map((a, idx) => a ? idx : -1).filter(idx => idx >= 0);
        if (attemptPlayers.length > 0) {
          const wrongBuzzer = resolveBuzzer(
            attemptPlayers.map(() => true),
            attemptPlayers.map(idx => players[idx]),
            rng,
          );
          if (wrongBuzzer >= 0) {
            const wrongPlayer = attemptPlayers[wrongBuzzer];
            scores[wrongPlayer] -= value;

            // Rebound: remaining players get a chance
            const reboundEligible = players.map((_, idx) =>
              idx !== wrongPlayer && attempts[idx] !== true && rng() < players[idx].b,
            );
            const reboundAccuracy = correlatedBernoulli(
              players.map(p => p.p * dm),
              config.rhoP,
              rng,
            ).map((correct, idx) => correct && reboundEligible[idx]);

            const reboundWinner = resolveBuzzer(reboundAccuracy, players, rng);
            if (reboundWinner >= 0) {
              scores[reboundWinner] += value;
              // A correct rebound takes the board too.
              if (tracked) controller = reboundWinner;
            }
          }
        }
      }
      // Nobody right (no buzz, or wrong with no successful rebound): the
      // previous controller keeps the board — `controller` is unchanged.
    }

    if (trackHistory) {
      history.push([...scores] as [number, number, number]);
    }
  }

  return { scores, history, ddEvents, playOrder, controllers };
}

/**
 * Closed-form Final Jeopardy wagering (E-5's `fjStrategy: 'standard'`) — The
 * Final Wager conventions, encoded per PLAN.md's documented cases:
 * - **Leader with a lock** (score > 2× second place already): bet ≤
 *   (lead − 2×second), the can't-lose wager. We bet exactly $0, the
 *   simplest safe choice — this is provably byte-identical to the
 *   pre-E-5 formula below at every lockMargin ≥ 0 (2·second−lead+1 ≤ 0
 *   in that regime, and `Math.max(0, …)` already floored it at 0), so the
 *   regression lock is unaffected.
 * - **Leader without a lock**: bet enough to cover 2nd place doubling up,
 *   `2×second − lead + 1` (original/default behavior, unchanged).
 * - **2nd place**: default 'allIn' (original behavior, bet everything) —
 *   the two-thirds-rule upgrade is gated behind
 *   `config.fjSecondPlaceStrategy: 'twoThirdsRule'`, OFF by default so the
 *   seeded regression-lock snapshot stays byte-identical. The upgraded rule
 *   (standard two-thirds reasoning, kept simple per PLAN.md): a proper
 *   leader covers second doubling and, on a miss, falls to 2·lead −
 *   2·second − 1; second's winning line in that leader-misses scenario is
 *   to wager just enough to clear it (2·lead − 3·second), while also
 *   covering 3rd's double (2·third − second + 1) — bet the larger of the
 *   two, floored at 0 and capped at second's score.
 * - **3rd place**: all-in (default). A "targeted" variant (bet just enough
 *   to overtake one specific rival if both leader and 2nd miss) is a
 *   documented deferral — 3rd's win probability is already small enough
 *   that this refinement has negligible effect on aggregate win-rate
 *   stats, not worth the added branching for this plan's scope.
 */
export function computeFJWagersStandard(
  scores: [number, number, number],
  config: SimConfig,
): [number, number, number] {
  const sorted = [0, 1, 2].sort((a, b) => scores[b] - scores[a]);
  const leader = sorted[0];
  const second = sorted[1];
  const third = sorted[2];

  const canPlay = scores.map(s => s > 0);
  const wagers: [number, number, number] = [0, 0, 0];

  if (canPlay[leader]) {
    const leadAmount = scores[leader];
    const secondAmount = canPlay[second] ? scores[second] : 0;
    const lockMargin = leadAmount - 2 * secondAmount;
    if (lockMargin > 0) {
      // Can't-lose wager: any bet in [0, lockMargin] preserves the lock
      // regardless of FJ's outcome; $0 is the simplest safe choice.
      wagers[leader] = 0;
    } else {
      wagers[leader] = Math.min(scores[leader], Math.max(0, 2 * secondAmount - leadAmount + 1));
    }
  }

  if (canPlay[second]) {
    if (config.fjSecondPlaceStrategy === 'twoThirdsRule') {
      const secondAmount = scores[second];
      const leadAmount = scores[leader];
      const thirdAmount = canPlay[third] ? scores[third] : 0;
      // Clear the leader's post-miss score (leader covers, misses, lands on
      // 2·lead − 2·second − 1) AND cover third doubling up — see doc above.
      const coverLeaderMiss = 2 * leadAmount - 3 * secondAmount;
      const coverThirdDouble = 2 * thirdAmount - secondAmount + 1;
      wagers[second] = Math.min(secondAmount, Math.max(0, coverLeaderMiss, coverThirdDouble));
    } else {
      wagers[second] = scores[second]; // all-in (default, original behavior)
    }
  }

  if (canPlay[third]) {
    wagers[third] = scores[third]; // all-in (default; "targeted" deferred, see doc above)
  }

  return wagers;
}

const FJ_EQUITY_GRID_POINTS = 25;
const FJ_EQUITY_SAMPLES = 1500;

/**
 * E-5 `fjStrategy: 'equity'` — grid search YOUR (player 0) wager over
 * [0, yourScore] maximizing win probability via correlated FJ accuracy
 * draws (ρ≈0.3, same `correlatedBernoulli` machinery as the rest of FJ).
 * Opponents' wagers are fixed at their 'standard' values (computed once,
 * independent of your choice — real FJ wagers are simultaneous).
 *
 * FJ is terminal, so an exact expected-value calc over the 8 right/wrong
 * combinations (weighting each by the correlated joint probability) is
 * possible in principle, but the Gaussian-copula joint here has no closed
 * form without a numerical integral over the shared latent factor. Direct
 * Monte Carlo sampling (this function) is simpler to get right and
 * consistent with the rest of the engine's MC style — documented choice,
 * per PLAN.md's "either approach fine, document."
 *
 * Ties are split (co-champion = 0.5 win), matching the engine's documented
 * tie-rule elsewhere.
 *
 * Exported for E-5's standard-vs-equity gap measurement test.
 */
export function fjEquityGridSearch(
  players: Player[],
  scores: [number, number, number],
  opponentWagers: [number, number, number],
  rng: () => number,
): number {
  const yourScore = Math.max(scores[0], 0);
  if (yourScore <= 0) return 0;

  const fjProbs = players.map(p => p.fjAccuracy);

  let bestWager = 0;
  let bestWinProb = -Infinity;

  for (let g = 0; g < FJ_EQUITY_GRID_POINTS; g++) {
    const wager = Math.round((yourScore * g) / (FJ_EQUITY_GRID_POINTS - 1));
    let wins = 0;
    for (let s = 0; s < FJ_EQUITY_SAMPLES; s++) {
      const correct = correlatedBernoulli(fjProbs, 0.3, rng);
      const final: [number, number, number] = [
        scores[0] + (correct[0] ? wager : -wager),
        scores[1] + (correct[1] ? opponentWagers[1] : -opponentWagers[1]),
        scores[2] + (correct[2] ? opponentWagers[2] : -opponentWagers[2]),
      ];
      const maxScore = Math.max(...final);
      const winners = final.filter(v => v === maxScore).length;
      if (final[0] === maxScore) wins += 1 / winners;
    }
    const winProb = wins / FJ_EQUITY_SAMPLES;
    if (winProb > bestWinProb) {
      bestWinProb = winProb;
      bestWager = wager;
    }
  }

  return bestWager;
}

function computeFJWagersEquity(
  players: Player[],
  scores: [number, number, number],
  config: SimConfig,
  rng: () => number,
): [number, number, number] {
  // Opponents always use 'standard' wagers — 'equity' FJ is YOUR-player-only.
  const standard = computeFJWagersStandard(scores, config);
  const yourWager = fjEquityGridSearch(players, scores, standard, rng);
  return [yourWager, standard[1], standard[2]];
}

/**
 * Simulate Final Jeopardy. Wagering dispatches on `config.fjStrategy`
 * (E-5): 'standard' (default) = closed-form lock/crush/two-thirds-rule
 * wagering (`computeFJWagersStandard`); 'equity' = grid-searched wager for
 * YOUR player against opponents' 'standard' wagers (`computeFJWagersEquity`).
 * Correlated accuracy (ρ_p = 0.3 per Tesauro) either way.
 */
export function simulateFinalJeopardy(
  players: Player[],
  scores: [number, number, number],
  config: SimConfig,
  rng: () => number = Math.random,
): [number, number, number] {
  const canPlay = scores.map(s => s > 0);
  const strategy = config.fjStrategy ?? 'standard';
  const wagers = strategy === 'equity'
    ? computeFJWagersEquity(players, scores, config, rng)
    : computeFJWagersStandard(scores, config);

  // Correlated accuracy (slightly higher correlation for FJ)
  const fjProbs = players.map(p => p.fjAccuracy);
  const correct = correlatedBernoulli(fjProbs, 0.3, rng);

  for (let i = 0; i < 3; i++) {
    if (!canPlay[i]) continue;
    if (correct[i]) {
      scores[i] += wagers[i];
    } else {
      scores[i] -= wagers[i];
    }
  }

  return scores;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Simulate a single complete Jeopardy game.
 *
 * @param you - Your player profile
 * @param opp1 - Opponent 1 profile
 * @param opp2 - Opponent 2 profile
 * @param config - Simulation configuration
 * @param trackHistory - If true, records clue-by-clue score history (for replay)
 */
export function simulateGame(
  you: Player,
  opp1: Player,
  opp2: Player,
  config: SimConfig = DEFAULT_CONFIG,
  trackHistory = false,
  rng: () => number = Math.random,
): GameResult {
  const players: Player[] = [you, opp1, opp2];
  let scores: [number, number, number] = [0, 0, 0];
  let allHistory: [number, number, number][] = [];
  let allDDEvents: DDEvent[] = [];
  let allPlayOrder: number[] = [];
  let allControllers: number[] = [];

  // Jeopardy Round (1 DD over the full 30-clue board). First selector:
  // uniform draw under tracked board control (no returning champion is
  // modeled); ignored under the legacy shims.
  const jResult = simulateRound(players, scores, buildFullBoard(J_VALUES), 1, 'J', config, trackHistory, rng, -1);
  scores = jResult.scores;
  allHistory = allHistory.concat(jResult.history);
  allDDEvents = allDDEvents.concat(jResult.ddEvents);
  allPlayOrder = allPlayOrder.concat(jResult.playOrder);
  allControllers = allControllers.concat(jResult.controllers);

  // Double Jeopardy Round (2 DDs over the full 30-clue board). Real rule:
  // the lowest-scoring player after J selects first.
  const djResult = simulateRound(
    players, scores, buildFullBoard(DJ_VALUES), 2, 'DJ', config, trackHistory, rng, lowestScoreIndex(scores),
  );
  scores = djResult.scores;
  allHistory = allHistory.concat(djResult.history);
  allDDEvents = allDDEvents.concat(djResult.ddEvents);
  allPlayOrder = allPlayOrder.concat(djResult.playOrder);
  allControllers = allControllers.concat(djResult.controllers);

  // Final Jeopardy
  if (config.includeFJ) {
    scores = simulateFinalJeopardy(players, scores, config, rng);
    if (trackHistory) {
      allHistory.push([...scores] as [number, number, number]);
    }
  }

  const maxScore = Math.max(...scores);
  const winner = scores.indexOf(maxScore);

  return {
    scores,
    winner,
    history: trackHistory ? allHistory : undefined,
    ddEvents: trackHistory ? allDDEvents : undefined,
    playOrder: trackHistory ? allPlayOrder : undefined,
    controllers: trackHistory ? allControllers : undefined,
  };
}

/**
 * A mid-game state to resume simulation from: partial-round remainder
 * (clue values + Daily Doubles not yet placed), plus current scores.
 */
export interface SimState {
  scores: [number, number, number];
  round: 'J' | 'DJ';
  remainingClueValues: number[];
  remainingDDCount: number;
  /**
   * Who controls the board as play resumes (tracked board control only;
   * ignored under the legacy shims). Omitted ⇒ one uniform draw. Optional
   * and additive — existing states are unaffected.
   */
  controller?: number;
}

/**
 * Enter a game at an arbitrary mid-game state and play out the rest.
 *
 * Composes the same simulateRound / simulateFinalJeopardy building blocks as
 * simulateGame, but starting from a partial board — this is what V(S)
 * rollouts (E-2) use so the value function is fit from real mid-game states,
 * not only from full-game starts.
 *
 * Boundary: 0 clues remaining in DJ skips straight to Final Jeopardy (no
 * empty round is simulated). 0 clues remaining in J still plays a full DJ
 * round afterward.
 */
export function simulateFromState(
  state: SimState,
  players: Player[],
  config: SimConfig = DEFAULT_CONFIG,
  rng: () => number = Math.random,
  trackHistory = false,
): GameResult {
  let scores: [number, number, number] = [...state.scores];
  let allHistory: [number, number, number][] = [];
  let allDDEvents: DDEvent[] = [];
  let allPlayOrder: number[] = [];
  let allControllers: number[] = [];

  // Finish whatever's left of the round we're currently in.
  if (state.remainingClueValues.length > 0) {
    const result = simulateRound(
      players, scores, state.remainingClueValues, state.remainingDDCount,
      state.round, config, trackHistory, rng, state.controller ?? -1,
    );
    scores = result.scores;
    allHistory = allHistory.concat(result.history);
    allDDEvents = allDDEvents.concat(result.ddEvents);
    allPlayOrder = allPlayOrder.concat(result.playOrder);
    allControllers = allControllers.concat(result.controllers);
  }

  // If we started mid-Jeopardy, Double Jeopardy is played in full next
  // (lowest score after J selects first — the real rule).
  if (state.round === 'J') {
    const djResult = simulateRound(
      players, scores, buildFullBoard(DJ_VALUES), 2, 'DJ', config, trackHistory, rng, lowestScoreIndex(scores),
    );
    scores = djResult.scores;
    allHistory = allHistory.concat(djResult.history);
    allDDEvents = allDDEvents.concat(djResult.ddEvents);
    allPlayOrder = allPlayOrder.concat(djResult.playOrder);
    allControllers = allControllers.concat(djResult.controllers);
  }

  if (config.includeFJ) {
    scores = simulateFinalJeopardy(players, scores, config, rng);
    if (trackHistory) {
      allHistory.push([...scores] as [number, number, number]);
    }
  }

  const maxScore = Math.max(...scores);
  const winner = scores.indexOf(maxScore);

  return {
    scores,
    winner,
    history: trackHistory ? allHistory : undefined,
    ddEvents: trackHistory ? allDDEvents : undefined,
    playOrder: trackHistory ? allPlayOrder : undefined,
    controllers: trackHistory ? allControllers : undefined,
  };
}

/**
 * Sample a random opponent from a profile, with ±5% jitter.
 */
export function sampleOpponent(
  profile: { b: number; p: number; fjAccuracy: number },
  rng: () => number = Math.random,
): Player {
  const jitter = () => (rng() - 0.5) * 0.1;
  return {
    b: clamp(profile.b + jitter(), 0, 1),
    p: clamp(profile.p + jitter(), 0, 1),
    buzzerSpeed: clamp(profile.b + jitter(), 0, 1), // buzzer speed correlates with buzz attempt rate
    fjAccuracy: clamp(profile.fjAccuracy + jitter(), 0, 1),
  };
}

/**
 * Create a player from the simplified 2-axis model.
 *
 * knowledge = b × p (composite "effective knowledge")
 * buzzerSpeed = relative buzzer speed
 *
 * We decompose knowledge back into b and p:
 *   Given knowledge K and we need b, p such that b*p = K.
 *   Heuristic: p = min(0.95, K / max(b, 0.1)), b = buzzerSpeed-ish.
 *   Better: set b = sqrt(K / 0.87) * scale, p = K / b, clamped.
 */
export function playerFrom2Axis(knowledge: number, buzzerSpeed: number): Player {
  // knowledge = b * p. We need to decompose.
  // Heuristic: assume p tracks with the Tesauro average ratio (p/b ≈ 0.87/0.61 ≈ 1.43)
  // So p ≈ 1.43 * b, and b * 1.43 * b = knowledge → b = sqrt(knowledge / 1.43)
  const ratio = 0.87 / 0.61; // ~1.426
  let b = Math.sqrt(knowledge / ratio);
  let p = knowledge / Math.max(b, 0.01);

  // Clamp to realistic bounds
  b = clamp(b, 0, 0.95);
  p = clamp(p, 0, 0.98);

  // FJ accuracy correlates with precision
  const fjAccuracy = clamp(0.3 + p * 0.4, 0.2, 0.8);

  return { b, p, buzzerSpeed, fjAccuracy };
}

/**
 * Run N games and return win rate + optional per-game results.
 */
export function calculateWinRate(
  you: Player,
  opponentProfile: { b: number; p: number; fjAccuracy: number },
  config: SimConfig = DEFAULT_CONFIG,
  nGames = 1000,
  returnResults = false,
  rng: () => number = Math.random,
): { winRate: number; results?: GameResult[] } {
  let wins = 0;
  const results: GameResult[] = [];

  for (let i = 0; i < nGames; i++) {
    const opp1 = sampleOpponent(opponentProfile, rng);
    const opp2 = sampleOpponent(opponentProfile, rng);
    const result = simulateGame(you, opp1, opp2, config, returnResults, rng);

    if (result.winner === 0) wins++;
    if (returnResults) results.push(result);
  }

  return { winRate: wins / nGames, results: returnResults ? results : undefined };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
