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
  buildFullBoard,
  createRoundBoard,
  chooseSquare,
  resolveBoardControl,
  lowestScoreIndex,
  DD_SEEK_RETAIN_CONTROL_WEIGHT,
  DJ_VALUES,
  type RoundBoard,
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

    // TODOS "P2 — GameDetail DD event rows": a seeded game's DD events carry
    // the new optional fields GameDetail needs to recompute an
    // equity-optimal wager outside the engine, and scoreAfter is internally
    // consistent with scoreBefore ± wager.
    it('a seeded game returns DD events with the new equity-recomputation fields populated', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };
      const rng = mulberry32(42);
      const result = simulateGame(you, opp, opp, config, true, rng);

      expect(result.ddEvents!.length).toBe(3);
      for (const ev of result.ddEvents!) {
        expect(ev.clueValue).toBeGreaterThan(0);
        expect(ev.scoresBefore).toBeDefined();
        expect(ev.scoresBefore).toHaveLength(3);
        expect(ev.scoresBefore![ev.player]).toBe(ev.scoreBefore);
        expect(ev.cluesRemainingAfter).toBeGreaterThanOrEqual(0);
        expect(ev.adjustedP).toBeGreaterThan(0);
        expect(ev.adjustedP).toBeLessThanOrEqual(1);

        // scoreAfter is exactly scoreBefore ± wager, per correct/wrong.
        const expectedAfter = ev.correct ? ev.scoreBefore + ev.wager : ev.scoreBefore - ev.wager;
        expect(ev.scoreAfter).toBe(expectedAfter);
      }

      // Determinism: same seed, same events (a re-run for GameDetail must be
      // reproducible so repeated clicks on the same game show the same DDs).
      const rng2 = mulberry32(42);
      const result2 = simulateGame(you, opp, opp, config, true, rng2);
      expect(result2.ddEvents).toEqual(result.ddEvents);
    });

    // Task 3: ddDifficultyScaling gates ONLY the Daily Double branch's
    // adjustedP (unlike the existing difficultyScaling flag, which also
    // flattens regular-clue accuracy) — Tesauro 2012 models DD accuracy as
    // its own flat parameter, independent of the clue's row/value.
    describe('ddDifficultyScaling (Task 3)', () => {
      it('false: a seeded game\'s DD adjustedP fields equal the player\'s base precision', () => {
        const you = makePlayer(0.7, 0.85, 0.6, 0.5);
        const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
        const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive', ddDifficultyScaling: false };
        const rng = mulberry32(42);
        const result = simulateGame(you, opp, opp, config, true, rng);

        expect(result.ddEvents!.length).toBe(3);
        for (const ev of result.ddEvents!) {
          const player = ev.player === 0 ? you : opp;
          expect(ev.adjustedP).toBe(player.p);
        }
      });

      it('true (and default/undefined): DD adjustedP fields match the pre-change (row-scaled) values', () => {
        const you = makePlayer(0.7, 0.85, 0.6, 0.5);
        const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
        const baseConfig: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };

        // Pre-change reference: no ddDifficultyScaling field at all.
        const rngA = mulberry32(42);
        const resultDefault = simulateGame(you, opp, opp, baseConfig, true, rngA);

        // Explicit true must reproduce the exact same values (byte-identical).
        const rngB = mulberry32(42);
        const resultExplicitTrue = simulateGame(you, opp, opp, { ...baseConfig, ddDifficultyScaling: true }, true, rngB);

        expect(resultExplicitTrue.ddEvents).toEqual(resultDefault.ddEvents);

        // And these adjustedP values are indeed the row-scaled ones (not
        // equal to base precision — the bottom rows scale it down).
        for (const ev of resultDefault.ddEvents!) {
          const player = ev.player === 0 ? you : opp;
          expect(ev.adjustedP).toBeLessThan(player.p);
        }
      });
    });

    it('the recorded score-state reproduces the same equity-optimal wager equityWager would compute live', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp = makePlayer(0.6, 0.87, 0.5, 0.5);
      const rng = mulberry32(0xf00d);
      const table = buildValueTable(OPPONENT_PROFILES.average, DEFAULT_CONFIG, rng, {
        rolloutsPerCell: 5,
      });

      const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'equity', valueTable: table };
      const gameRng = mulberry32(7);
      const result = simulateGame(you, opp, opp, config, true, gameRng);

      const yourEvents = result.ddEvents!.filter(e => e.player === 0);
      expect(yourEvents.length).toBeGreaterThan(0);

      for (const ev of yourEvents) {
        // The engine records the board it handed to the lock-aware guard.
        expect(ev.lockContext).toBeDefined();
        expect(ev.lockContext!.round).toBe(ev.round);
        expect(ev.lockContext!.remainingClueValues.length).toBe(ev.cluesRemainingAfter);
        const recomputed = equityWager(
          { knowledge: you.b * you.p, buzzerSpeed: you.buzzerSpeed },
          ev.scoresBefore!,
          ev.cluesRemainingAfter!,
          ev.adjustedP!,
          table,
          ev.lockContext,
        );
        // The engine wagered exactly this (it dispatches to the same
        // equityWager with the same inputs before mutating scores).
        expect(ev.wager).toBe(recomputed);
      }
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

  // ─── Board control + DD seeking (TODOS "P2 — DD seeking / square-selection strategy") ──

  /** Empirical DD row priors from app/public/clue-stats.json (E-1/E-6). */
  const EMPIRICAL_DD_ROW_WEIGHTS = {
    J: [0.0003551977267345489, 0.07009235140895098, 0.2418896519062278, 0.3607624911200568, 0.3269003078380298],
    DJ: [0.0014561127613722407, 0.09790902207466946, 0.2785252489952822, 0.3822587221154406, 0.23985089405323548],
  };

  describe('regression lock: legacy board control is byte-identical after the tracked-control refactor', () => {
    // Every literal below was captured by running THIS code against the
    // engine as it stood BEFORE tracked board control / square selection
    // were added (commit b026193). With the new flags at their defaults the
    // refactored simulateRound must reproduce them exactly — same rng call
    // sequence, same arithmetic — across DEFAULT_CONFIG and every legacy
    // config knob (score-weighted control, empirical priors, DD off + no FJ,
    // split wager strategies, partial-board simulateFromState).
    const you = makePlayer(0.75, 0.88, 0.62, 0.55);

    it('12 seeded games under DEFAULT_CONFIG reproduce their pre-change scores exactly', () => {
      const rng = mulberry32(0xbeef);
      const games: number[][] = [];
      for (let i = 0; i < 12; i++) {
        const o1 = sampleOpponent(OPPONENT_PROFILES.average, rng);
        const o2 = sampleOpponent(OPPONENT_PROFILES.champion, rng);
        const r = simulateGame(you, o1, o2, DEFAULT_CONFIG, true, rng);
        games.push([...r.scores, r.winner, r.ddEvents!.length, r.history!.length]);
      }
      expect(games).toEqual([
        [0, 7200, 10400, 2, 3, 61], [0, 3500, 29775, 2, 3, 61], [13125, 9900, 13124, 0, 3, 61],
        [20134, 0, 0, 0, 3, 61], [0, 3199, 20400, 2, 3, 61], [23300, 29288, 0, 1, 3, 61],
        [24001, 0, 23600, 0, 3, 61], [18825, 18000, 23700, 2, 3, 61], [12801, 0, 4650, 0, 3, 61],
        [10001, 10000, 0, 0, 3, 61], [20000, 0, 5067, 0, 3, 61], [0, 0, 42698, 2, 3, 61],
      ]);
    });

    it('300-game seeded aggregates reproduce their pre-change values under every legacy config knob', () => {
      const configs: Record<string, SimConfig> = {
        default: DEFAULT_CONFIG,
        scoreWeighted: { ...DEFAULT_CONFIG, boardControl: 'score-weighted' },
        empirical: { ...DEFAULT_CONFIG, ddRowWeights: EMPIRICAL_DD_ROW_WEIGHTS },
        ddOffNoFJ: { ...DEFAULT_CONFIG, ddStrategy: 'off', includeFJ: false },
        splitStrategies: {
          ...DEFAULT_CONFIG, ddStrategy: 'truedd', opponentDdStrategy: 'conservative', fjSecondPlaceStrategy: 'twoThirdsRule',
        },
      };
      const agg: Record<string, number[]> = {};
      for (const [name, cfg] of Object.entries(configs)) {
        const rng = mulberry32(20260911);
        let sum = 0, wins = 0, ddSum = 0;
        for (let i = 0; i < 300; i++) {
          const o1 = sampleOpponent(OPPONENT_PROFILES.average, rng);
          const o2 = sampleOpponent(OPPONENT_PROFILES.average, rng);
          const r = simulateGame(you, o1, o2, cfg, true, rng);
          sum += r.scores[0] * 3 + r.scores[1] * 5 + r.scores[2] * 7;
          if (r.winner === 0) wins++;
          for (const e of r.ddEvents!) ddSum += e.wager * (e.correct ? 1 : -1) + e.clueIndex + e.player * 1000;
        }
        agg[name] = [sum, wins, ddSum];
      }
      expect(agg).toEqual({
        default: [53389904, 125, 1648707],
        scoreWeighted: [55678053, 124, 1894481],
        empirical: [60787587, 119, 2826176],
        ddOffNoFJ: [52647000, 128, 0],
        splitStrategies: [52434934, 100, 1579196],
      });
    });

    it('partial-board simulateFromState reproduces its pre-change results exactly', () => {
      const rng = mulberry32(777);
      const state: SimState = {
        scores: [4200, 3800, 1000], round: 'J',
        remainingClueValues: [800, 1000, 600, 1000, 800, 200, 400], remainingDDCount: 1,
      };
      const out: number[][] = [];
      for (let i = 0; i < 5; i++) {
        const r = simulateFromState(state, [you, you, sampleOpponent(OPPONENT_PROFILES.average, rng)], DEFAULT_CONFIG, rng, true);
        out.push([...r.scores, r.winner, r.history!.length]);
      }
      expect(out).toEqual([
        [13200, 15496, 0, 1, 38], [22250, 0, 0, 0, 38], [9575, 11600, 10400, 1, 38],
        [0, 3199, 25200, 2, 38], [0, 0, 26501, 2, 38],
      ]);
    });

    it('legacy results expose playOrder 0..29 per round and no tracked controller (-1)', () => {
      const rng = mulberry32(5);
      const r = simulateGame(you, you, you, DEFAULT_CONFIG, true, rng);
      expect(r.playOrder).toEqual([...Array(30).keys(), ...Array(30).keys()]);
      expect(r.controllers!.every(c => c === -1)).toBe(true);
    });
  });

  describe('tracked board control follows the rules', () => {
    // rhoB = rhoP = 0 makes every draw a plain `rng() < p` Bernoulli, and
    // difficultyScaling: false keeps p unscaled, so players with b, p ∈ {0, 1}
    // script the outcome of every clue exactly.
    const scripted: SimConfig = {
      ...DEFAULT_CONFIG, boardControl: 'tracked', ddStrategy: 'off', rhoB: 0, rhoP: 0, difficultyScaling: false,
    };
    const alwaysRight = makePlayer(1, 1, 0.5);
    const neverBuzzes = makePlayer(0, 1, 0.5);
    const alwaysWrong = makePlayer(1, 0, 0.5);

    it('a correct answer takes the board; the answerer then picks every following square', () => {
      const r = simulateRound(
        [neverBuzzes, alwaysRight, neverBuzzes], [0, 0, 0], buildFullBoard(J_VALUES), 0, 'J',
        scripted, true, mulberry32(1), /* initialController */ 2,
      );
      expect(r.controllers[0]).toBe(2);
      for (let k = 1; k < 30; k++) expect(r.controllers[k]).toBe(1);
    });

    it('nobody buzzes: the previous controller keeps the board all round', () => {
      const r = simulateRound(
        [neverBuzzes, neverBuzzes, neverBuzzes], [0, 0, 0], buildFullBoard(DJ_VALUES), 0, 'DJ',
        scripted, true, mulberry32(2), 1,
      );
      expect(r.controllers).toEqual(Array(30).fill(1));
      expect(r.scores).toEqual([0, 0, 0]);
    });

    it('everyone wrong and no successful rebound: the previous controller keeps the board', () => {
      // All three buzz and miss; nobody is left to rebound (rebound needs a
      // player who did NOT attempt), so control never moves.
      const r = simulateRound(
        [alwaysWrong, alwaysWrong, alwaysWrong], [0, 0, 0], buildFullBoard(J_VALUES), 0, 'J',
        scripted, true, mulberry32(3), 0,
      );
      expect(r.controllers).toEqual(Array(30).fill(0));
      // Sanity that clues really were missed (penalties applied).
      expect(r.scores[0] + r.scores[1] + r.scores[2]).toBeLessThan(0);
    });

    it('a wrong buzz followed by a correct rebound hands the board to the rebounder', () => {
      // Scripted rng: a queue of draws for clue 1, then a constant 0.5.
      // With rhoB = rhoP = 0 the engine's draw order on a regular clue is:
      // 3 attempt draws, 3 accuracy draws, [buzz race], [wrong-buzzer race],
      // rebound-eligibility draws for non-attempters, 3 rebound-accuracy
      // draws, [rebound race] — the same order the seeded regression lock
      // already pins.
      const fastDunce = makePlayer(1, 0, 1);      // always buzzes, always wrong
      const halfGenius = makePlayer(0.5, 1, 1);   // attempts half the time, always right
      const queue = [
        0.5, 0.9, 0.5,   // attempts: dunce yes (any < 1), genius NO (0.9 ≥ 0.5), never-buzzes no
        0.5, 0.5, 0.5,   // accuracy: dunce wrong (p = 0), others right (p = 1) — but they didn't attempt
        0.5,             // wrong-buzzer race among attempters ([dunce])
        0.1, 0.5,        // rebound eligibility: genius YES (0.1 < 0.5), never-buzzes no (b = 0)
        0.5, 0.5, 0.5,   // rebound accuracy: genius right
        0.5,             // rebound race → genius
      ];
      let q = 0;
      const rng = () => (q < queue.length ? queue[q++] : 0.5);
      const r = simulateRound(
        [fastDunce, halfGenius, neverBuzzes], [0, 0, 0], [200, 400], 0, 'J', scripted, true, rng, 2,
      );
      expect(r.history[0]).toEqual([-200, 200, 0]);  // penalty, then the rebound
      expect(r.controllers[0]).toBe(2);                // initial controller picked clue 1
      expect(r.controllers[1]).toBe(1);                // the rebounder picks clue 2
    });

    it('seeded games: controller sequence matches the scores (whoever gained on a regular clue picks next; DD taker keeps control; DJ opens with the lowest J score)', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const opp1 = makePlayer(0.6, 0.87, 0.5, 0.5);
      const opp2 = makePlayer(0.55, 0.8, 0.45, 0.45);
      const config: SimConfig = { ...DEFAULT_CONFIG, boardControl: 'tracked', includeFJ: false };
      const rng = mulberry32(2026);
      let checkedTransitions = 0;
      let reboundTransitions = 0;
      for (let g = 0; g < 200; g++) {
        const r = simulateGame(you, opp1, opp2, config, true, rng);
        // ddEvents carry board indices; map each to its play position.
        const ddAtPos = new Map<number, number>();
        for (const e of r.ddEvents!) {
          const offset = e.round === 'J' ? 0 : 30;
          const pos = r.playOrder!.indexOf(e.clueIndex, offset);
          expect(pos).toBeGreaterThanOrEqual(offset);
          expect(pos).toBeLessThan(offset + 30);
          ddAtPos.set(pos, e.player);
        }
        for (let k = 0; k < 60; k++) {
          const c = r.controllers![k];
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(2);
          if (k === 0) continue;
          if (k === 30) {
            expect(c).toBe(lowestScoreIndex(r.history![29]));
            continue;
          }
          // Outcome of clue k-1 decides who picks clue k.
          const before: [number, number, number] = k - 1 === 0 ? [0, 0, 0] : r.history![k - 2];
          const after = r.history![k - 1];
          const prevController = r.controllers![k - 1];
          const ddPlayer = ddAtPos.get(k - 1);
          let expected: number;
          if (ddPlayer !== undefined) {
            expect(ddPlayer).toBe(prevController); // the controller is the one who uncovered it
            expected = prevController;             // and keeps the board, right or wrong
          } else {
            const gained = [0, 1, 2].filter(p => after[p] > before[p]);
            expect(gained.length).toBeLessThanOrEqual(1);
            expected = gained.length === 1 ? gained[0] : prevController;
            if (gained.length === 1 && [0, 1, 2].some(p => after[p] < before[p])) reboundTransitions++;
          }
          expect(c).toBe(expected);
          checkedTransitions++;
        }
      }
      expect(checkedTransitions).toBeGreaterThan(10000);
      expect(reboundTransitions).toBeGreaterThan(50); // rebounds were exercised, not just clean buzzes
    });

    it("boardControl 'tracked' hands the DD to the tracked controller, not the leader", () => {
      // A hopeless leader who never buzzes cannot be the tracked controller
      // after clue 1, so under 'tracked' they must never hit a DD, whereas
      // under 'leader' (legacy) they hit every one.
      const leaderWhoNeverBuzzes = makePlayer(0, 1, 0.5);
      const grinder = makePlayer(0.9, 0.95, 0.9);
      const state: SimState = {
        scores: [1_000_000, 0, 0], round: 'DJ', remainingClueValues: buildFullBoard(DJ_VALUES), remainingDDCount: 2, controller: 1,
      };
      const trackedCfg: SimConfig = { ...DEFAULT_CONFIG, boardControl: 'tracked', includeFJ: false, rhoB: 0, rhoP: 0 };
      const leaderCfg: SimConfig = { ...DEFAULT_CONFIG, boardControl: 'leader', includeFJ: false, rhoB: 0, rhoP: 0 };
      const rng = mulberry32(9);
      for (let g = 0; g < 50; g++) {
        const t = simulateFromState(state, [leaderWhoNeverBuzzes, grinder, grinder], trackedCfg, rng, true);
        for (const e of t.ddEvents!) expect(e.player).not.toBe(0);
        const l = simulateFromState(state, [leaderWhoNeverBuzzes, grinder, grinder], leaderCfg, rng, true);
        for (const e of l.ddEvents!) expect(e.player).toBe(0);
      }
    });

    it('resolveBoardControl: any non-default square selection implies tracked; otherwise the configured shim', () => {
      expect(resolveBoardControl(DEFAULT_CONFIG)).toBe('leader');
      expect(resolveBoardControl({ ...DEFAULT_CONFIG, boardControl: 'score-weighted' })).toBe('score-weighted');
      expect(resolveBoardControl({ ...DEFAULT_CONFIG, boardControl: 'tracked' })).toBe('tracked');
      expect(resolveBoardControl({ ...DEFAULT_CONFIG, squareSelection: 'ddSeek' })).toBe('tracked');
      expect(resolveBoardControl({ ...DEFAULT_CONFIG, opponentSquareSelection: 'ddSeek' })).toBe('tracked');
      expect(resolveBoardControl({ ...DEFAULT_CONFIG, squareSelection: 'default' })).toBe('leader');
    });

    it('tracked-mode DJ placement never puts both DDs in one column; row marginals still follow the prior', () => {
      const you = makePlayer(0.7, 0.85, 0.6, 0.5);
      const config: SimConfig = { ...DEFAULT_CONFIG, boardControl: 'tracked', ddRowWeights: EMPIRICAL_DD_ROW_WEIGHTS };
      const rng = mulberry32(31337);
      const rowCounts = [0, 0, 0, 0, 0];
      const trials = 3000;
      for (let i = 0; i < trials; i++) {
        const r = simulateRound([you, you, you], [0, 0, 0], buildFullBoard(DJ_VALUES), 2, 'DJ', config, true, rng, 0);
        expect(r.ddEvents.length).toBe(2);
        const cols = r.ddEvents.map(e => Math.floor(e.clueIndex / 5));
        expect(cols[0]).not.toBe(cols[1]);
        for (const e of r.ddEvents) rowCounts[e.clueIndex % 5]++;
      }
      for (let row = 0; row < 5; row++) {
        const frac = rowCounts[row] / (2 * trials);
        expect(frac).toBeGreaterThan(EMPIRICAL_DD_ROW_WEIGHTS.DJ[row] - 0.03);
        expect(frac).toBeLessThan(EMPIRICAL_DD_ROW_WEIGHTS.DJ[row] + 0.03);
      }
    });
  });

  describe("square selection: 'ddSeek' (Tesauro 2012 p_DD + 0.1·p_RC)", () => {
    const dmOf = (value: number, round: 'J' | 'DJ') =>
      round === 'J' ? Math.max(0.3, 1 - (value / 1000) * 0.3) : Math.max(0.25, 1 - (value / 2000) * 0.4);

    /** Independent re-implementation of the objective for a board state. */
    function expectedScores(board: RoundBoard, precision: number, round: 'J' | 'DJ', w: number[]): number[] {
      const scores: number[] = [];
      let z = 0;
      for (let i = 0; i < board.n; i++) {
        if (board.played[i]) continue;
        const blocked = board.cols[i] >= 0 && (board.ddFoundColMask & (1 << board.cols[i])) !== 0;
        if (!blocked) z += w[board.rows[i]];
      }
      for (let i = 0; i < board.n; i++) {
        if (board.played[i]) { scores.push(-Infinity); continue; }
        const blocked = board.cols[i] >= 0 && (board.ddFoundColMask & (1 << board.cols[i])) !== 0;
        const pDD = blocked || z === 0 ? 0 : board.ddRemaining * w[board.rows[i]] / z;
        const pRC = precision * dmOf(board.values[i], round);
        scores.push(pDD + DD_SEEK_RETAIN_CONTROL_WEIGHT * pRC);
      }
      return scores;
    }

    it('fixed DJ board state: the chosen square has the maximal score among remaining squares (lowest index on ties)', () => {
      const you = makePlayer(0.8, 0.9, 0.7);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddRowWeights: EMPIRICAL_DD_ROW_WEIGHTS };
      const board = createRoundBoard(buildFullBoard(DJ_VALUES), 'DJ');
      // Play out: all of column 0, the top two rows everywhere, and rows 3–4
      // of columns 1 and 2; the first DD was found in column 2.
      for (let i = 0; i < 30; i++) {
        const col = Math.floor(i / 5), row = i % 5;
        if (col === 0 || row <= 1 || ((col === 1 || col === 2) && row >= 3)) { board.played[i] = 1; board.playedCount++; }
      }
      board.ddRemaining = 1;
      board.ddFoundColMask = 1 << 2;

      const chosen = chooseSquare(board, 'ddSeek', you, 'DJ', config);
      const scores = expectedScores(board, you.p, 'DJ', EMPIRICAL_DD_ROW_WEIGHTS.DJ);
      const best = Math.max(...scores);
      expect(board.played[chosen]).toBe(0);
      expect(scores[chosen]).toBeCloseTo(best, 12);
      expect(chosen).toBe(scores.indexOf(best)); // first (leftmost) of the tied maxima
      // And concretely: row 3 (the DJ mode) in the leftmost column still
      // holding row 3 that isn't the found-DD column → column 3, index 18.
      expect(chosen).toBe(18);
    });

    it('a column whose DD was already found scores only its retain-control term', () => {
      const you = makePlayer(0.8, 0.9, 0.7);
      const config: SimConfig = { ...DEFAULT_CONFIG, ddRowWeights: { J: [0, 0, 0, 0, 1], DJ: [0, 0, 0, 0, 1] } };
      const board = createRoundBoard(buildFullBoard(DJ_VALUES), 'DJ');
      // Only two squares left: bottom-row column 1 (DD column already found)
      // and a row-2 square in column 4. Prior says bottom row only, but
      // column 1 is ruled out, so p_DD there is 0 and the row-2 square
      // (p_DD = 1 × w / Σ … = 0 too, since its row weight is 0) wins on the
      // higher retain-control term of the easier clue.
      for (let i = 0; i < 30; i++) { board.played[i] = 1; board.playedCount++; }
      const bottomCol1 = 1 * 5 + 4, row2Col4 = 4 * 5 + 2;
      board.played[bottomCol1] = 0; board.played[row2Col4] = 0; board.playedCount -= 2;
      board.ddRemaining = 1;
      board.ddFoundColMask = 1 << 1;
      expect(chooseSquare(board, 'ddSeek', you, 'DJ', config)).toBe(row2Col4);
      // Lift the column block and the bottom-row square wins outright.
      board.ddFoundColMask = 0;
      expect(chooseSquare(board, 'ddSeek', you, 'DJ', config)).toBe(bottomCol1);
    });

    it('with every DD in the round found, ddSeek falls back to the default (lowest-index) order', () => {
      const you = makePlayer(0.8, 0.9, 0.7);
      const board = createRoundBoard(buildFullBoard(J_VALUES), 'J');
      board.played[0] = 1; board.played[1] = 1; board.playedCount = 2;
      board.ddRemaining = 0;
      expect(chooseSquare(board, 'ddSeek', you, 'J', DEFAULT_CONFIG)).toBe(2);
      expect(chooseSquare(board, 'default', you, 'J', DEFAULT_CONFIG)).toBe(2);
    });

    it('never selects a played square and never runs a round past 30 clues (everyone seeking, 500 seeded games)', () => {
      const you = makePlayer(0.8, 0.9, 0.7, 0.6);
      const config: SimConfig = {
        ...DEFAULT_CONFIG, squareSelection: 'ddSeek', opponentSquareSelection: 'ddSeek', ddRowWeights: EMPIRICAL_DD_ROW_WEIGHTS,
      };
      const rng = mulberry32(4242);
      for (let g = 0; g < 500; g++) {
        const r = simulateGame(you, sampleOpponent(OPPONENT_PROFILES.average, rng), sampleOpponent(OPPONENT_PROFILES.champion, rng), config, true, rng);
        expect(r.history!.length).toBe(61);
        expect(r.playOrder!.length).toBe(60);
        expect(r.ddEvents!.length).toBe(3);
        for (const round of [0, 30]) {
          const order = r.playOrder!.slice(round, round + 30);
          expect(new Set(order).size).toBe(30);
          for (const idx of order) { expect(idx).toBeGreaterThanOrEqual(0); expect(idx).toBeLessThan(30); }
        }
      }
    });

    it('a seeking controller uncovers DDs before a top-down one would (row 3, the DJ mode, comes first under the empirical prior)', () => {
      const you = makePlayer(0.8, 0.9, 0.7, 0.6);
      const config: SimConfig = { ...DEFAULT_CONFIG, squareSelection: 'ddSeek', ddRowWeights: EMPIRICAL_DD_ROW_WEIGHTS };
      const r = simulateRound([you, you, you], [0, 0, 0], buildFullBoard(DJ_VALUES), 2, 'DJ', config, true, mulberry32(8), 0);
      // First pick by the seeker: row 3 ($1600) of column 0.
      expect(r.playOrder[0]).toBe(3);
    });

    it("'ddSeek' vs 'default' for a strong player vs Average opponents: paired seeds, measured lift (see comment)", () => {
      // Per-game seeds (mulberry32(base + i·7919)) so both strategies see
      // the same opponents and the same J-round DD placement in game i —
      // common random numbers, then the streams diverge at the first
      // differing square choice.
      //
      // Measured at 20,000 paired games (SE of the paired difference ≈ 0.5pp):
      //   Tesauro-like config (difficultyScaling: false — DD accuracy =
      //   precision, as the paper models DD accuracy as its own flat
      //   parameter):   default 66.66% → ddSeek 76.66%   lift +10.0pp
      //   Production config (difficulty scaling on, 'aggressive' 75%
      //   wagers, empirical priors): 51.44% → 52.66%     lift +1.2pp
      //   Production vs Champion opponents:     31.19% → 34.76%  lift +3.6pp
      //   Production, 'conservative' wagers:    53.27% → 56.54%  lift +3.3pp
      //   Your DDs/game in every case: ≈1.29 → ≈2.0 (of 3).
      // The production lift is small because the engine's difficulty-by-row
      // multiplier applies to DDs too: a bottom-row DD is answered at ~64%,
      // so at 75%-of-score wagers it is close to EV-neutral with high
      // variance — finding more of them barely helps a favorite. Under the
      // paper's flat DD accuracy the effect is the "overwhelmingly the top
      // factor" the paper reports. The clear-margin assertion is on that
      // config; production is asserted non-negative with its number logged.
      const you = makePlayer(0.8, 0.9, 0.7, 0.6);
      const run = (base: SimConfig, n: number) => {
        const cfgDefault: SimConfig = { ...base, boardControl: 'tracked', squareSelection: 'default' };
        const cfgSeek: SimConfig = { ...base, boardControl: 'tracked', squareSelection: 'ddSeek' };
        let wD = 0, wS = 0, ddD = 0, ddS = 0;
        for (let i = 0; i < n; i++) {
          for (const seek of [false, true]) {
            const rng = mulberry32(1000 + i * 7919);
            const o1 = sampleOpponent(OPPONENT_PROFILES.average, rng);
            const o2 = sampleOpponent(OPPONENT_PROFILES.average, rng);
            const r = simulateGame(you, o1, o2, seek ? cfgSeek : cfgDefault, true, rng);
            const mine = r.ddEvents!.filter(e => e.player === 0).length;
            if (seek) { if (r.winner === 0) wS++; ddS += mine; } else { if (r.winner === 0) wD++; ddD += mine; }
          }
        }
        return { def: wD / n, seek: wS / n, ddDef: ddD / n, ddSeek: ddS / n };
      };
      const n = 8000;
      const flat = run({ ...DEFAULT_CONFIG, ddRowWeights: EMPIRICAL_DD_ROW_WEIGHTS, difficultyScaling: false }, n);
      const prod = run({ ...DEFAULT_CONFIG, ddRowWeights: EMPIRICAL_DD_ROW_WEIGHTS }, n);
      const fmt = (x: { def: number; seek: number; ddDef: number; ddSeek: number }) =>
        `default ${(x.def * 100).toFixed(2)}% → ddSeek ${(x.seek * 100).toFixed(2)}% (lift ${((x.seek - x.def) * 100).toFixed(2)}pp); your DDs/game ${x.ddDef.toFixed(2)} → ${x.ddSeek.toFixed(2)}`;
      console.log(`[ddSeek lift, ${n} paired games]\n  flat DD accuracy: ${fmt(flat)}\n  production:       ${fmt(prod)}`);

      // Mechanism: seeking finds materially more DDs either way.
      expect(flat.ddSeek - flat.ddDef).toBeGreaterThan(0.4);
      expect(prod.ddSeek - prod.ddDef).toBeGreaterThan(0.4);
      // Clear margin under the paper's DD-accuracy model (≥ +5pp; measured +10pp).
      expect(flat.seek - flat.def).toBeGreaterThan(0.05);
      // Production: non-negative (measured +1.2pp at 20k, +1.5pp here).
      expect(prod.seek - prod.def).toBeGreaterThan(0);
    }, 120000);
  });
  describe("'squareSelection' dimension (Explorer axis candidate)", () => {
    it('is registered with the registry shape: two-valued strategy, default 0 = top-down', () => {
      const dim = DIMENSIONS.squareSelection;
      expect(dim.type).toBe('strategy');
      expect(dim.range).toEqual([0, 1]);
      expect(dim.defaultValue).toBe(0);
      expect(dim.format(0)).toBe('Top-down');
      expect(dim.format(1)).toBe('DD seeking');
      expect(dim.toParams(0, {}).sim?.squareSelection).toBe('default');
      expect(dim.toParams(0.49, {}).sim?.squareSelection).toBe('default');
      expect(dim.toParams(0.5, {}).sim?.squareSelection).toBe('ddSeek');
      expect(dim.toParams(1, {}).sim?.squareSelection).toBe('ddSeek');
    });

    it('as a swept axis it sets config.squareSelection; left unpinned it stays inert (legacy path)', () => {
      const seek = buildSimParams('squareSelection', 'buzzerSpeed', 1, 0.6, {});
      expect(seek.config.squareSelection).toBe('ddSeek');
      expect(resolveBoardControl(seek.config)).toBe('tracked');

      const top = buildSimParams('squareSelection', 'buzzerSpeed', 0, 0.6, {});
      expect(top.config.squareSelection).toBe('default');
      expect(resolveBoardControl(top.config)).toBe('leader');

      // Not an axis and not in any preset's pinned set ⇒ never applied, so
      // every existing sweep keeps the regression-locked legacy order.
      const legacy = buildSimParams('knowledge', 'buzzerSpeed', 0.4, 0.6, { squareSelection: 1 });
      expect(legacy.config.squareSelection).toBeUndefined();
      expect(resolveBoardControl(legacy.config)).toBe('leader');
    });
  });
});
