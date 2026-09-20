// @vitest-environment jsdom
//
// sim-worker.ts assigns `self.onmessage = ...` at module load time, which
// needs a `self` global — present in jsdom (and real Workers) but not in
// this project's default 'node' test environment (see vite.config.ts).
// This file only calls the exported pure `buildDDImpactGrid` builder
// directly; it never dispatches a message through `self.onmessage`.
import { describe, it, expect } from 'vitest';
import { buildDDImpactGrid, buildGamesDelta, resolveDDStrategy } from './sim-worker';
import { DEFAULT_CONFIG, mulberry32, type SimConfig } from './sim-engine';
import { buildSimParams } from './dimensions';
import { OPPONENT_PROFILES } from './opponent-models';
import { buildValueTable, type ValueTable } from './value-function';

describe('buildDDImpactGrid — P2 DD impact difference map overlay (TODOS.md)', () => {
  it('is exactly zero everywhere when the active DD strategy is already "off"', () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'off' };
    const grid = buildDDImpactGrid(
      'knowledge',
      'buzzerSpeed',
      {},
      config,
      /* resolution */ 4,
      /* gamesPerCell */ 50,
      /* seed */ 0x1234,
    );

    expect(grid).not.toBeNull();
    expect(grid!.length).toBe(25); // (resolution + 1)^2
    for (const cell of grid!) {
      expect(cell.diff).toBe(0);
    }
  });

  it('produces a nonzero difference somewhere when the active strategy is not "off"', () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };
    const grid = buildDDImpactGrid(
      'knowledge',
      'buzzerSpeed',
      {},
      config,
      /* resolution */ 4,
      /* gamesPerCell */ 200,
      /* seed */ 0x1234,
    );

    expect(grid).not.toBeNull();
    expect(grid!.some(cell => cell.diff !== 0)).toBe(true);
  });

  it('is deterministic given the same seed', () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive' };
    const gridA = buildDDImpactGrid('knowledge', 'buzzerSpeed', {}, config, 3, 30, 0xABCD);
    const gridB = buildDDImpactGrid('knowledge', 'buzzerSpeed', {}, config, 3, 30, 0xABCD);

    expect(gridA).toEqual(gridB);
  });

  it('returns null when cancelled mid-computation', () => {
    let calls = 0;
    const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'off' };
    const grid = buildDDImpactGrid(
      'knowledge',
      'buzzerSpeed',
      {},
      config,
      5,
      20,
      0x1,
      { isCancelled: () => ++calls > 2 },
    );
    expect(grid).toBeNull();
  });
});

describe("resolveDDStrategy keeps the user's Final Jeopardy toggle", () => {
  const cell = () => buildSimParams('knowledge', 'buzzerSpeed', 0.5, 0.5, {}).config;

  it('includeFJ: false survives the merge with the DEFAULT_CONFIG-based cell config', () => {
    const merged = resolveDDStrategy({ ...DEFAULT_CONFIG, includeFJ: false }, cell(), 'knowledge', 'buzzerSpeed');
    expect(merged.includeFJ).toBe(false);
  });

  it('includeFJ: true is unchanged (the regression-locked default)', () => {
    const merged = resolveDDStrategy({ ...DEFAULT_CONFIG, includeFJ: true }, cell(), 'knowledge', 'buzzerSpeed');
    expect(merged.includeFJ).toBe(true);
  });
});

describe('buildGamesDelta — All Games "Gain from optimal play" (TODOS P2 optimal-vs-actual)', () => {
  // A handful of historical-style games (same shape as games.json entries).
  const games = [
    { s: 1, d: '2020-01-06', o: [{ n: 'A', k: 0.8, b: 0.6, fj: 1, c: 10000 }, { n: 'B', k: 0.7, b: 0.5, fj: 0, c: 8000 }] },
    { s: 1, d: '2020-01-07', o: [{ n: 'C', k: 0.6, b: 0.4, fj: 1, c: 9000 }, { n: 'D', k: 0.5, b: 0.5, fj: 0, c: 7000 }] },
    { s: 2, d: '2020-09-14', o: [{ n: 'E', k: 0.9, b: 0.7, fj: 1, c: 12000 }, { n: 'F', k: 0.6, b: 0.4, fj: 0, c: 6000 }] },
    { s: 2, d: '2020-09-15', o: [{ n: 'G', k: 0.4, b: 0.3, fj: 1, c: 5000 }, { n: 'H', k: 0.5, b: 0.5, fj: 0, c: 4000 }] },
  ];

  // Tiny V-table so the equity arm is genuinely exercised (not the
  // no-table 'aggressive' fallback) without a multi-second build.
  let tinyTable: ValueTable | null = null;
  const getTinyTable = (): ValueTable => {
    if (!tinyTable) {
      tinyTable = buildValueTable(OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(0xBEEF), {
        dims: {
          skillKnowledge: { min: 0, max: 1, n: 3 },
          skillBuzzer: { min: 0, max: 1, n: 2 },
          yourShare: { min: 0, max: 1.5, n: 3 },
          leaderRatio: { min: 0, max: 2, n: 2 },
          thirdRatio: { min: 0, max: 2, n: 2 },
          cluesRemaining: { min: 0, max: 30, n: 2 },
        },
        rolloutsPerCell: 2,
        blurRadius: 0,
      });
    }
    return tinyTable;
  };

  it('is exactly zero for every game when the current settings are already optimal', () => {
    const table = getTinyTable();
    const config: SimConfig = {
      ...DEFAULT_CONFIG,
      ddStrategy: 'equity',
      valueTable: table,
      squareSelection: 'ddSeek',
    };
    const results = buildGamesDelta(games, 'knowledge', 'buzzerSpeed', 0.5, 0.5, {}, config, 10, table, 0x1234);

    expect(results).not.toBeNull();
    expect(results!.length).toBe(games.length);
    for (const r of results!) {
      expect(r.optimal - r.actual).toBe(0);
    }
  });

  it('is deterministic given the same seed', () => {
    const table = getTinyTable();
    const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'aggressive', ddWagerFraction: 0.5 };
    const a = buildGamesDelta(games, 'knowledge', 'buzzerSpeed', 0.5, 0.5, {}, config, 10, table, 0xABCD);
    const b = buildGamesDelta(games, 'knowledge', 'buzzerSpeed', 0.5, 0.5, {}, config, 10, table, 0xABCD);
    expect(a).toEqual(b);
  });

  it('produces a nonzero gain somewhere when the current settings are not optimal', () => {
    const table = getTinyTable();
    const config: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'conservative' };
    const results = buildGamesDelta(games, 'knowledge', 'buzzerSpeed', 0.5, 0.5, {}, config, 40, table, 0x1234);
    expect(results).not.toBeNull();
    expect(results!.some(r => r.optimal !== r.actual)).toBe(true);
  });

  it('returns null when cancelled mid-computation', () => {
    let calls = 0;
    const config: SimConfig = { ...DEFAULT_CONFIG };
    const results = buildGamesDelta(
      games, 'knowledge', 'buzzerSpeed', 0.5, 0.5, {}, config, 2, undefined, 0x1,
      { isCancelled: () => ++calls > 2 },
    );
    expect(results).toBeNull();
  });
});
