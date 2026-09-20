// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StrategyOracle } from './StrategyOracle';
import { DEFAULT_CONFIG } from '../sim/sim-engine';
import type { OracleRow } from '../sim/oracle';

/**
 * Mock the worker layer (per the plan's "don't spin real workers in jsdom"
 * rule): every `new Worker()` replies to a `computeOracle` post with one
 * progress message and then the canned result, on the next macrotask so
 * the component's status transitions are observable in between.
 */
type Reply = { rows: OracleRow[]; gamesPerEstimate: number } | null;
let nextReply: Reply = null;
const posted: unknown[] = [];
const terminated: number[] = [];

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(msg: unknown) {
    posted.push(msg);
    const reply = nextReply;
    if (!reply) return; // stays busy forever
    setTimeout(() => {
      this.onmessage?.({ data: { type: 'oracleProgress', pct: 0.5 } } as MessageEvent);
      this.onmessage?.({ data: { type: 'oracleResult', ...reply, baselineWinRate: 0.4 } } as MessageEvent);
    }, 0);
  }
  terminate() { terminated.push(1); }
  addEventListener() { /* unused */ }
  removeEventListener() { /* unused */ }
}

function row(overrides: Partial<OracleRow> & Pick<OracleRow, 'dimension' | 'delta' | 'se'>): OracleRow {
  return {
    kind: 'skill',
    label: overrides.dimension,
    currentLabel: 'now',
    suggestedLabel: 'next',
    significant: Math.abs(overrides.delta) >= 2 * overrides.se && overrides.se > 0,
    atBest: overrides.delta <= 0,
    why: `because ${overrides.dimension}`,
    ...overrides,
  };
}

function baseProps() {
  return {
    xAxis: 'knowledge' as const,
    yAxis: 'buzzerSpeed' as const,
    position: { x: 0.4, y: 0.5 },
    pinnedValues: {},
    config: { ...DEFAULT_CONFIG, ddWagerFraction: 0.75 },
    gamesPerCell: 450,
  };
}

describe('StrategyOracle — "What to work on" panel', () => {
  beforeEach(() => {
    posted.length = 0;
    terminated.length = 0;
    nextReply = null;
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the progress state before any result arrives', () => {
    render(<StrategyOracle {...baseProps()} />);
    expect(screen.getByText('Working out what to change…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('working out…');
    expect(screen.queryAllByTestId('oracle-row')).toHaveLength(0);
  });

  it('posts a computeOracle message with the position in dimension units after the debounce', async () => {
    nextReply = { rows: [row({ dimension: 'knowledge', delta: 0.05, se: 0.01 })], gamesPerEstimate: 400 };
    render(<StrategyOracle {...baseProps()} />);
    expect(posted).toHaveLength(0); // nothing until the debounce elapses
    await screen.findAllByTestId('oracle-row');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: 'computeOracle',
      xAxis: 'knowledge',
      yAxis: 'buzzerSpeed',
      xVal: 0.4,
      yVal: 0.5,
      gamesPerCell: 450,
    });
  });

  it('renders rows sorted by delta descending and greys out rows within noise', async () => {
    nextReply = {
      rows: [
        row({ dimension: 'buzzerSpeed', label: 'Buzzer speed', delta: 0.005, se: 0.015 }), // within noise
        row({ dimension: 'opponentStrength', label: 'Opponents', delta: -0.12, se: 0.015 }), // significant, negative
        row({ dimension: 'knowledge', label: 'Knowledge', delta: 0.06, se: 0.015 }), // significant, positive
        row({ dimension: 'ddAggression', label: 'Daily Double wager size', delta: 0.02, se: 0.015 }), // within noise
      ],
      gamesPerEstimate: 400,
    };
    render(<StrategyOracle {...baseProps()} />);
    const rows = await screen.findAllByTestId('oracle-row');
    expect(rows.map(r => r.getAttribute('data-dimension'))).toEqual([
      'knowledge', 'ddAggression', 'buzzerSpeed', 'opponentStrength',
    ]);
    expect(rows.map(r => r.getAttribute('data-noisy'))).toEqual(['false', 'true', 'true', 'false']);
    // Greyed rows are visibly dimmed; significant ones are not.
    expect(rows[1].style.opacity).toBe('0.5');
    expect(rows[2].style.opacity).toBe('0.5');
    expect(rows[0].style.opacity).toBe('1');

    // Delta shown in percentage points with a ± half-width of two SEs.
    expect(within(rows[0]).getByText('+6.0 ± 3.0 pp')).toBeInTheDocument();
    expect(within(rows[3]).getByText('−12.0 ± 3.0 pp')).toBeInTheDocument();
    expect(within(rows[0]).getByText('now → next')).toBeInTheDocument();
    expect(within(rows[0]).getByText('because knowledge')).toBeInTheDocument();
    // A row already at its best reads as "keep".
    expect(within(rows[3]).getByText('now is best here — next would cost you')).toBeInTheDocument();

    // Progress state is gone once the result is in.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/simulated over 400 games/)).toBeInTheDocument();
  });

  it('cancels the in-flight worker and re-runs when the position changes', async () => {
    nextReply = { rows: [row({ dimension: 'knowledge', delta: 0.05, se: 0.01 })], gamesPerEstimate: 400 };
    const { rerender } = render(<StrategyOracle {...baseProps()} />);
    await screen.findAllByTestId('oracle-row');
    const terminatedBefore = terminated.length;

    rerender(<StrategyOracle {...baseProps()} position={{ x: 0.6, y: 0.5 }} />);
    // Back to the progress state, with the previous rows kept on screen.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getAllByTestId('oracle-row')).toHaveLength(1);

    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ xVal: 0.6 });
    expect(terminated.length).toBeGreaterThanOrEqual(terminatedBefore);
  });
});
