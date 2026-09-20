// @vitest-environment jsdom
//
// Same arrangement as sim-worker.test.ts: sim-worker.ts assigns
// `self.onmessage` at module load, which needs jsdom's `self`. Only the
// exported pure `computeOracle` builder is called here; the plan/assembly
// helpers from oracle.ts are exercised through it and directly.
import { describe, it, expect } from 'vitest';
import { computeOracle } from './sim-worker';
import {
  buildOraclePlan,
  assembleOracleRows,
  oracleGamesPerEstimate,
  deltaStandardError,
  ORACLE_ESTIMATE_BUDGET,
  ORACLE_MIN_GAMES,
  type OracleInput,
  type OracleEstimate,
} from './oracle';
import { DEFAULT_CONFIG, type SimConfig } from './sim-engine';

/** Preset B (knowledge × buzzer speed) at the app's default position with
 *  the regression-locked default config. */
function baseInput(overrides: Partial<OracleInput> = {}): OracleInput {
  return {
    xAxis: 'knowledge',
    yAxis: 'buzzerSpeed',
    xVal: 0.4,
    yVal: 0.5,
    pinnedValues: {},
    config: { ...DEFAULT_CONFIG, ddWagerFraction: 0.75 },
    ...overrides,
  };
}

const EXPECTED_DIMS_PRESET_B = [
  'knowledge',
  'buzzerSpeed',
  'ddAggression',
  'ddStrategy',
  'squareSelection',
  'includeFJ',
  'opponentStrength',
];

describe('buildOraclePlan — one realistic step per knob', () => {
  it('lists every active knob once and shares the baseline probe', () => {
    const plan = buildOraclePlan(baseInput());
    expect(plan.knobs.map(k => k.dimension)).toEqual(EXPECTED_DIMS_PRESET_B);
    expect(plan.probes[0].id).toBe('baseline');
    const ids = plan.probes.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reuses the baseline for the sweep point equal to the current wager', () => {
    const plan = buildOraclePlan(baseInput());
    const wager = plan.knobs.find(k => k.dimension === 'ddAggression')!;
    expect(wager.candidates).toHaveLength(5);
    expect(wager.candidates.filter(c => c.probeId === 'baseline')).toHaveLength(1);
    // 0.75 is on the sweep, so only four extra wager probes are needed.
    expect(plan.probes.filter(p => p.id.startsWith('ddAggression=')).map(p => p.config.ddWagerFraction))
      .toEqual([0, 0.25, 0.5, 1]);
  });

  it('drops the wager-size sweep when the active DD strategy ignores the fraction', () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'truedd', ddWagerFraction: undefined };
    const plan = buildOraclePlan(baseInput({ config }));
    expect(plan.knobs.map(k => k.dimension)).not.toContain('ddAggression');
    // ...but the strategy row still offers the other two heuristics (no
    // equity without a built value table).
    const strategy = plan.knobs.find(k => k.dimension === 'ddStrategy')!;
    expect(strategy.candidates.map(c => c.label).sort()).toEqual(['Aggressive', 'Conservative']);
  });

  it('moves skill dims by 5% of range through the axis or the pinned map', () => {
    const plan = buildOraclePlan(baseInput({ xAxis: 'precision', yAxis: 'buzzRaceWinPct', xVal: 0.7, yVal: 0.4, pinnedValues: { buzzAttemptRate: 0.5 } }));
    const byId = Object.fromEntries(plan.probes.map(p => [p.id, p]));
    expect(byId['precision+step'].xVal).toBeCloseTo(0.75, 10);
    expect(byId['precision+step'].yVal).toBe(0.4);
    expect(byId['buzzAttemptRate+step'].pinnedValues.buzzAttemptRate).toBeCloseTo(0.55, 10);
    expect(byId['buzzAttemptRate+step'].xVal).toBe(0.7);
  });

  it('marks a skill dim already at the top of its range as having no step', () => {
    const plan = buildOraclePlan(baseInput({ xVal: 1 }));
    const knowledge = plan.knobs.find(k => k.dimension === 'knowledge')!;
    expect(knowledge.noStep).toBeTruthy();
    expect(knowledge.candidates[0].probeId).toBe('baseline');
  });
});

