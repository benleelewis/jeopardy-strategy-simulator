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
