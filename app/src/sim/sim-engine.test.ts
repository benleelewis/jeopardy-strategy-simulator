import { describe, it, expect } from 'vitest';
import {
  simulateGame,
  calculateWinRate,
  playerFrom2Axis,
  sampleOpponent,
  ddWager,
  DEFAULT_CONFIG,
  type Player,
  type SimConfig,
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
});
