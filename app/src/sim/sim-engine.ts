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
 *
 * Randomness: every stochastic function takes an optional `rng: () => number`
 * (a drop-in replacement for Math.random, e.g. `mulberry32(seed)` below).
 * Omitting it preserves the original Math.random behavior exactly — this
 * threading is additive-only, never a behavior change for existing callers.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface Player {
  b: number;       // buzz attempt rate [0,1]
  p: number;       // precision (accuracy given buzz) [0,1]
  buzzerSpeed: number; // relative buzzer speed [0,1] — wins contested buzzes
  fjAccuracy: number;  // Final Jeopardy accuracy [0,1]
}

export type DDStrategy = 'off' | 'conservative' | 'aggressive' | 'truedd';

/**
 * Who controls the board when a Daily Double is hit.
 * - 'leader' (default): deterministic — highest score always controls.
 *   This is the original/current behavior and is regression-locked.
 * - 'score-weighted': stochastic — max(score, 0) + epsilon per player, so
 *   trailing (or negative-score) players occasionally control the board too.
 *   Without this option, deterministic leader-control biases any V(S) built
 *   from rollouts: "trailing players never get DDs" isn't true in real games.
 */
export type BoardControl = 'leader' | 'score-weighted';

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
  opponentDdStrategy?: DDStrategy;
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
}

