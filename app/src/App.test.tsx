// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

/**
 * E-7's "build failure → inline status + revert" test lives here (rather
 * than ControlsPanel.test.tsx) because the revert itself is App.tsx state
 * management — ControlsPanel is a controlled component that only reflects
 * `ddStrategy`/`equityBuildStatus` props. A fake `Worker` lets the test
 * drive the persistent worker's `onmessage` by hand to simulate a build
 * failure, per the plan's "mock the worker layer" instruction.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: Record<string, unknown>) {
    this.posted.push(msg);
  }
  terminate() { /* no-op */ }
}

function mockFetchResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('App — Optimal (equity) build failure reverts the selection (E-7)', () => {
  beforeEach(() => {
    FakeWorker.instances.length = 0;
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('games.json')) {
        return mockFetchResponse([
          { s: 1, d: '2020-01-01', o: [{ n: 'A', k: 0.8, b: 0.6, fj: 1, c: 10000 }, { n: 'B', k: 0.7, b: 0.5, fj: 0, c: 8000 }] },
        ]);
      }
      // clue-stats.json: simulate the documented 404 fallback path — not
      // this test's concern, but must resolve so the app doesn't hang.
      return mockFetchResponse(null, false);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reverts to Aggressive and shows the inline failure status, no toast', async () => {
    render(<App />);

    await screen.findByText('Jeopardy Strategy Simulator');
    fireEvent.click(screen.getByRole('button', { name: /^Explorer$/ }));

    const optimalRadio = await screen.findByRole('radio', { name: /Optimal \(equity\)/ });
    fireEvent.click(optimalRadio);
    expect(optimalRadio).toHaveAttribute('aria-checked', 'true');

    // Several components create their own Worker (HeatMap, MarginalReturns)
    // in addition to App.tsx's persistent gameWorkerRef — the persistent
    // one is uniquely identifiable as the one that received 'loadGames'
    // (App.tsx posts that once, right after creating it).
    let worker: FakeWorker | undefined;
    let buildMsg: Record<string, unknown> | undefined;
    await waitFor(() => {
      worker = FakeWorker.instances.find(w => w.posted.some(m => m.type === 'loadGames'));
      buildMsg = worker?.posted.find(m => m.type === 'buildValueTable');
      expect(buildMsg).toBeDefined();
    }, { timeout: 3000 });

    // Simulate the worker reporting a build failure for that cache key.
    worker!.onmessage?.({
      data: { type: 'buildValueTableError', message: 'simulated crash', cacheKey: buildMsg!.cacheKey },
    } as MessageEvent);

    await screen.findByText('Optimal unavailable — using Aggressive');
    expect(screen.getByRole('radio', { name: /Optimal \(equity\)/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /^Aggressive$/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  }, 15000);
});

/**
 * P2 "All Games optimal-vs-actual delta coloring" (TODOS.md). The first
 * test is the byte-identical guarantee for the default colour mode: the
 * persistent worker must receive exactly today's messages (loadGames +
 * simAllGames) and never a computeGamesDelta or an unasked-for
 * buildValueTable. The second drives the gain-mode message flow by hand.
 */
describe('App — All Games colour mode (P2 optimal-vs-actual delta coloring)', () => {
  const persistentWorker = () =>
    FakeWorker.instances.find(w => w.posted.some(m => m.type === 'loadGames'));

  beforeEach(() => {
    FakeWorker.instances.length = 0;
    window.location.hash = '';
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('games.json')) {
        return mockFetchResponse([
          { s: 1, d: '2020-01-06', o: [{ n: 'A', k: 0.8, b: 0.6, fj: 1, c: 10000 }, { n: 'B', k: 0.7, b: 0.5, fj: 0, c: 8000 }] },
          { s: 1, d: '2020-01-07', o: [{ n: 'C', k: 0.6, b: 0.4, fj: 1, c: 9000 }, { n: 'D', k: 0.5, b: 0.5, fj: 0, c: 7000 }] },
        ]);
      }
      return mockFetchResponse(null, false);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  // Pre-existing (main, unrelated to this feature): the win-rate sweep
  // effect's dependency list has no `games`, so on a cold load straight
  // onto the All Games tab it does not fire until a dependency changes —
  // a tab round-trip is how a user kicks it off today.
  const kickOffWinRateSweep = async () => {
    await waitFor(() => expect(persistentWorker()).toBeDefined(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Explorer$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^All Games/ }));
    await waitFor(() => {
      expect(persistentWorker()?.posted.some(m => m.type === 'simAllGames')).toBe(true);
    }, { timeout: 3000 });
  };

  it('default mode: runs the win-rate sweep only — no delta computation, no V-table build', async () => {
    render(<App />);
    await screen.findByText('Jeopardy Strategy Simulator');
    await kickOffWinRateSweep();

    const types = persistentWorker()!.posted.map(m => m.type);
    expect(types).not.toContain('computeGamesDelta');
    expect(types).not.toContain('buildValueTable');
    expect(types.filter(t => t === 'simAllGames')).toHaveLength(1);
    expect(persistentWorker()!.posted.find(m => m.type === 'simAllGames')).toMatchObject({ simsPerGame: 2 });

    // Default-mode URL hash carries no colour-mode key.
    expect(window.location.hash).not.toContain('cm=');
    expect(screen.getByRole('button', { name: 'Win rate' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Win rate:')).toBeInTheDocument();
  });

  it('gain mode: builds the V-table, then runs the paired sweep, and cancels on switch back', async () => {
    render(<App />);
    await screen.findByText('Jeopardy Strategy Simulator');
    await waitFor(() => expect(persistentWorker()).toBeDefined(), { timeout: 3000 });
    const worker = persistentWorker()!;

    fireEvent.click(screen.getByRole('button', { name: 'Gain from optimal play' }));
    expect(screen.getByRole('button', { name: 'Gain from optimal play' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.location.hash).toContain('cm=g');

    // No table cached yet -> the same build request the Explorer's Optimal
    // selection would make, and the header says so.
    let buildMsg: Record<string, unknown> | undefined;
    await waitFor(() => {
      buildMsg = worker.posted.find(m => m.type === 'buildValueTable');
      expect(buildMsg).toBeDefined();
    }, { timeout: 3000 });
    expect(screen.getByRole('status').textContent).toContain('Building the optimal-wagering table');
    expect(worker.posted.some(m => m.type === 'computeGamesDelta')).toBe(false);

    // The build lands -> the delta sweep is requested with that table, at
    // the win-rate sweep's fast-pass sims/game.
    const fakeTable = { data: new Float32Array(1), cellCount: 1 };
    worker.onmessage?.({
      data: { type: 'buildValueTableResult', table: fakeTable, cacheKey: buildMsg!.cacheKey },
    } as MessageEvent);

    let deltaMsg: Record<string, unknown> | undefined;
    await waitFor(() => {
      deltaMsg = worker.posted.find(m => m.type === 'computeGamesDelta');
      expect(deltaMsg).toBeDefined();
    }, { timeout: 3000 });
    expect(deltaMsg).toMatchObject({ simsPerGame: 2, valueTable: fakeTable });
    expect(screen.getByRole('status').textContent).toContain('Computing gain from optimal play');

    // Fast pass result -> headline appears, refined pass (25/game) is chained
    // with the same requestId.
    worker.onmessage?.({
      data: {
        type: 'gamesDeltaResult',
        results: [{ actual: 0.30, optimal: 0.40 }, { actual: 0.34, optimal: 0.42 }],
        _simsPerGame: 2,
        requestId: deltaMsg!.requestId,
      },
    } as MessageEvent);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent)
        .toContain('would lift you from 32% to 41% across 2 games');
    });
    const refined = worker.posted.filter(m => m.type === 'computeGamesDelta');
    expect(refined).toHaveLength(2);
    expect(refined[1]).toMatchObject({ simsPerGame: 25, requestId: deltaMsg!.requestId });
    expect(screen.getByText('Gain from optimal play:')).toBeInTheDocument();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('gain from optimal play');

    // Switch back: the win-rate header returns at once and the late refined
    // result is dropped (stale requestId), never re-colouring the graph.
    fireEvent.click(screen.getByRole('button', { name: 'Win rate' }));
    expect(screen.getByText('Win rate:')).toBeInTheDocument();
    expect(window.location.hash).not.toContain('cm=');
    worker.onmessage?.({
      data: {
        type: 'gamesDeltaResult',
        results: [{ actual: 0.30, optimal: 0.40 }, { actual: 0.34, optimal: 0.42 }],
        _simsPerGame: 25,
        requestId: deltaMsg!.requestId,
      },
    } as MessageEvent);
    expect(screen.queryByText(/would lift you/)).not.toBeInTheDocument();
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('gain');
    // And no further delta sweep was requested by the switch-back.
    expect(worker.posted.filter(m => m.type === 'computeGamesDelta')).toHaveLength(2);
  }, 15000);
});
