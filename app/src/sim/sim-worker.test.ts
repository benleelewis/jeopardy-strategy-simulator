// @vitest-environment jsdom
//
// sim-worker.ts assigns `self.onmessage = ...` at module load time, which
// needs a `self` global — present in jsdom (and real Workers) but not in
// this project's default 'node' test environment (see vite.config.ts).
// This file only calls the exported pure `buildDDImpactGrid` builder
// directly; it never dispatches a message through `self.onmessage`.
import { describe, it, expect } from 'vitest';
import {
  buildDDImpactGrid, buildGamesDelta, resolveDDStrategy,
  computeWhatIfWager, sampleRemainingBoardForRound, estimateRemainingDDCount,
  DEFAULT_WHAT_IF_SEED, type WhatIfWagerEvent,
} from './sim-worker';
import { DEFAULT_CONFIG, mulberry32, playerFrom2Axis, simulateFromState, sampleOpponent, type SimConfig, type SimState, type Player } from './sim-engine';
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

describe('computeWhatIfWager — "What if you had wagered differently?" (TASKS.md Phase 1F)', () => {
  const you: Player = playerFrom2Axis(0.5, 0.5);
  const opponentProfiles: [typeof OPPONENT_PROFILES.average, typeof OPPONENT_PROFILES.average] = [
    OPPONENT_PROFILES.average,
    OPPONENT_PROFILES.average,
  ];
  const config: SimConfig = { ...DEFAULT_CONFIG };

  const event: WhatIfWagerEvent = {
    round: 'DJ',
    scoresBefore: [6000, 4000, 3000],
    cluesRemainingAfter: 10,
    correct: true,
    wager: 3000,
  };

  it("the actual-wager arm equals a direct simulateFromState rollout with the same seeds", () => {
    const n = 200;
    const result = computeWhatIfWager(you, opponentProfiles, event, 6000, config, n, DEFAULT_WHAT_IF_SEED);
    expect(result).not.toBeNull();

    // Reconstruct the actual arm by hand, using the exact same per-rollout
    // seed derivation, board sampling, and opponent draws `computeWhatIfWager`
    // itself uses (all exported for exactly this purpose).
    const actualScores: [number, number, number] = [...event.scoresBefore];
    actualScores[0] += event.correct ? event.wager : -event.wager;
    const ddCount = estimateRemainingDDCount(event.round, event.cluesRemainingAfter);

    let wins = 0;
    for (let i = 0; i < n; i++) {
      const rollSeed = (DEFAULT_WHAT_IF_SEED + i * 7919) >>> 0;
      const rng = mulberry32(rollSeed);
      const remaining = sampleRemainingBoardForRound(event.round, event.cluesRemainingAfter, rng);
      const opp1 = sampleOpponent(opponentProfiles[0], rng);
      const opp2 = sampleOpponent(opponentProfiles[1], rng);
      const state: SimState = {
        scores: actualScores, round: event.round, remainingClueValues: remaining, remainingDDCount: ddCount,
      };
      if (simulateFromState(state, [you, opp1, opp2], config, rng, false).winner === 0) wins++;
    }

    expect(result!.actualWinRate).toBe(wins / n);
  });

  it('what-if with the same wager as actual gives exactly 0 difference', () => {
    const result = computeWhatIfWager(you, opponentProfiles, event, event.wager, config, 300, DEFAULT_WHAT_IF_SEED);
    expect(result).not.toBeNull();
    expect(result!.whatIfWinRate).toBe(result!.actualWinRate);
    expect(result!.diff).toBe(0);
    expect(result!.se).toBe(0);
  });

  it('is deterministic given the same seed', () => {
    const a = computeWhatIfWager(you, opponentProfiles, event, 8000, config, 300, 0xABCD);
    const b = computeWhatIfWager(you, opponentProfiles, event, 8000, config, 300, 0xABCD);
    expect(a).toEqual(b);
  });

  it('returns null when cancelled mid-computation', () => {
    let calls = 0;
    const result = computeWhatIfWager(
      you, opponentProfiles, event, 8000, config, 500, DEFAULT_WHAT_IF_SEED,
      { isCancelled: () => ++calls > 5 },
    );
    expect(result).toBeNull();
  });
});