describe('oracleGamesPerEstimate — shared budget', () => {
  it('splits ORACLE_ESTIMATE_BUDGET × gamesPerCell across the probes', () => {
    expect(oracleGamesPerEstimate(12, 450)).toBe(450);
    expect(oracleGamesPerEstimate(15, 450)).toBe(Math.floor((ORACLE_ESTIMATE_BUDGET * 450) / 15));
    expect(oracleGamesPerEstimate(15, 10)).toBe(ORACLE_MIN_GAMES);
  });
});

describe('deltaStandardError — paired when the games are shared', () => {
  const withWins = (wins: number[]): OracleEstimate => ({
    winRate: wins.reduce((a, b) => a + b, 0) / wins.length,
    games: wins.length,
    ddsFoundPerGame: 1,
    wins: Uint8Array.from(wins),
  });

  it('is zero for two probes that won exactly the same games', () => {
    const a = withWins([1, 0, 1, 1, 0, 0, 1, 0]);
    expect(deltaStandardError(a, withWins([1, 0, 1, 1, 0, 0, 1, 0]))).toBe(0);
  });

  it('is the sample SD of the per-game differences over sqrt(n)', () => {
    const a = withWins([1, 1, 1, 0, 0, 0, 0, 0]);
    const b = withWins([1, 0, 0, 0, 0, 0, 0, 0]);
    // differences: 0,1,1,0,0,0,0,0 → mean 0.25, sample var = (2·0.5625 + 6·0.0625)/7
    const expected = Math.sqrt(((2 * 0.5625) + (6 * 0.0625)) / 7 / 8);
    expect(deltaStandardError(a, b)).toBeCloseTo(expected, 12);
  });

  it('is tighter than the independent binomial SE when outcomes are shared', () => {
    const a = withWins([1, 1, 1, 0, 0, 0, 0, 0]);
    const b = withWins([1, 0, 0, 0, 0, 0, 0, 0]);
    const independent = deltaStandardError({ ...a, wins: undefined }, { ...b, wins: undefined });
    expect(deltaStandardError(a, b)).toBeLessThan(independent);
  });

  it('falls back to the binomial formula without per-game wins', () => {
    const a: OracleEstimate = { winRate: 0.5, games: 100, ddsFoundPerGame: 1 };
    const b: OracleEstimate = { winRate: 0.4, games: 100, ddsFoundPerGame: 1 };
    expect(deltaStandardError(a, b)).toBeCloseTo(Math.sqrt(0.25 / 100 + 0.24 / 100), 12);
  });
});

describe('assembleOracleRows — ranking and noise flags', () => {
  const est = (winRate: number, games = 400): OracleEstimate => ({ winRate, games, ddsFoundPerGame: 1 });

  it('sorts by delta descending, prefers the current value on ties, and flags noise', () => {
    const plan = buildOraclePlan(baseInput());
    const estimates: Record<string, OracleEstimate> = { baseline: est(0.40) };
    for (const p of plan.probes) if (p.id !== 'baseline') estimates[p.id] = est(0.40);
    estimates['knowledge+step'] = est(0.55); // clearly significant
    estimates['buzzerSpeed+step'] = est(0.41); // within noise
    estimates['ddAggression=1'] = est(0.40); // ties the baseline → keep current
    estimates['ddStrategy=truedd'] = est(0.30); // both alternatives worse → atBest, negative delta
    estimates['ddStrategy=conservative'] = est(0.35);

    const rows = assembleOracleRows(plan, estimates);
    const deltas = rows.map(r => r.delta);
    expect(deltas).toEqual([...deltas].sort((a, b) => b - a));
    expect(rows[0].dimension).toBe('knowledge');
    expect(rows[0].significant).toBe(true);
    expect(rows[0].atBest).toBe(false);

    const buzzer = rows.find(r => r.dimension === 'buzzerSpeed')!;
    expect(buzzer.significant).toBe(false);

    const wager = rows.find(r => r.dimension === 'ddAggression')!;
    expect(wager.delta).toBe(0);
    expect(wager.atBest).toBe(true);
    expect(wager.suggestedLabel).toBe(wager.currentLabel);

    const strategy = rows.find(r => r.dimension === 'ddStrategy')!;
    expect(strategy.atBest).toBe(true);
    expect(strategy.delta).toBeLessThan(0);
  });
});

