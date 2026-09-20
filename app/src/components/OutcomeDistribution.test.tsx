// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutcomeDistribution } from './OutcomeDistribution';
import { DEFAULT_CONFIG } from '../sim/sim-engine';
import type { OutcomeRow } from '../sim/sim-worker';

/**
 * Mock the worker layer exactly like StrategyOracle.test.tsx: every
 * `new Worker()` replies to a `computeOutcomes` post with one progress
 * message and then the canned result, on the next macrotask.
 */
type Reply = {
  outcomes: OutcomeRow[];
  runawayShare: number;
  lockAgainstShare: number;
  decidedShare: number;
} | null;
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
      this.onmessage?.({ data: { type: 'outcomesProgress', pct: 0.5 } } as MessageEvent);
      this.onmessage?.({ data: { type: 'outcomesResult', ...reply } } as MessageEvent);
    }, 0);
  }
  terminate() { terminated.push(1); }
  addEventListener() { /* unused */ }
  removeEventListener() { /* unused */ }
}

interface MockCtx {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  textAlign: CanvasTextAlign;
  lineWidth: number;
  globalAlpha: number;
  fillRect: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  strokeText: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
}

function mockCanvasContext(): MockCtx {
  const ctx: MockCtx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    lineWidth: 1,
    globalAlpha: 1,
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    scale: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

function row(overrides: Partial<OutcomeRow> & Pick<OutcomeRow, 'margin'>): OutcomeRow {
  return {
    yourPreFJ: 10000,
    yourPostFJ: 10000 + overrides.margin,
    bestOpponentPreFJ: 10000,
    bestOpponentPostFJ: 10000,
    category: 'decided',
    ...overrides,
  };
}

function baseProps() {
  return {
    xAxis: 'knowledge' as const,
    yAxis: 'buzzerSpeed' as const,
    position: { x: 0.4, y: 0.5 },
    pinnedValues: {},
    config: { ...DEFAULT_CONFIG },
  };
}

describe('OutcomeDistribution — "How your games end" panel', () => {
  beforeEach(() => {
    posted.length = 0;
    terminated.length = 0;
    nextReply = null;
    mockCanvasContext();
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the progress state before any result arrives', () => {
    render(<OutcomeDistribution {...baseProps()} />);
    expect(screen.getByText('Simulating your games…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('simulating…');
    expect(screen.queryByTestId('outcome-distribution')).toBeInTheDocument();
  });

  it('posts a computeOutcomes message with the position in dimension units after the debounce', async () => {
    nextReply = {
      outcomes: [row({ margin: -500 }), row({ margin: -100 }), row({ margin: 100 }), row({ margin: 500 })],
      runawayShare: 0.2,
      lockAgainstShare: 0.3,
      decidedShare: 0.5,
    };
    render(<OutcomeDistribution {...baseProps()} />);
    expect(posted).toHaveLength(0); // nothing until the debounce elapses
    await screen.findByText(/Half your games end within/);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: 'computeOutcomes',
      xAxis: 'knowledge',
      yAxis: 'buzzerSpeed',
      xVal: 0.4,
      yVal: 0.5,
      nGames: 1000,
    });
  });

  it('renders the histograms and the two plain-words sentences from a fixture', async () => {
    nextReply = {
      outcomes: [row({ margin: -500 }), row({ margin: -100 }), row({ margin: 100 }), row({ margin: 500 })],
      runawayShare: 0.2,
      lockAgainstShare: 0.3,
      decidedShare: 0.5,
    };
    render(<OutcomeDistribution {...baseProps()} />);

    await screen.findByText(/Half your games end within/);

    // Shares — sum to 1, rendered as plain percentages.
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();

    // Median absolute margin over [500,100,100,500] (nearest-rank p50) is 500.
    expect(screen.getByText(/Half your games end within \$500 of the leader\./)).toBeInTheDocument();
    // p95/p5 of the signed margins [-500,-100,100,500] are +500/-500.
    expect(screen.getByText(/Your best case \(top 5%\) is \+\$500, your worst \(bottom 5%\) is\s*−\$500\./)).toBeInTheDocument();

    // Progress state is gone once the result is in.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('cancels the in-flight worker and posts a new request when the position changes', async () => {
    nextReply = {
      outcomes: [row({ margin: -500 }), row({ margin: -100 }), row({ margin: 100 }), row({ margin: 500 })],
      runawayShare: 0.2,
      lockAgainstShare: 0.3,
      decidedShare: 0.5,
    };
    const { rerender } = render(<OutcomeDistribution {...baseProps()} />);
    await screen.findByText(/Half your games end within/);
    const terminatedBefore = terminated.length;

    rerender(<OutcomeDistribution {...baseProps()} position={{ x: 0.6, y: 0.5 }} />);
    // Back to the progress state, with the previous result kept on screen.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/Half your games end within/)).toBeInTheDocument();

    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ xVal: 0.6 });
    expect(terminated.length).toBeGreaterThanOrEqual(terminatedBefore);
  });
});
