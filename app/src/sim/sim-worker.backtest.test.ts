// @vitest-environment jsdom
//
// The `backtestGame` worker message. sim-worker.ts assigns `self.onmessage`
// at module load (jsdom provides `self`); this file dispatches messages
// through that handler with `self.postMessage` replaced by a spy, so the
// message protocol (progress, result, error, cancel) is exercised without a
// real Worker.
import { describe, it, expect, vi } from 'vitest';
import './sim-worker';
import { backtestGame, BACKTEST_ARMS } from './backtest';
import type { GameRecord } from '../lib/jarchive';

function record(): GameRecord {
  const before = [4200, 6600, 3000];
  return {
    players: ['Sam', 'Grace', 'Joey'],
    cluesPlayed: 57,
    stats: [
      { correct: 14, wrong: 3, coryat: 8600 },
      { correct: 25, wrong: 3, coryat: 20200 },
      { correct: 12, wrong: 1, coryat: 7400 },
    ],
    endOfJ: [200, 600, 0],
    endOfDJ: [4200, 3600, 3000],
    steps: [
      {
        round: 'DJ', order: 18, boundValue: 1600, isDD: true, ddPlayer: 1, wager: 3000, ddCorrect: false,
        deltas: [0, -3000, 0], before, after: [4200, 3600, 3000],
        remainingValuesAfter: [400, 800, 1200, 1600, 2000, 400, 800, 1200], remainingDDsAfter: 1,
      },
    ],
  };
}

type Posted = { type: string; [k: string]: unknown };

function dispatch(data: unknown): Posted[] {
  const posted: Posted[] = [];
  const spy = vi.fn((m: Posted) => { posted.push(m); });
  (self as unknown as { postMessage: unknown }).postMessage = spy;
  self.onmessage!({ data } as MessageEvent);
  return posted;
}

describe('sim-worker — backtestGame message', () => {
  it('posts progress then a result identical to calling the module directly', () => {
    const posted = dispatch({ type: 'backtestGame', record: record(), seat: 1, rolloutsPerArm: 40, seed: 42, requestId: 7 });

    const progress = posted.filter(m => m.type === 'backtestProgress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(m => m.requestId === 7)).toBe(true);
    expect(progress[progress.length - 1].pct).toBe(1);

    const results = posted.filter(m => m.type === 'backtestResult');
    expect(results).toHaveLength(1);
    expect(results[0].requestId).toBe(7);
    const direct = backtestGame(record(), { seat: 1, rolloutsPerArm: 40, seed: 42 });
    expect(results[0].result).toEqual(direct);
    const rows = (results[0].result as { rows: { arms: Record<string, unknown> }[] }).rows;
    expect(rows).toHaveLength(1);
    for (const arm of BACKTEST_ARMS) expect(rows[0].arms[arm]).not.toBeNull();
  });

  it('posts backtestError (not a crash) on a malformed request', () => {
    const posted = dispatch({ type: 'backtestGame', record: record(), seat: 9, rolloutsPerArm: 10, requestId: 1 });
    const errors = posted.filter(m => m.type === 'backtestError');
    expect(errors).toHaveLength(1);
    expect(String(errors[0].message)).toMatch(/seat/);
    expect(posted.some(m => m.type === 'backtestResult')).toBe(false);
  });

  it('drops the result silently when cancelled mid-run', () => {
    // Arrange: the cancel flag is checked through `isCancelled`, which reads
    // the worker's module-level `cancelled`. Flip it from inside a progress
    // callback by posting 'cancel' re-entrantly.
    const posted: Posted[] = [];
    let cancelledOnce = false;
    (self as unknown as { postMessage: unknown }).postMessage = vi.fn((m: Posted) => {
      posted.push(m);
      if (m.type === 'backtestProgress' && !cancelledOnce) {
        cancelledOnce = true;
        self.onmessage!({ data: { type: 'cancel' } } as MessageEvent);
      }
    });
    self.onmessage!({ data: { type: 'backtestGame', record: record(), seat: 1, rolloutsPerArm: 400, seed: 1, requestId: 3 } } as MessageEvent);

    expect(cancelledOnce).toBe(true);
    expect(posted.some(m => m.type === 'backtestResult')).toBe(false);
    expect(posted.some(m => m.type === 'backtestError')).toBe(false);
  });
});
