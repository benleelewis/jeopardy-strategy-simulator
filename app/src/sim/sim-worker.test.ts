// @vitest-environment jsdom
//
// sim-worker.ts assigns `self.onmessage = ...` at module load time, which
// needs a `self` global — present in jsdom (and real Workers) but not in
// this project's default 'node' test environment (see vite.config.ts).
// This file only calls the exported pure `buildDDImpactGrid` builder
// directly; it never dispatches a message through `self.onmessage`.
import { describe, it, expect } from 'vitest';
import { buildDDImpactGrid } from './sim-worker';
import { DEFAULT_CONFIG, type SimConfig } from './sim-engine';

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