export interface DDEvent {
  round: 'J' | 'DJ';
  clueIndex: number;
  player: number;
  wager: number;
  correct: boolean;
  scoreBefore: number;
  scoreAfter: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const J_VALUES = [200, 400, 600, 800, 1000];
const DJ_VALUES = [400, 800, 1200, 1600, 2000];
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
    ? DD_ROW_WEIGHTS // raw weights, untouched — preserves the regression lock exactly
    : (() => {
        const total = activeRowIdx.reduce((sum, row) => sum + DD_ROW_WEIGHTS[row], 0);
        return activeRowIdx.map(row => DD_ROW_WEIGHTS[row] / total);
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
export function ddWager(strategy: DDStrategy, score: number, maxClueValue: number, wagerFraction?: number): number {
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

/** Build a full round's 30-clue list: 6 categories × the round's 5 row values, in board order. */
function buildFullBoard(values: number[]): number[] {
  const clues: number[] = [];
  for (let cat = 0; cat < 6; cat++) {
    for (const v of values) {
      clues.push(v);
    }
  }
  return clues;
}

/**
 * Simulate a (possibly partial) round of Jeopardy or Double Jeopardy.
 *
 * `clueValues` is the flat list of remaining clue values — the full 30-clue
 * board for a fresh round, or a shorter list for a partial board entered
 * via `simulateFromState`. `ddCount` is how many (still-unrevealed) Daily
 * Doubles remain to be placed among them.
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
): { scores: [number, number, number]; history: [number, number, number][]; ddEvents: DDEvent[] } {
  const history: [number, number, number][] = [];
  const ddEvents: DDEvent[] = [];

  const clues = clueValues;
  const roundValues = round === 'J' ? J_VALUES : DJ_VALUES;
  const maxClueValue = roundValues[roundValues.length - 1];
  const boardControl: BoardControl = config.boardControl ?? 'leader';

  // Place Daily Doubles (renormalized over the rows still in play — see pickDDIndices).
  const ddIndices = config.ddStrategy !== 'off'
    ? pickDDIndices(clues, round, ddCount, rng)
    : new Set<number>();

  for (let i = 0; i < clues.length; i++) {
    const value = clues[i];
    const dm = difficultyMultiplier(value, round);

    if (ddIndices.has(i) && config.ddStrategy !== 'off') {
      // Daily Double: board control decides who gets it (see BoardControl).
      const controller = pickController(scores, boardControl, rng);
      const player = players[controller];
      // Per-player DD strategy: your (player 0) wagering heuristic can
      // differ from opponents'. opponentDdStrategy defaults to ddStrategy
      // for backward compatibility with configs written before this split.
      const controllerStrategy = controller === 0
        ? config.ddStrategy
        : (config.opponentDdStrategy ?? config.ddStrategy);
      const wager = ddWager(controllerStrategy, scores[controller], maxClueValue, config.ddWagerFraction);
      const adjustedP = player.p * dm;
      const correct = rng() < adjustedP;
      const scoreBefore = scores[controller];

      if (correct) {
        scores[controller] += wager;
      } else {
        scores[controller] -= wager;
      }

      ddEvents.push({
        round,
        clueIndex: i,
        player: controller,
        wager,
        correct,
        scoreBefore,
        scoreAfter: scores[controller],
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
            }
          }
        }
      }
    }

    if (trackHistory) {
      history.push([...scores] as [number, number, number]);
    }
  }

  return { scores, history, ddEvents };
}

/**
 * Simulate Final Jeopardy.
 *
 * Wagering: simplified score-position strategy.
 * - Leader bets to cover 2nd place doubling up (or $0 if already locked).
 * - 2nd place bets everything.
 * - 3rd place bets everything.
 * Correlated accuracy (ρ_p = 0.3 per Tesauro).
 */
export function simulateFinalJeopardy(
  players: Player[],
  scores: [number, number, number],
  _config: SimConfig,
  rng: () => number = Math.random,
): [number, number, number] {
  const sorted = [0, 1, 2].sort((a, b) => scores[b] - scores[a]);
  const leader = sorted[0];
  const second = sorted[1];
  const third = sorted[2];

  // Eliminate players with $0 or less — they can't play FJ
  const canPlay = scores.map(s => s > 0);

  // Calculate wagers
  const wagers: [number, number, number] = [0, 0, 0];

  if (canPlay[leader]) {
    const leadAmount = scores[leader];
    const secondAmount = canPlay[second] ? scores[second] : 0;
    // Bet enough to cover 2nd place doubling, minimum $0
    wagers[leader] = Math.max(0, 2 * secondAmount - leadAmount + 1);
    // Don't bet more than you have
    wagers[leader] = Math.min(wagers[leader], scores[leader]);
  }
  if (canPlay[second]) {
    wagers[second] = scores[second]; // bet everything
  }
  if (canPlay[third]) {
    wagers[third] = scores[third]; // bet everything
  }

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

  // Jeopardy Round (1 DD over the full 30-clue board)
  const jResult = simulateRound(players, scores, buildFullBoard(J_VALUES), 1, 'J', config, trackHistory, rng);
  scores = jResult.scores;
  allHistory = allHistory.concat(jResult.history);
  allDDEvents = allDDEvents.concat(jResult.ddEvents);

  // Double Jeopardy Round (2 DDs over the full 30-clue board)
  const djResult = simulateRound(players, scores, buildFullBoard(DJ_VALUES), 2, 'DJ', config, trackHistory, rng);
  scores = djResult.scores;
  allHistory = allHistory.concat(djResult.history);
  allDDEvents = allDDEvents.concat(djResult.ddEvents);

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

  // Finish whatever's left of the round we're currently in.
  if (state.remainingClueValues.length > 0) {
    const result = simulateRound(
      players, scores, state.remainingClueValues, state.remainingDDCount,
      state.round, config, trackHistory, rng,
    );
    scores = result.scores;
    allHistory = allHistory.concat(result.history);
    allDDEvents = allDDEvents.concat(result.ddEvents);
  }

  // If we started mid-Jeopardy, Double Jeopardy is played in full next.
  if (state.round === 'J') {
    const djResult = simulateRound(
      players, scores, buildFullBoard(DJ_VALUES), 2, 'DJ', config, trackHistory, rng,
    );
    scores = djResult.scores;
    allHistory = allHistory.concat(djResult.history);
    allDDEvents = allDDEvents.concat(djResult.ddEvents);
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
