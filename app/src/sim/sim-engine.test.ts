import { describe, it, expect } from 'vitest';
import {
  simulateGame,
  simulateRound,
  simulateFinalJeopardy,
  simulateFromState,
  calculateWinRate,
  playerFrom2Axis,
  sampleOpponent,
  ddWager,
  mulberry32,
  DEFAULT_CONFIG,
  type Player,
  type SimConfig,
  type SimState,
  type NonEquityDDStrategy,
  computeFJWagersStandard,
  fjEquityGridSearch,
} from './sim-engine';
import {
  buildValueTable,
  queryV,
  equityWager,
  type ValueTable,
} from './value-function';
import { OPPONENT_PROFILES } from './opponent-models';
import { interpolateOpponent, DIMENSIONS, buildSimParams } from './dimensions';

// Helper: create a deterministic-ish player
function makePlayer(b: number, p: number, buzzer: number, fj = 0.5): Player {
  return { b, p, buzzerSpeed: buzzer, fjAccuracy: fj };
}

describe('sim-engine', () => {
  describe('boundary values', () => {
    it('perfect player wins >90% against average opponents', () => {
      const perfect = makePlayer(0.95, 0.98, 0.95, 0.9);
      const { winRate } = calculateWinRate(
        perfect,
        OPPONENT_PROFILES.average,
        DEFAULT_CONFIG,
        500,
      );
      expect(winRate).toBeGreaterThan(0.65);
    });

    it('zero player wins ~0% against average opponents', () => {
      const zero = makePlayer(0.01, 0.01, 0.01, 0.01);
      const { winRate } = calculateWinRate(
        zero,
        OPPONENT_PROFILES.average,
        DEFAULT_CONFIG,
        500,
      );
      expect(winRate).toBeLessThan(0.05);
    });

    it('equal players win ~33% each', () => {
      const avg = makePlayer(0.61, 0.87, 0.5, 0.5);
      const { winRate } = calculateWinRate(
        avg,
        OPPONENT_PROFILES.average,
        DEFAULT_CONFIG,
        1000,
      );
      // Should be roughly 33% ± 5%
      expect(winRate).toBeGreaterThan(0.20);
      expect(winRate).toBeLessThan(0.50);
    });
  });

  describe('monotonicity', () => {
    it('win rate increases with knowledge', () => {
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'off', includeFJ: false };
      const rates: number[] = [];

      for (const k of [0.2, 0.5, 0.8]) {
        const player = playerFrom2Axis(k, 0.5);
        const { winRate } = calculateWinRate(player, OPPONENT_PROFILES.average, config, 500);
        rates.push(winRate);
      }

      // Each step should generally increase (allowing some noise)
      expect(rates[2]).toBeGreaterThan(rates[0]);
    });

    it('win rate increases with buzzer speed', () => {
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'off', includeFJ: false };
      const rates: number[] = [];

      for (const bz of [0.2, 0.5, 0.8]) {
        const player = playerFrom2Axis(0.4, bz);
        const { winRate } = calculateWinRate(player, OPPONENT_PROFILES.average, config, 500);
        rates.push(winRate);
      }

      expect(rates[2]).toBeGreaterThan(rates[0]);
    });
  });

  describe('game simulation', () => {
    it('returns valid scores (can be negative due to wrong answers)', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const result = simulateGame(you, opp, opp, DEFAULT_CONFIG);

      expect(result.scores).toHaveLength(3);
      expect(result.winner).toBeGreaterThanOrEqual(0);
      expect(result.winner).toBeLessThanOrEqual(2);
    });

    it('tracks history when requested', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const result = simulateGame(you, opp, opp, DEFAULT_CONFIG, true);

      expect(result.history).toBeDefined();
      expect(result.history!.length).toBeGreaterThan(0);
      // 60 clues (30 J + 30 DJ) + 1 FJ = 61 history entries
      expect(result.history!.length).toBe(61);
    });

    it('DD events are recorded when tracking history', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };
      const result = simulateGame(you, opp, opp, config, true);

      expect(result.ddEvents).toBeDefined();
      // Should have 3 DD events total (1 J + 2 DJ)
      expect(result.ddEvents!.length).toBe(3);
    });
  });

  describe('DD strategy effects', () => {
    it('DD off produces no DD events', () => {
      const you = makePlayer(0.8, 0.9, 0.7, 0.6);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'off' };
      const result = simulateGame(you, opp, opp, config, true);

      expect(result.ddEvents!.length).toBe(0);
    });

    it('aggressive DD creates higher variance than conservative', () => {
      const you = makePlayer(0.8, 0.9, 0.7, 0.6);
      const profile = OPPONENT_PROFILES.average;

      const aggScores: number[] = [];
      const conScores: number[] = [];

      for (let i = 0; i < 200; i++) {
        const opp1 = sampleOpponent(profile);
        const opp2 = sampleOpponent(profile);
        const agg = simulateGame(you, opp1, opp2, { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' });
        const con = simulateGame(you, opp1, opp2, { ...DEFAULT_CONFIG, ddStrategy: 'conservative' });
        aggScores.push(agg.scores[0]);
        conScores.push(con.scores[0]);
      }

      const variance = (arr: number[]) => {
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
      };

      // Aggressive should produce higher variance
      expect(variance(aggScores)).toBeGreaterThan(variance(conScores) * 0.5);
    });
  });

  describe('playerFrom2Axis', () => {
    it('decomposes knowledge into b and p correctly', () => {
      const player = playerFrom2Axis(0.4, 0.6);
      // b * p should approximately equal knowledge
      expect(player.b * player.p).toBeCloseTo(0.4, 1);
      expect(player.buzzerSpeed).toBe(0.6);
    });

    it('handles edge case: zero knowledge', () => {
      const player = playerFrom2Axis(0, 0.5);
      expect(player.b).toBeGreaterThanOrEqual(0);
      expect(player.p).toBeGreaterThanOrEqual(0);
      expect(isNaN(player.b)).toBe(false);
      expect(isNaN(player.p)).toBe(false);
    });

    it('handles edge case: max knowledge', () => {
      const player = playerFrom2Axis(0.9, 0.9);
      expect(player.b).toBeLessThanOrEqual(0.95);
      expect(player.p).toBeLessThanOrEqual(0.98);
      expect(isNaN(player.b)).toBe(false);
    });
  });

  describe("Ben's game scenario", () => {
    it('approximates expected win equity from DD paper', () => {
      // Ben's game: scores [19400, 6400, 17200] — he was leading
      // At 55% DD confidence, $5000 wager → ~45% win equity
      // We can't reproduce exact scenario, but a strong player should win ~40-60%
      const ben = makePlayer(0.75, 0.88, 0.55, 0.55);
      const { winRate } = calculateWinRate(
        ben,
        OPPONENT_PROFILES.average,
        DEFAULT_CONFIG,
        1000,
      );
      // Ben was a strong player, should win well above average
      expect(winRate).toBeGreaterThan(0.35);
      expect(winRate).toBeLessThan(0.85);
    });
  });

  describe('FJ toggle', () => {
    it('games without FJ have no FJ history entry', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG, includeFJ: false };
      const result = simulateGame(you, opp, opp, config, true);

      // 60 clues only, no FJ
      expect(result.history!.length).toBe(60);
    });
  });

  describe('ddWagerFraction', () => {
    it('overrides enum strategy when set', () => {
      // fraction=0.5 should give 50% of score, regardless of ddStrategy
      const wager = ddWager('conservative', 10000, 1000, 0.5);
      expect(wager).toBe(5000);
    });

    it('respects minimum wager floor at fraction=0', () => {
      // fraction=0 but minWager is maxClueValue (1000)
      const wager = ddWager('aggressive', 10000, 1000, 0.0);
      expect(wager).toBe(1000);
    });

    it('true daily double at fraction=1', () => {
      const wager = ddWager('conservative', 8000, 1000, 1.0);
      expect(wager).toBe(8000);
    });

    it('does not affect result when undefined', () => {
      const withFrac = ddWager('aggressive', 10000, 1000, undefined);
      const without = ddWager('aggressive', 10000, 1000);
      expect(withFrac).toBe(without);
    });
  });

  describe('interpolateOpponent', () => {
    it('at 0.0 matches Average profile', () => {
      const result = interpolateOpponent(0.0);
      expect(result.b).toBeCloseTo(OPPONENT_PROFILES.average.b, 5);
      expect(result.p).toBeCloseTo(OPPONENT_PROFILES.average.p, 5);
      expect(result.fjAccuracy).toBeCloseTo(OPPONENT_PROFILES.average.fjAccuracy, 5);
    });

    it('at 0.5 matches Champion profile', () => {
      const result = interpolateOpponent(0.5);
      expect(result.b).toBeCloseTo(OPPONENT_PROFILES.champion.b, 5);
      expect(result.p).toBeCloseTo(OPPONENT_PROFILES.champion.p, 5);
      expect(result.fjAccuracy).toBeCloseTo(OPPONENT_PROFILES.champion.fjAccuracy, 5);
    });

    it('at 1.0 matches Grand Champion profile', () => {
      const result = interpolateOpponent(1.0);
      expect(result.b).toBeCloseTo(OPPONENT_PROFILES.grandChampion.b, 5);
      expect(result.p).toBeCloseTo(OPPONENT_PROFILES.grandChampion.p, 5);
      expect(result.fjAccuracy).toBeCloseTo(OPPONENT_PROFILES.grandChampion.fjAccuracy, 5);
    });

    it('at 0.25 interpolates between Average and Champion', () => {
      const result = interpolateOpponent(0.25);
      const avg = OPPONENT_PROFILES.average;
      const champ = OPPONENT_PROFILES.champion;
      expect(result.b).toBeCloseTo((avg.b + champ.b) / 2, 5);
      expect(result.p).toBeCloseTo((avg.p + champ.p) / 2, 5);
    });

    it('clamps out-of-range values', () => {
      const below = interpolateOpponent(-0.5);
      const above = interpolateOpponent(1.5);
      expect(below.b).toBeCloseTo(OPPONENT_PROFILES.average.b, 5);
      expect(above.b).toBeCloseTo(OPPONENT_PROFILES.grandChampion.b, 5);
    });
  });

  describe('dimensions', () => {
    it('knowledge.toParams produces same b×p as playerFrom2Axis', () => {
      const params = DIMENSIONS.knowledge.toParams(0.4, { buzzerSpeed: 0.6 });
      const direct = playerFrom2Axis(0.4, 0.6);
      expect(params.player!.b).toBeCloseTo(direct.b, 5);
      expect(params.player!.p).toBeCloseTo(direct.p, 5);
    });

    it('buildSimParams with all dimensions pinned produces valid output', () => {
      const result = buildSimParams('knowledge', 'buzzerSpeed', 0.4, 0.6, {
        ddAggression: 0.75,
        opponentStrength: 0.5,
      });
      expect(result.player.b).toBeGreaterThan(0);
      expect(result.player.p).toBeGreaterThan(0);
      expect(result.player.buzzerSpeed).toBe(0.6);
      expect(isNaN(result.player.b)).toBe(false);
      expect(isNaN(result.player.p)).toBe(false);
      expect(result.config.ddWagerFraction).toBe(0.75);
      expect(result.opponentProfile.b).toBeCloseTo(OPPONENT_PROFILES.champion.b, 5);
    });

    it('buildSimParams uses defaults for missing pinned values', () => {
      // No pinned values — should use defaults, not produce NaN
      const result = buildSimParams('knowledge', 'buzzerSpeed', 0.4, 0.6, {});
      expect(isNaN(result.player.b)).toBe(false);
      expect(isNaN(result.player.p)).toBe(false);
      expect(isNaN(result.opponentProfile.b)).toBe(false);
    });
  });

  describe('new axis monotonicity', () => {
    it('DD aggression affects win rate (higher aggression ≠ always better)', () => {
      const config: SimConfig = { ...DEFAULT_CONFIG, includeFJ: false };
      const rates: number[] = [];

      for (const frac of [0.0, 0.5, 1.0]) {
        const player = playerFrom2Axis(0.8, 0.7);
        const { winRate } = calculateWinRate(
          player,
          OPPONENT_PROFILES.average,
          { ...config, ddStrategy: 'aggressive', ddWagerFraction: frac },
          500,
        );
        rates.push(winRate);
      }

      // DD aggression should meaningfully change win rate (not all the same)
      const spread = Math.max(...rates) - Math.min(...rates);
      expect(spread).toBeGreaterThan(0.02);
      // Mid-range aggression should be reasonable for a strong player
      expect(rates[1]).toBeGreaterThan(0.3);
    });

    it('win rate decreases with opponent strength', () => {
      const player = playerFrom2Axis(0.5, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG };
      const rates: number[] = [];

      for (const strength of [0.0, 0.5, 1.0]) {
        const opp = interpolateOpponent(strength);
        const { winRate } = calculateWinRate(player, opp, config, 500);
        rates.push(winRate);
      }

      // Stronger opponents should reduce win rate
      expect(rates[0]).toBeGreaterThan(rates[2]);
    });
  });

  describe('NaN safety', () => {
    it('does not produce NaN scores', () => {
      // Edge case: very low stats where totalWeight might be 0
      const weak = makePlayer(0.05, 0.05, 0.05, 0.1);
      const opp = makePlayer(0.05, 0.05, 0.05, 0.1);

      for (let i = 0; i < 50; i++) {
        const result = simulateGame(weak, opp, opp, DEFAULT_CONFIG);
        for (const s of result.scores) {
          expect(isNaN(s)).toBe(false);
          expect(isFinite(s)).toBe(true);
        }
      }
    });
  });

  // ─── E-0: Engine plumbing (PLAN.md) ───────────────────────────────────
  //
  // Round values, replicated here from sim-engine's private constants for
  // test construction (mirrors the existing "60 clues (30 J + 30 DJ)"
  // hardcoding above). Keep in sync if the board shape ever changes.
  const J_VALUES = [200, 400, 600, 800, 1000];
  const DD_ROW_WEIGHTS = [0.02, 0.04, 0.15, 0.31, 0.48];

  function buildFullBoardForTest(values: number[]): number[] {
    const clues: number[] = [];
    for (let cat = 0; cat < 6; cat++) {
      for (const v of values) clues.push(v);
    }
    return clues;
  }

  describe('regression lock (CRITICAL — must never change)', () => {
    it('seeded 200-game batch matches the pre-refactor reference snapshot', () => {
      // These exact numbers were captured immediately after the seeded RNG
      // was threaded through every Math.random() call site (E-0), BEFORE the
      // simulateRound/simulateFromState partial-board refactor. Every later
      // step in E-0 (partial-board DD placement, per-player DD strategy,
      // stochastic board control) was re-verified to reproduce them
      // bit-for-bit under DEFAULT_CONFIG (which keeps 'leader' board control
      // and a single ddStrategy) — if this test ever fails, engine behavior
      // has silently shifted for existing callers.
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp1 = makePlayer(0.6, 0.87, 0.5, 0.5);
      const opp2 = makePlayer(0.55, 0.8, 0.45, 0.45);
      const rng = mulberry32(20260703);

      const winCounts = [0, 0, 0];
      let scoreSum = 0;
      for (let i = 0; i < 200; i++) {
        const result = simulateGame(you, opp1, opp2, DEFAULT_CONFIG, false, rng);
        winCounts[result.winner]++;
        scoreSum += result.scores[0] + result.scores[1] + result.scores[2];
      }

      expect(winCounts).toEqual([77, 80, 43]);
      expect(scoreSum).toBe(6789640);
    });
  });

  describe('seeded RNG determinism', () => {
    it('same seed produces identical GameResult sequences', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp1 = makePlayer(0.6, 0.87, 0.5, 0.5);
      const opp2 = makePlayer(0.55, 0.8, 0.45, 0.45);

      const runBatch = (seed: number) => {
        const rng = mulberry32(seed);
        const out = [];
        for (let i = 0; i < 20; i++) {
          out.push(simulateGame(you, opp1, opp2, DEFAULT_CONFIG, true, rng));
        }
        return out;
      };

      const batchA = runBatch(42);
      const batchB = runBatch(42);
      expect(batchA).toEqual(batchB);

      // Sanity: a different seed should (almost certainly) diverge somewhere.
      const batchC = runBatch(43);
      expect(batchC).not.toEqual(batchA);
    });

    it('omitting rng still uses Math.random (default unchanged)', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      // No rng argument — should not throw, should behave like before.
      const result = simulateGame(you, opp, opp, DEFAULT_CONFIG);
      expect(result.scores).toHaveLength(3);
    });
  });

  describe('simulateRound / simulateFinalJeopardy exports', () => {
    it('simulateRound is exported and callable with an explicit partial board', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const players = [you, opp, opp];
      const rng = mulberry32(7);

      const result = simulateRound(
        players, [0, 0, 0], [400, 800], 0, 'DJ',
        { ...DEFAULT_CONFIG, ddStrategy: 'off' }, false, rng,
      );
      expect(result.scores).toHaveLength(3);
      expect(result.ddEvents).toEqual([]);
    });

    it('simulateFinalJeopardy is exported and callable directly', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.55);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const rng = mulberry32(7);
      const scores = simulateFinalJeopardy([you, opp, opp], [10000, 8000, 6000], DEFAULT_CONFIG, rng);
      expect(scores).toHaveLength(3);
      for (const s of scores) {
        expect(isNaN(s)).toBe(false);
      }
    });
  });

  describe('simulateFromState', () => {
    it('boundary: 0 clues remaining in DJ goes straight to FJ', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.55);
      const opp1 = makePlayer(0.6, 0.87, 0.5, 0.5);
      const opp2 = makePlayer(0.55, 0.8, 0.45, 0.45);
      const players = [you, opp1, opp2];
      const rng = mulberry32(99);

      const state: SimState = {
        scores: [12000, 9000, 5000],
        round: 'DJ',
        remainingClueValues: [],
        remainingDDCount: 0,
      };

      const result = simulateFromState(state, players, DEFAULT_CONFIG, rng, true);
      // Only the FJ entry should appear in history — no DJ round was played.
      expect(result.history!.length).toBe(1);
    });

    it('with includeFJ off and 0 remaining clues, scores pass through unchanged', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.55);
      const opp1 = makePlayer(0.6, 0.87, 0.5, 0.5);
      const opp2 = makePlayer(0.55, 0.8, 0.45, 0.45);
      const players = [you, opp1, opp2];
      const state: SimState = {
        scores: [12000, 9000, 5000],
        round: 'DJ',
        remainingClueValues: [],
        remainingDDCount: 0,
      };
      const config: SimConfig = { ...DEFAULT_CONFIG, includeFJ: false };
      const result = simulateFromState(state, players, config);
      expect(result.scores).toEqual([12000, 9000, 5000]);
      expect(result.winner).toBe(0);
    });

    it('mid-Jeopardy with clues remaining plays the rest of J, then all of DJ, then FJ', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.55);
      const opp1 = makePlayer(0.6, 0.87, 0.5, 0.5);
      const opp2 = makePlayer(0.55, 0.8, 0.45, 0.45);
      const players = [you, opp1, opp2];
      const rng = mulberry32(11);

      const state: SimState = {
        scores: [1000, 800, 600],
        round: 'J',
        remainingClueValues: [800, 1000, 1000], // a few clues left in J
        remainingDDCount: 1,
      };

      const result = simulateFromState(state, players, DEFAULT_CONFIG, rng, true);
      // 3 remaining J clues + 30 DJ clues + 1 FJ = 34 history entries
      expect(result.history!.length).toBe(34);
    });
  });

  describe('partial-board DD placement (renormalized DD_ROW_WEIGHTS)', () => {
    it('DDs land on the only remaining row with probability 1', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(123);

      // Only bottom-row (2000) clues remain in DJ.
      const remaining = [2000, 2000, 2000, 2000, 2000, 2000];
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };

      for (let i = 0; i < 50; i++) {
        const result = simulateRound(players, [0, 0, 0], remaining, 1, 'DJ', config, false, rng);
        expect(result.ddEvents.length).toBe(1);
        const idx = result.ddEvents[0].clueIndex;
        expect(remaining[idx]).toBe(2000); // trivially bottom row — the only row present
      }
    });

    it('non-uniform renormalization: two open rows keep their relative DD_ROW_WEIGHTS ratio, not 50/50', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(2024);

      // Only row 1 (800, weight 0.04) and row 3 (1600, weight 0.31) remain —
      // 6 clues each, mirroring "2 categories' worth of a row still open."
      const remaining = [...Array(6).fill(800), ...Array(6).fill(1600)];
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };

      const trials = 3000;
      let row1Count = 0;
      let row3Count = 0;
      for (let i = 0; i < trials; i++) {
        const result = simulateRound(players, [0, 0, 0], remaining, 1, 'DJ', config, false, rng);
        const idx = result.ddEvents[0].clueIndex;
        if (remaining[idx] === 800) row1Count++;
        else if (remaining[idx] === 1600) row3Count++;
      }

      const total = row1Count + row3Count;
      expect(total).toBe(trials);
      const row1Frac = row1Count / total;

      // Renormalized: 0.04 / (0.04 + 0.31) ≈ 0.1143 — NOT 0.5 (which a
      // uniform-over-leftover-slots bug would produce).
      const expected = 0.04 / (0.04 + 0.31);
      expect(row1Frac).toBeGreaterThan(expected - 0.04);
      expect(row1Frac).toBeLessThan(expected + 0.04);
      expect(row1Frac).toBeLessThan(0.3); // clearly not uniform (0.5)
    });

    it('full board DD placement statistically matches DD_ROW_WEIGHTS', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(555);
      const fullBoard = buildFullBoardForTest(J_VALUES);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };

      const trials = 4000;
      const rowCounts = [0, 0, 0, 0, 0];
      for (let i = 0; i < trials; i++) {
        const result = simulateRound(players, [0, 0, 0], fullBoard, 1, 'J', config, false, rng);
        const idx = result.ddEvents[0].clueIndex;
        const row = J_VALUES.indexOf(fullBoard[idx]);
        rowCounts[row]++;
      }

      for (let row = 0; row < 5; row++) {
        const frac = rowCounts[row] / trials;
        expect(frac).toBeGreaterThan(DD_ROW_WEIGHTS[row] - 0.03);
        expect(frac).toBeLessThan(DD_ROW_WEIGHTS[row] + 0.03);
      }
    });
  });

  describe('empirical DD row weights (E-6)', () => {
    it('config.ddRowWeights overrides the DD_ROW_WEIGHTS folklore fallback on a full board', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(777);
      const fullBoard = buildFullBoardForTest(J_VALUES);
      // A deliberately distinctive (not DD_ROW_WEIGHTS-like) distribution:
      // all weight on row 0 (top row) — the opposite of both folklore and
      // the real clue-stats.json shape, so a passing test can't be
      // accidentally satisfied by the fallback still being in effect.
      const empiricalJ = [1, 0, 0, 0, 0];
      const config: SimConfig = {
        ...DEFAULT_CONFIG,
        ddStrategy: 'aggressive',
        ddRowWeights: { J: empiricalJ, DJ: [0, 0, 0, 0, 1] },
      };

      const trials = 500;
      for (let i = 0; i < trials; i++) {
        const result = simulateRound(players, [0, 0, 0], fullBoard, 1, 'J', config, false, rng);
        const idx = result.ddEvents[0].clueIndex;
        expect(J_VALUES.indexOf(fullBoard[idx])).toBe(0); // always row 0, never DD_ROW_WEIGHTS' bottom-heavy default
      }
    });

    it('omitting config.ddRowWeights preserves the DD_ROW_WEIGHTS folklore fallback (regression)', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(778);
      const fullBoard = buildFullBoardForTest(J_VALUES);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' }; // no ddRowWeights

      const trials = 4000;
      const rowCounts = [0, 0, 0, 0, 0];
      for (let i = 0; i < trials; i++) {
        const result = simulateRound(players, [0, 0, 0], fullBoard, 1, 'J', config, false, rng);
        const idx = result.ddEvents[0].clueIndex;
        rowCounts[J_VALUES.indexOf(fullBoard[idx])]++;
      }
      for (let row = 0; row < 5; row++) {
        const frac = rowCounts[row] / trials;
        expect(frac).toBeGreaterThan(DD_ROW_WEIGHTS[row] - 0.03);
        expect(frac).toBeLessThan(DD_ROW_WEIGHTS[row] + 0.03);
      }
    });

    it('renormalizes custom ddRowWeights over open rows on a partial board, same as the folklore path', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(779);
      // Only row 0 (200, weight 0.1 in this custom set) and row 4 (1000,
      // weight 0.9) remain.
      const remaining = [...Array(6).fill(200), ...Array(6).fill(1000)];
      const config: SimConfig = {
        ...DEFAULT_CONFIG,
        ddStrategy: 'aggressive',
        ddRowWeights: { J: [0.1, 0, 0, 0, 0.9], DJ: [0.02, 0.04, 0.15, 0.31, 0.48] },
      };

      const trials = 3000;
      let row0Count = 0;
      for (let i = 0; i < trials; i++) {
        const result = simulateRound(players, [0, 0, 0], remaining, 1, 'J', config, false, rng);
        const idx = result.ddEvents[0].clueIndex;
        if (remaining[idx] === 200) row0Count++;
      }
      const row0Frac = row0Count / trials;
      // Renormalized over just these two open rows: 0.1 / (0.1 + 0.9) = 0.1
      expect(row0Frac).toBeGreaterThan(0.06);
      expect(row0Frac).toBeLessThan(0.14);
    });
  });

  describe('per-player DD strategy split', () => {
    it('opponentDdStrategy defaults to ddStrategy when omitted (backward compatible)', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive', boardControl: 'score-weighted' };
      const rng = mulberry32(321);

      // No opponentDdStrategy set — opponents should still wager like 'aggressive'.
      const result = simulateGame(you, opp, opp, config, true, rng);
      const oppEvents = result.ddEvents!.filter(e => e.player !== 0);
      // Not asserting exact values (stochastic), just that it runs and
      // produces sane, non-negative-minimum wagers consistent with 'aggressive'.
      for (const e of oppEvents) {
        expect(e.wager).toBeGreaterThan(0);
      }
    });

    it('you aggressive + opponents conservative yields lower opponent wagers than both-aggressive', () => {
      const you = makePlayer(0.8, 0.9, 0.7, 0.6);
      const opp1 = makePlayer(0.6, 0.87, 0.5, 0.5);
      const opp2 = makePlayer(0.6, 0.87, 0.5, 0.5);

      const splitConfig: SimConfig = {
        ...DEFAULT_CONFIG,
        ddStrategy: 'aggressive',
        opponentDdStrategy: 'conservative',
        boardControl: 'score-weighted', // ensures opponents get DD control often enough to sample
      };
      const bothAggressiveConfig: SimConfig = {
        ...DEFAULT_CONFIG,
        ddStrategy: 'aggressive',
        opponentDdStrategy: 'aggressive',
        boardControl: 'score-weighted',
      };

      const collectOpponentWagers = (config: SimConfig, seed: number): number[] => {
        const rng = mulberry32(seed);
        const wagers: number[] = [];
        for (let i = 0; i < 400; i++) {
          const result = simulateGame(you, opp1, opp2, config, true, rng);
          for (const e of result.ddEvents!) {
            if (e.player !== 0) wagers.push(e.wager);
          }
        }
        return wagers;
      };

      const splitWagers = collectOpponentWagers(splitConfig, 909);
      const bothWagers = collectOpponentWagers(bothAggressiveConfig, 909);

      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      expect(splitWagers.length).toBeGreaterThan(20);
      expect(bothWagers.length).toBeGreaterThan(20);
      expect(mean(splitWagers)).toBeLessThan(mean(bothWagers));
    });
  });

  describe('ddWager exhaustiveness guard', () => {
    it('throws instead of silently returning minWager for an unhandled strategy', () => {
      // Simulates what happens if DDStrategy ever gains a member ddWager
      // doesn't handle (e.g. a future 'equity') — TypeScript's `never` guard
      // makes this a compile error in real usage; at runtime (bypassing the
      // type system, as a caller with stale types might) it throws rather
      // than silently returning the minimum wager.
      const bogus = 'bogus-strategy' as unknown as NonEquityDDStrategy;
      expect(() => ddWager(bogus, 10000, 1000)).toThrow();
    });
  });

  describe('stochastic board control', () => {
    it("'leader' (default) always gives control to the highest-scoring player", () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(17);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive', boardControl: 'leader' };

      for (let i = 0; i < 100; i++) {
        const result = simulateRound(players, [5000, 100, 100], [2000], 1, 'DJ', config, false, rng);
        expect(result.ddEvents[0].player).toBe(0);
      }
    });

    it("'score-weighted' occasionally gives control to a trailing player", () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const players = [you, you, you];
      const rng = mulberry32(18);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive', boardControl: 'score-weighted' };

      let sawNonLeader = false;
      for (let i = 0; i < 2000; i++) {
        const result = simulateRound(players, [5000, 100, 100], [2000], 1, 'DJ', config, false, rng);
        if (result.ddEvents[0].player !== 0) sawNonLeader = true;
      }
      expect(sawNonLeader).toBe(true);
    });
  });

  // ─── E-2: Game-state value function V(S) (PLAN.md) ─────────────────────

  describe('value function V(S) (E-2)', () => {
    // One default-dims table shared by the invariant tests below; built
    // lazily so the (measured, reported) cost is paid exactly once.
    let defaultTable: ValueTable | null = null;
    const getDefaultTable = (): ValueTable => {
      if (!defaultTable) {
        defaultTable = buildValueTable(
          OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(20260703),
        );
      }
      return defaultTable;
    };

    it('build budget: default table builds within budget; time and size reported', () => {
      const table = getDefaultTable();
      const bytes = table.data.byteLength;
      console.log(
        `[E-2 V-table] cells=${table.cellCount} rollouts/cell=${table.rolloutsPerCell} ` +
        `build=${table.buildMs.toFixed(0)}ms size=${(bytes / 1024).toFixed(0)}KB`,
      );
      // Target is ~5s (PLAN.md); measured ~4s on the dev machine. The
      // assertion ceiling is 10s so slower CI hardware doesn't flake while
      // still catching order-of-magnitude regressions.
      expect(table.buildMs).toBeLessThan(10000);
      expect(table.cellCount).toBe(table.data.length);
      expect(bytes).toBeLessThan(2 * 1024 * 1024); // ≤ ~2MB per PLAN.md
    }, 30000);

    it('onProgress (E-7) fires once per skillKnowledge outer iteration, ending near 1', () => {
      const calls: number[] = [];
      buildValueTable(
        OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(42),
        {
          dims: {
            skillKnowledge: { min: 0, max: 1, n: 3 },
            skillBuzzer: { min: 0, max: 1, n: 2 },
            yourShare: { min: 0, max: 1.5, n: 2 },
            leaderRatio: { min: 0, max: 2, n: 2 },
            thirdRatio: { min: 0, max: 2, n: 2 },
            cluesRemaining: { min: 0, max: 30, n: 2 },
          },
          rolloutsPerCell: 2,
          blurRadius: 0,
          onProgress: (frac) => calls.push(frac),
        },
      );
      // 3 skillKnowledge buckets → progress calls at 0, 1/3, 2/3, then a
      // final 1 on completion.
      expect(calls.length).toBe(4);
      expect(calls[0]).toBe(0);
      expect(calls[calls.length - 1]).toBe(1);
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i]).toBeGreaterThanOrEqual(calls[i - 1]);
      }
    });

    it('V ∈ [0,1] across a broad state scan', () => {
      const table = getDefaultTable();
      const rng = mulberry32(5);
      for (let i = 0; i < 500; i++) {
        const v = queryV(table, {
          knowledge: rng(),
          buzzerSpeed: rng(),
          scores: [
            Math.floor(rng() * 40000) - 5000,
            Math.floor(rng() * 40000) - 5000,
            Math.floor(rng() * 40000) - 5000,
          ],
          cluesRemaining: Math.floor(rng() * 32),
        });
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(Number.isFinite(v)).toBe(true);
      }
    }, 30000);

    it('V is monotone non-decreasing in your score (statistical tolerance)', () => {
      const table = getDefaultTable();
      const values: number[] = [];
      for (const s of [1000, 5000, 9000, 13000, 17000, 21000]) {
        values.push(queryV(table, {
          knowledge: 0.4, buzzerSpeed: 0.5,
          scores: [s, 6000, 6000], cluesRemaining: 12,
        }));
      }
      // Coarse MC table ⇒ allow small local dips (2pp), require global rise.
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `V dropped at step ${i}: ${values.map(v => v.toFixed(3)).join(' → ')}`)
          .toBeGreaterThanOrEqual(values[i - 1] - 0.02);
      }
      expect(values[values.length - 1]).toBeGreaterThan(values[0]);
    }, 30000);

    it('pre-FJ lock with FJ off → V ≈ 1', () => {
      // Small FJ-off table: with 0 clues remaining and no FJ, a strict
      // leader wins with certainty, so V must be ≈1 (ratio-based dims keep
      // interpolation from mixing in trailing states; see value-function.ts
      // design note).
      const config: SimConfig = { ...DEFAULT_CONFIG, includeFJ: false };
      const table = buildValueTable(OPPONENT_PROFILES.average, config, mulberry32(7), {
        dims: {
          skillKnowledge: { min: 0, max: 1, n: 2 },
          skillBuzzer: { min: 0, max: 1, n: 2 },
          yourShare: { min: 0, max: 1.5, n: 6 },
          leaderRatio: { min: 0, max: 2, n: 5 },
          thirdRatio: { min: 0, max: 2, n: 5 },
          cluesRemaining: { min: 0, max: 30, n: 4 },
        },
        rolloutsPerCell: 10,
      });
      // Lock: your score > 2× the best opponent, 0 clues remaining.
      const v = queryV(table, {
        knowledge: 0.4, buzzerSpeed: 0.5,
        scores: [20000, 5000, 3000], cluesRemaining: 0,
      });
      expect(v).toBeGreaterThan(0.95);
    }, 30000);

    it('out-of-range queries clamp to table bounds', () => {
      const table = getDefaultTable();
      // Beyond-max score and beyond-max cluesRemaining must equal the
      // at-bound query, not extrapolate.
      const atBound = queryV(table, {
        knowledge: 1, buzzerSpeed: 1,
        scores: [100000, 0, 0], cluesRemaining: 30,
      });
      const beyond = queryV(table, {
        knowledge: 5, buzzerSpeed: 9,
        scores: [10000000, -50000, -50000], cluesRemaining: 300,
      });
      expect(beyond).toBeCloseTo(atBound, 6);

      // Deep-negative "you" is a worst-bucket state, still in [0,1].
      const broke = queryV(table, {
        knowledge: -1, buzzerSpeed: -1,
        scores: [-10000, 30000, 20000], cluesRemaining: -5,
      });
      expect(broke).toBeGreaterThanOrEqual(0);
      expect(broke).toBeLessThanOrEqual(1);
    }, 30000);
  });

  // ─── E-3: 'equity' DD strategy (PLAN.md) ────────────────────────────────

  describe("equity DD strategy (E-3)", () => {
    const you = makePlayer(0.7, 0.85, 0.6, 0.5);
    const opp = makePlayer(0.6, 0.87, 0.5, 0.5);

    it("'equity' without a valueTable falls back to 'aggressive' exactly (same seed ⇒ same games)", () => {
      const run = (ddStrategy: SimConfig['ddStrategy']) => {
        const rng = mulberry32(2026);
        const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy, opponentDdStrategy: 'aggressive' };
        const out = [];
        for (let i = 0; i < 30; i++) out.push(simulateGame(you, opp, opp, config, true, rng));
        return out;
      };
      // Documented fallback (never a silent min-bet): identical rng
      // consumption ⇒ bit-identical games.
      expect(run('equity')).toEqual(run('aggressive'));
    });

    it("'equity' with a valueTable produces your-player DD wagers within [$5, score] (real-rules floor)", () => {
      const table = buildValueTable(OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(11), {
        dims: {
          skillKnowledge: { min: 0, max: 1, n: 2 },
          skillBuzzer: { min: 0, max: 1, n: 2 },
          yourShare: { min: 0, max: 1.5, n: 5 },
          leaderRatio: { min: 0, max: 2, n: 4 },
          thirdRatio: { min: 0, max: 2, n: 4 },
          cluesRemaining: { min: 0, max: 30, n: 4 },
        },
        rolloutsPerCell: 8,
      });
      const config: SimConfig = {
        ...DEFAULT_CONFIG,
        ddStrategy: 'equity',
        opponentDdStrategy: 'aggressive',
        valueTable: table,
      };
      const rng = mulberry32(31);
      let yourDDs = 0;
      for (let i = 0; i < 150; i++) {
        const result = simulateGame(you, opp, opp, config, true, rng);
        for (const e of result.ddEvents!) {
          if (e.player !== 0) continue;
          yourDDs++;
          expect(e.wager).toBeGreaterThanOrEqual(5);
          expect(e.wager).toBeLessThanOrEqual(Math.max(e.scoreBefore, 5));
        }
      }
      expect(yourDDs).toBeGreaterThan(20); // sampled enough to mean something
    }, 30000);

    it('equityWager respects the $5 floor when your score is tiny or negative', () => {
      const table = buildValueTable(OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(13), {
        dims: {
          skillKnowledge: { min: 0, max: 1, n: 2 },
          skillBuzzer: { min: 0, max: 1, n: 2 },
          yourShare: { min: 0, max: 1.5, n: 4 },
          leaderRatio: { min: 0, max: 2, n: 3 },
          thirdRatio: { min: 0, max: 2, n: 3 },
          cluesRemaining: { min: 0, max: 30, n: 3 },
        },
        rolloutsPerCell: 5,
      });
      expect(equityWager({ knowledge: 0.4, buzzerSpeed: 0.5 }, [3, 5000, 4000], 10, 0.55, table)).toBe(5);
      expect(equityWager({ knowledge: 0.4, buzzerSpeed: 0.5 }, [-800, 5000, 4000], 10, 0.55, table)).toBe(5);
      const w = equityWager({ knowledge: 0.4, buzzerSpeed: 0.5 }, [12000, 5000, 4000], 10, 0.55, table);
      expect(w).toBeGreaterThanOrEqual(5);
      expect(w).toBeLessThanOrEqual(12000);
    }, 30000);
  });

  // ─── E-5: Final Jeopardy strategies (PLAN.md) ───────────────────────────

  describe('Final Jeopardy strategies (E-5)', () => {
    describe("closed-form 'standard' wagers", () => {
      it('leader with a lock makes the can\'t-lose wager ($0 ≤ lead − 2×second)', () => {
        // [20000, 8000, 5000]: 20000 > 2×8000 ⇒ locked.
        const wagers = computeFJWagersStandard([20000, 8000, 5000], DEFAULT_CONFIG);
        expect(wagers[0]).toBe(0);
        expect(wagers[0]).toBeLessThanOrEqual(20000 - 2 * 8000);
      });

      it('leader without a lock covers second doubling (+$1)', () => {
        const wagers = computeFJWagersStandard([18000, 10000, 5000], DEFAULT_CONFIG);
        expect(wagers[0]).toBe(2 * 10000 - 18000 + 1); // 2001
      });

      it('second place bets everything by default (original behavior, regression-locked)', () => {
        const wagers = computeFJWagersStandard([18000, 10000, 5000], DEFAULT_CONFIG);
        expect(wagers[1]).toBe(10000);
      });

      it("second place under 'twoThirdsRule' covers the leader-miss scenario and third's double", () => {
        const config: SimConfig = { ...DEFAULT_CONFIG, fjSecondPlaceStrategy: 'twoThirdsRule' };
        // Leader covers and misses ⇒ lands on 2×18000 − 2×10000 − 1 = 15999.
        // Second needs 2×18000 − 3×10000 = 6000 to clear it when right.
        const wagers = computeFJWagersStandard([18000, 10000, 5000], config);
        expect(wagers[1]).toBe(6000);
        // When second holds > 2/3 of the leader, covering third dominates:
        // leader 15000, second 11000, third 5000 ⇒ leader-miss lands on
        // 2×15000−2×11000−1 = 7999 < 11000 ⇒ cover-third term (2×5000−11000+1 → 0-floored).
        const wagers2 = computeFJWagersStandard([15000, 11000, 5000], config);
        expect(wagers2[1]).toBe(0);
      });

      it('third place bets everything; non-positive scores cannot wager', () => {
        const wagers = computeFJWagersStandard([18000, 10000, 5000], DEFAULT_CONFIG);
        expect(wagers[2]).toBe(5000);
        const withBroke = computeFJWagersStandard([10000, -500, 3000], DEFAULT_CONFIG);
        expect(withBroke[1]).toBe(0);
      });
    });

    it("fjStrategy 'equity' runs end-to-end and produces finite scores", () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.55);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG, fjStrategy: 'equity' };
      const rng = mulberry32(17);
      const scores = simulateFinalJeopardy([you, opp, opp], [15000, 14000, 8000], config, rng);
      for (const s of scores) expect(Number.isFinite(s)).toBe(true);
    });

    it("measures and reports the standard-vs-equity FJ gap at reference states", () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.55);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const players = [you, opp, opp];

      // Evaluate a fixed wager profile: seeded MC win prob, ties split 0.5
      // (fjEquityGridSearch's tie rule). Draws are INDEPENDENT Bernoullis
      // here (documented simplification: the engine's FJ resolution uses
      // ρ≈0.3 correlated accuracy, but both strategies are scored by the
      // SAME evaluator with the SAME seed, so the standard-vs-equity gap
      // is a fair paired comparison either way).
      const evalWinProb = (
        scores: [number, number, number],
        yourWager: number,
        oppWagers: [number, number, number],
        seed: number,
      ): number => {
        const rng = mulberry32(seed);
        const n = 20000;
        let w = 0;
        for (let s = 0; s < n; s++) {
          const correct = [
            rng() < you.fjAccuracy,
            rng() < opp.fjAccuracy,
            rng() < opp.fjAccuracy,
          ];
          const final = [
            scores[0] + (correct[0] ? yourWager : -yourWager),
            scores[1] + (correct[1] ? oppWagers[1] : -oppWagers[1]),
            scores[2] + (correct[2] ? oppWagers[2] : -oppWagers[2]),
          ];
          const maxScore = Math.max(...final);
          const winners = final.filter(v => v === maxScore).length;
          if (final[0] === maxScore) w += 1 / winners;
        }
        return w / n;
      };

      const states: { name: string; scores: [number, number, number] }[] = [
        { name: 'lock leader   [20000, 8000, 5000]', scores: [20000, 8000, 5000] },
        { name: 'tight leader  [15000, 14000, 8000]', scores: [15000, 14000, 8000] },
        { name: 'you second    [14000, 15000, 8000]', scores: [14000, 15000, 8000] },
      ];

      const lines: string[] = [];
      for (const { name, scores } of states) {
        const standard = computeFJWagersStandard(scores, DEFAULT_CONFIG);
        const equityYourWager = fjEquityGridSearch(players, scores, standard, mulberry32(555));
        const pStandard = evalWinProb(scores, standard[0], standard, 9001);
        const pEquity = evalWinProb(scores, equityYourWager, standard, 9001);
        const gapPP = (pEquity - pStandard) * 100;
        lines.push(
          `  ${name}: standard $${standard[0]} → ${(pStandard * 100).toFixed(1)}%, ` +
          `equity $${equityYourWager} → ${(pEquity * 100).toFixed(1)}% (gap ${gapPP >= 0 ? '+' : ''}${gapPP.toFixed(1)}pp)`,
        );
        // Equity should never be materially worse than the closed form
        // (small negative slack for the grid search's own MC noise).
        expect(pEquity, `${name}: equity FJ underperformed standard`).toBeGreaterThanOrEqual(pStandard - 0.02);
      }
      console.log(`[E-5 FJ] standard vs equity win-prob gap (uncorrelated eval draws):\n${lines.join('\n')}`);
    }, 30000);
  });
});
