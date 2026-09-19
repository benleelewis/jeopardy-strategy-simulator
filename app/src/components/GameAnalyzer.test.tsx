// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameAnalyzer } from './GameAnalyzer';
import type { JArchiveGameResponse } from '../lib/jarchive';

async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Show DD & FJ details'));
}

const FAKE_GAME: JArchiveGameResponse = {
  gameId: 9501,
  title: 'J! Archive - Show #9612',
  players: ['Sam', 'Grace', 'Joey'],
  fullNames: ['Sam A', 'Grace B', 'Joey C'],
  validation: { checked: 3, mismatches: [] },
  contestants: [
    { name: 'Sam', correct: 14, wrong: 3, coryat: 8600, finalScore: 14801 },
    { name: 'Grace', correct: 25, wrong: 3, coryat: 20200, finalScore: 32000 },
    { name: 'Joey', correct: 12, wrong: 1, coryat: 7400, finalScore: 8700 },
  ],
  dailyDoubles: [
    { round: 'J', clueValue: 800, who: 'Grace', scoreBefore: 3400, wager: 1400, correct: true, scoreAfter: 4800, allScoresBefore: [1800, 3400, 0], cluesRemainingAfter: 18 },
    { round: 'DJ', clueValue: 2000, who: 'Joey', scoreBefore: 4200, wager: 2000, correct: true, scoreAfter: 6200, allScoresBefore: [7000, 11200, 4200], cluesRemainingAfter: 23 },
    { round: 'DJ', clueValue: 800, who: 'Grace', scoreBefore: 19200, wager: 10000, correct: true, scoreAfter: 29200, allScoresBefore: [7800, 19200, 7000], cluesRemainingAfter: 7 },
  ],
};

async function loadFakeGame(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('J-Archive game ID'), '9501');
  await user.click(screen.getByText('Load'));
  await screen.findByText(/which contestant are you/);
}

describe('GameAnalyzer — DD wager validation (E-7 item 6)', () => {
  it('prompts for a wager instead of rendering a chart when the DD wager field is empty', async () => {
    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await openAdvanced(user);

    expect(screen.getByText(/enter a DD wager to see the curve/)).toBeInTheDocument();
    // Never renders from an absent/invalid wager — no equity SVG at all.
    expect(screen.queryByRole('img', { name: /Equity versus wager curve/ })).not.toBeInTheDocument();
  });

  it('clamps a negative DD wager to $0 with an inline hint', async () => {
    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await openAdvanced(user);

    const ddWagerInput = screen.getByPlaceholderText('e.g. 5000');
    fireEvent.change(ddWagerInput, { target: { value: '-500' } });

    expect(screen.getByText(/can't be negative/)).toBeInTheDocument();
  });

  it('clamps an absurdly large DD wager with an inline hint', async () => {
    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await openAdvanced(user);

    const ddWagerInput = screen.getByPlaceholderText('e.g. 5000');
    fireEvent.change(ddWagerInput, { target: { value: '5000000' } });

    expect(screen.getByText(/unusually high wager/)).toBeInTheDocument();
  });

  it('renders the equity chart once a valid DD wager is entered, with an aria-label carrying both wagers', async () => {
    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await openAdvanced(user);

    const ddWagerInput = screen.getByPlaceholderText('e.g. 5000');
    fireEvent.change(ddWagerInput, { target: { value: '5000' } });

    const chart = await screen.findByRole('img', { name: /Equity versus wager curve/ });
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('Your wager: $5,000'));
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('Optimal wager: $'));
    expect(screen.getByText(/You bet \$5,000\. Optimal: \$/)).toBeInTheDocument();
  }, 15000);
});

describe('GameAnalyzer — confidence slider drives the chart live (E-7 item 5)', () => {
  it('defaults to 55% and changing it recomputes the equity copy', async () => {
    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await openAdvanced(user);

    const confidenceSlider = screen.getByRole('slider', { name: "Confidence you'd get the Daily Double right" });
    expect(confidenceSlider).toHaveAttribute('aria-valuenow', '55');

    const ddWagerInput = screen.getByPlaceholderText('e.g. 5000');
    fireEvent.change(ddWagerInput, { target: { value: '5000' } });
    const before = (await screen.findByText(/You bet \$5,000\./)).textContent;

    fireEvent.change(confidenceSlider, { target: { value: '90' } });
    expect(confidenceSlider).toHaveAttribute('aria-valuenow', '90');

    const after = screen.getByText(/You bet \$5,000\./).textContent;
    expect(after).not.toBe(before);
  }, 15000);
});

describe('GameAnalyzer — load from J-Archive', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a game, picks a contestant, and fills correct/wrong/Coryat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(FAKE_GAME),
    } as Response)));

    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await loadFakeGame(user);

    await user.click(screen.getByRole('button', { name: 'Grace' }));

    expect(screen.getByLabelText('Correct')).toHaveValue(25);
    expect(screen.getByLabelText('Wrong')).toHaveValue(3);
    expect(screen.getByLabelText('Coryat (excl. DD/FJ)')).toHaveValue(20200);
  }, 15000);

  it("renders the picked contestant's Daily Doubles with equity-optimal wagers", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(FAKE_GAME),
    } as Response)));

    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await loadFakeGame(user);
    await user.click(screen.getByRole('button', { name: 'Grace' }));

    // Grace hit DD 1 (J) and DD 3 (DJ); the Joey DD must not show up.
    const lines = await screen.findAllByText(/Equity-optimal was \$/);
    expect(lines).toHaveLength(2);
    expect(screen.getByText(/J round: you bet \$1,400\./)).toBeInTheDocument();
    expect(screen.getByText(/DJ round: you bet \$10,000\./)).toBeInTheDocument();
  }, 15000);

  it('shows a plain-word inline error on a failed fetch, without breaking manual entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => "couldn't parse — try manual entry instead.",
    } as Response)));

    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await user.type(screen.getByLabelText('J-Archive game ID'), '1');
    await user.click(screen.getByText('Load'));

    expect(await screen.findByText(/couldn't parse/i)).toBeInTheDocument();
    // Manual entry is untouched — the field is still there and editable.
    const correctInput = screen.getByLabelText('Correct');
    expect(correctInput).toBeEnabled();
  });

  it('falls back to a clear message when the dev server returns HTML instead of JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><html><body>Vite dev index</body></html>',
    } as Response)));

    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    await user.type(screen.getByLabelText('J-Archive game ID'), '9501');
    await user.click(screen.getByText('Load'));

    expect(await screen.findByText(/isn't available in this dev server/)).toBeInTheDocument();
  });
});
