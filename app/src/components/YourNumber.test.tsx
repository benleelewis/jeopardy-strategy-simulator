// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { YourNumber, renderShareCard } from './YourNumber';
import type { ShareCardData, ShareCardColors } from './YourNumber';

/** navigator.share/canShare are typed as always-present in lib.dom.d.ts,
 *  but jsdom doesn't implement the Web Share API. A standalone (rather than
 *  `Navigator &`-intersected) type keeps both fields genuinely optional so
 *  `delete` is allowed, and tests can add/remove the mocks between cases. */
interface ShareCapableNavigator {
  share?: (data?: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

function shareNav(): ShareCapableNavigator {
  return navigator as unknown as ShareCapableNavigator;
}

const SAMPLE_WIN_RATES = [0.6, 0.62, 0.2, 0.4, 0.8, 0.1, 0.55, 0.35, 0.9, 0.25];

interface MockCtx {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  textAlign: CanvasTextAlign;
  lineWidth: number;
  fillRect: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  strokeText: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
}

function mockCanvasContext(): MockCtx {
  const ctx: MockCtx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    lineWidth: 1,
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    // The page's own Histogram sub-component (unrelated to renderShareCard)
    // also mounts a real <canvas> and calls ctx.scale(dpr, dpr) — needed
    // here purely so YourNumber renders without throwing in jsdom.
    scale: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

describe('YourNumber — Share button visibility', () => {
  beforeEach(() => {
    mockCanvasContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is absent before win rates exist', () => {
    render(<YourNumber winRates={[]} isSimulating={false} />);
    expect(screen.queryByRole('button', { name: /share your number/i })).not.toBeInTheDocument();
  });

  it('appears once win rates exist', () => {
    render(<YourNumber winRates={SAMPLE_WIN_RATES} isSimulating={false} />);
    expect(screen.getByRole('button', { name: /share your number/i })).toBeInTheDocument();
  });
});

describe('YourNumber — Share button behaviour', () => {
  let toBlobMock: ReturnType<typeof vi.fn<typeof HTMLCanvasElement.prototype.toBlob>>;
  let createObjectURLMock: ReturnType<typeof vi.fn<typeof URL.createObjectURL>>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn<typeof URL.revokeObjectURL>>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCanvasContext();

    toBlobMock = vi.fn<typeof HTMLCanvasElement.prototype.toBlob>((callback) => {
      callback(new Blob(['fake-png-bytes'], { type: 'image/png' }));
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(toBlobMock);

    createObjectURLMock = vi.fn<typeof URL.createObjectURL>(() => 'blob:mock-url');
    revokeObjectURLMock = vi.fn<typeof URL.revokeObjectURL>(() => {});
    URL.createObjectURL = createObjectURLMock;
    URL.revokeObjectURL = revokeObjectURLMock;

    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    delete shareNav().share;
    delete shareNav().canShare;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete shareNav().share;
    delete shareNav().canShare;
  });

  it('renders a PNG via canvas.toBlob and downloads it through a temporary anchor when navigator.share is unavailable', async () => {
    const user = userEvent.setup();
    expect(shareNav().share).toBeUndefined();

    render(<YourNumber winRates={SAMPLE_WIN_RATES} isSimulating={false} />);
    await user.click(screen.getByRole('button', { name: /share your number/i }));

    expect(toBlobMock).toHaveBeenCalledTimes(1);
    expect(toBlobMock.mock.calls[0][1]).toBe('image/png');

    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');

    expect(await screen.findByText('Saved!')).toBeInTheDocument();
  });

  it('shares the PNG as a file when navigator.share + navigator.canShare are available', async () => {
    const user = userEvent.setup();
    const shareMock = vi.fn<(data?: ShareData) => Promise<void>>(async () => undefined);
    const canShareMock = vi.fn<(data?: ShareData) => boolean>(() => true);
    shareNav().share = shareMock;
    shareNav().canShare = canShareMock;

    render(<YourNumber winRates={SAMPLE_WIN_RATES} isSimulating={false} />);
    await user.click(screen.getByRole('button', { name: /share your number/i }));

    expect(await screen.findByText('Shared!')).toBeInTheDocument();
    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(canShareMock).toHaveBeenCalled();

    const shareArg = shareMock.mock.calls[0][0] as { files: File[] };
    expect(shareArg.files).toHaveLength(1);
    expect(shareArg.files[0].name).toBe('jeopardy-your-number.png');
    expect(shareArg.files[0].type).toBe('image/png');
    expect(createObjectURLMock).not.toHaveBeenCalled();
  });
});

describe('renderShareCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws the headline, tiles, distribution histogram, knobs, and footer URL onto a 1200x630 canvas', () => {
    const ctx = mockCanvasContext();
    const canvas = document.createElement('canvas');

    const data: ShareCardData = {
      winRate: 0.42,
      totalGames: 8665,
      favored: 2800,
      tossUp: 3200,
      underdog: 2665,
      bins: [10, 20, 30, 40, 50, 40, 30, 20, 10, 5],
      maxBin: 50,
      knowledge: 0.4,
      buzzerSpeed: 0.5,
    };
    const colors: ShareCardColors = {
      cg1: '#060a30',
      cg2: '#0a1566',
      cg3: '#1a3ba8',
      cg4: '#c5a028',
      cg5: '#f5d442',
      bg: '#fafafa',
      textH: '#111827',
    };

    renderShareCard(canvas, data, colors);

    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(630);

    const textCalls = ctx.fillText.mock.calls.map(call => call[0] as string);
    expect(textCalls).toContain('42%');
    expect(textCalls.some(t => t.includes('8,665'))).toBe(true);
    expect(textCalls.some(t => t.includes('Knowledge 40%') && t.includes('Buzzer Speed 50%'))).toBe(true);
    expect(textCalls).toContain('jeopardy-strategy-simulator.vercel.app');

    // 10 histogram bars + 3 tiles + headline + subtitle + eyebrow + labels + footer
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThanOrEqual(data.bins.length);
  });
});
