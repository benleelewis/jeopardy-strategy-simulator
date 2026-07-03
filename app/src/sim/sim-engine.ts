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
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface Player {
  b: number;       // buzz attempt rate [0,1]
  p: number;       // precision (accuracy given buzz) [0,1]
  buzzerSpeed: number; // relative buzzer speed [0,1] — wins contested buzzes
  fjAccuracy: number;  // Final Jeopardy accuracy [0,1]
}

export type DDStrategy = 'off' | 'conservative' | 'aggressive' | 'truedd';

export interface SimConfig {
  ddStrategy: DDStrategy;
  includeFJ: boolean;
  /** Buzz attempt correlation between players (Tesauro: 0.2) */
  rhoB: number;
  /** Right/wrong correlation between players (Tesauro: 0.2) */
  rhoP: number;
  /** Continuous DD wager fraction [0,1]. When set, overrides ddStrategy enum.
   *  0 = minimum bet, 0.5 = half of score, 1.0 = true daily double. */
  ddWagerFraction?: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  ddStrategy: 'aggressive',
  includeFJ: true,
  rhoB: 0.2,
  rhoP: 0.2,
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

// ─── Correlated random draws ─────────────────────────────────────────

/**
 * Generate correlated Bernoulli draws for N players.
 * Uses a latent Gaussian copula: shared factor + individual noise.
 * rho = correlation between any two players' draws.
 */
function correlatedBernoulli(probs: number[], rho: number): boolean[] {
  if (rho <= 0) return probs.map(p => Math.random() < p);

  const shared = gaussianRandom();
  return probs.map(p => {
    const individual = gaussianRandom();
    const latent = Math.sqrt(rho) * shared + Math.sqrt(1 - rho) * individual;
    // Convert probability to threshold via probit (inverse normal CDF)
    const threshold = probitApprox(p);
    return latent < threshold;
  });
}

/** Box-Muller transform for standard normal */
function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
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

/** Pick which row (0-4) a DD lands on, using weighted random. */
function pickDDRow(): number {
  let r = Math.random();
  for (let i = 0; i < DD_ROW_WEIGHTS.length; i++) {
    r -= DD_ROW_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 4;
}

/** Pick DD clue index within a round's 30 clues (6 categories × 5 values). */
function pickDDClueIndex(): number {
  const row = pickDDRow();
  const category = Math.floor(Math.random() * 6);
  return category * 5 + row;
}

/** Calculate DD wager based on strategy and current score. */
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
      return minWager;
  }
}

// ─── Buzzer resolution ───────────────────────────────────────────────

/**
 * Given players who know the answer, determine who buzzes in first.
 * Uses buzzerSpeed as relative weight (like v2 prototype).
 * Returns player index, or -1 if nobody buzzes.
 */
function resolveBuzzer(knowsAnswer: boolean[], players: Player[]): number {
  const weights: number[] = [];
  let totalWeight = 0;
  for (let i = 0; i < players.length; i++) {
    const w = knowsAnswer[i] ? players[i].buzzerSpeed : 0;
    weights.push(w);
    totalWeight += w;
  }

  // NaN guard: if nobody is eligible, skip
  if (totalWeight <= 0) return -1;

  let rand = Math.random() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return i;
  }
  return weights.length - 1;
}

// ─── Core simulation ─────────────────────────────────────────────────

/**
 * Simulate a single round (Jeopardy or Double Jeopardy).
 *
 * DRY: handles both rounds with parameterized clue values.
 * Returns updated scores and events.
 */