describe('computeOracle — worker-level builder', () => {
  const GAMES_PER_CELL = 120;

  it('returns one row per active knob with finite deltas and errors', () => {
    const result = computeOracle(baseInput(), GAMES_PER_CELL, 0x5EED);
    expect(result).not.toBeNull();
    expect(result!.rows.map(r => r.dimension).sort()).toEqual([...EXPECTED_DIMS_PRESET_B].sort());
    for (const row of result!.rows) {
      expect(Number.isFinite(row.delta)).toBe(true);
      expect(Number.isFinite(row.se)).toBe(true);
      expect(row.se).toBeGreaterThanOrEqual(0);
      expect(row.why.length).toBeGreaterThan(0);
    }
    expect(result!.baselineWinRate).toBeGreaterThan(0);
    expect(result!.baselineWinRate).toBeLessThan(1);
    // 13 probes under preset B with the default config: baseline, 2 skill
    // steps, 4 wager points (0.75 reuses the baseline), 2 DD strategies
    // (no equity without a table), square selection, FJ, 2 opponents.
    expect(buildOraclePlan(baseInput()).probes).toHaveLength(13);
    expect(result!.gamesPerEstimate).toBe(oracleGamesPerEstimate(13, GAMES_PER_CELL));
  });

  it('is sorted by delta descending and the square-selection why line carries measured DD counts', () => {
    const result = computeOracle(baseInput(), GAMES_PER_CELL, 0x5EED)!;
    const deltas = result.rows.map(r => r.delta);
    expect(deltas).toEqual([...deltas].sort((a, b) => b - a));
    const square = result.rows.find(r => r.dimension === 'squareSelection')!;
    expect(square.why).toMatch(/finds \d+\.\d per game instead of \d+\.\d/);
  });

  it('gives the same result twice for the same seed', () => {
    const a = computeOracle(baseInput(), GAMES_PER_CELL, 0xABCD);
    const b = computeOracle(baseInput(), GAMES_PER_CELL, 0xABCD);
    expect(a).toEqual(b);
  });

  it('reports |delta| = 0 for the wager size once it is pinned at the value it suggested', () => {
    const first = computeOracle(baseInput(), GAMES_PER_CELL, 0x777)!;
    const wagerRow = first.rows.find(r => r.dimension === 'ddAggression')!;
    // Map the suggested label back to its sweep fraction.
    const labelToFraction: Record<string, number> = {
      'Minimum bet': 0, '25% of score': 0.25, '50% of score': 0.5, '75% of score': 0.75, 'Everything': 1,
    };
    const best = labelToFraction[wagerRow.suggestedLabel];
    expect(best).toBeDefined();

    // Same seed everywhere ⇒ the probe at `best` reproduces the previous
    // run's estimate exactly, so it is again the argmax and delta is 0.
    const second = computeOracle(
      baseInput({ pinnedValues: { ddAggression: best }, config: { ...DEFAULT_CONFIG, ddWagerFraction: best } }),
      GAMES_PER_CELL,
      0x777,
    )!;
    const again = second.rows.find(r => r.dimension === 'ddAggression')!;
    expect(again.suggestedLabel).toBe(again.currentLabel);
    expect(again.delta).toBe(0);
    expect(again.atBest).toBe(true);
  });

  it('a knob whose alternative is identical to the baseline reads exactly zero', () => {
    // Under preset B `squareSelection` is not an axis, so it is driven by
    // config; with the same seed, 'default' vs 'default' is the same run.
    const plan = buildOraclePlan(baseInput());
    const estimates: Record<string, OracleEstimate> = {};
    const same: OracleEstimate = { winRate: 0.42, games: 100, ddsFoundPerGame: 1.3 };
    for (const p of plan.probes) estimates[p.id] = same;
    const rows = assembleOracleRows(plan, estimates);
    for (const row of rows) {
      expect(row.delta).toBe(0);
      expect(row.significant).toBe(false);
    }
  });

  it('returns null when cancelled mid-computation', () => {
    let calls = 0;
    const result = computeOracle(baseInput(), 20, 0x1, { isCancelled: () => ++calls > 2 });
    expect(result).toBeNull();
  });

  it('reports progress once per probe, ending at 1', () => {
    const seen: number[] = [];
    computeOracle(baseInput(), 20, 0x1, { onProgress: (pct) => seen.push(pct) });
    expect(seen.length).toBe(13);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
