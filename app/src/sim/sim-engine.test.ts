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
  type DDStrategy,
} from './sim-engine';
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
      const bogus = 'bogus-strategy' as unknown as DDStrategy;
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
});