function simulateRound(
  players: Player[],
  scores: [number, number, number],
  values: number[],
  round: 'J' | 'DJ',
  config: SimConfig,
  trackHistory: boolean,
): { scores: [number, number, number]; history: [number, number, number][]; ddEvents: DDEvent[] } {
  const history: [number, number, number][] = [];
  const ddEvents: DDEvent[] = [];

  // Build clue list: 6 categories × 5 values = 30 clues
  const clues: number[] = [];
  for (let cat = 0; cat < 6; cat++) {
    for (const v of values) {
      clues.push(v);
    }
  }

  // Place Daily Doubles
  const ddCount = round === 'J' ? 1 : 2;
  const ddIndices = new Set<number>();
  if (config.ddStrategy !== 'off') {
    while (ddIndices.size < ddCount) {
      ddIndices.add(pickDDClueIndex());
    }
  }

  for (let i = 0; i < clues.length; i++) {
    const value = clues[i];
    const dm = difficultyMultiplier(value, round);

    if (ddIndices.has(i) && config.ddStrategy !== 'off') {
      // Daily Double: whoever has board control gets it
      // Simplification: player with highest score gets control (realistic for strong players)
      const controller = scores[0] >= scores[1] && scores[0] >= scores[2] ? 0
        : scores[1] >= scores[2] ? 1 : 2;
      const player = players[controller];
      const wager = ddWager(config.ddStrategy, scores[controller], values[values.length - 1], config.ddWagerFraction);
      const adjustedP = player.p * dm;
      const correct = Math.random() < adjustedP;
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
      const attempts = correlatedBernoulli(buzzProbs, config.rhoB);

      // For those who attempt, check accuracy with difficulty scaling
      const accuracyProbs = players.map(p => p.p * dm);
      const knowsAnswer = correlatedBernoulli(accuracyProbs, config.rhoP)
        .map((correct, idx) => correct && attempts[idx]);

      const winner = resolveBuzzer(knowsAnswer, players);

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
          );
          if (wrongBuzzer >= 0) {
            const wrongPlayer = attemptPlayers[wrongBuzzer];
            scores[wrongPlayer] -= value;

            // Rebound: remaining players get a chance
            const reboundEligible = players.map((_, idx) =>
              idx !== wrongPlayer && attempts[idx] !== true && Math.random() < players[idx].b,
            );
            const reboundAccuracy = correlatedBernoulli(
              players.map(p => p.p * dm),
              config.rhoP,
            ).map((correct, idx) => correct && reboundEligible[idx]);

            const reboundWinner = resolveBuzzer(reboundAccuracy, players);
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
function simulateFinalJeopardy(
  players: Player[],
  scores: [number, number, number],
  _config: SimConfig,
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
  const correct = correlatedBernoulli(fjProbs, 0.3);

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
): GameResult {
  const players: Player[] = [you, opp1, opp2];
  let scores: [number, number, number] = [0, 0, 0];
  let allHistory: [number, number, number][] = [];
  let allDDEvents: DDEvent[] = [];

  // Jeopardy Round
  const jResult = simulateRound(players, scores, J_VALUES, 'J', config, trackHistory);
  scores = jResult.scores;
  allHistory = allHistory.concat(jResult.history);
  allDDEvents = allDDEvents.concat(jResult.ddEvents);

  // Double Jeopardy Round
  const djResult = simulateRound(players, scores, DJ_VALUES, 'DJ', config, trackHistory);
  scores = djResult.scores;
  allHistory = allHistory.concat(djResult.history);
  allDDEvents = allDDEvents.concat(djResult.ddEvents);

  // Final Jeopardy
  if (config.includeFJ) {
    scores = simulateFinalJeopardy(players, scores, config);
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
export function sampleOpponent(profile: { b: number; p: number; fjAccuracy: number }): Player {
  const jitter = () => (Math.random() - 0.5) * 0.1;
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
): { winRate: number; results?: GameResult[] } {
  let wins = 0;
  const results: GameResult[] = [];

  for (let i = 0; i < nGames; i++) {
    const opp1 = sampleOpponent(opponentProfile);
    const opp2 = sampleOpponent(opponentProfile);
    const result = simulateGame(you, opp1, opp2, config, returnResults);

    if (result.winner === 0) wins++;
    if (returnResults) results.push(result);
  }

  return { winRate: wins / nGames, results: returnResults ? results : undefined };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
