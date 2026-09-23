// @vitest-environment jsdom
// Regression: ISSUE-006 — after a J-Archive load, "Equity-optimal was $5"
// (hidden 55% default confidence) sat above a backtest saying $17,200
// (the contestant's real 91% accuracy) for the same Daily Double.
// Found by /qa on 2026-09-23
// Report: .gstack/qa-reports/qa-report-jeopardy-strategy-simulator-vercel-app-2026-09-23.md
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameAnalyzer } from './GameAnalyzer';
import type { JArchiveGameResponse } from '../lib/jarchive';

const GAME: JArchiveGameResponse = {
  gameId: 6862,
  title: 'J! Archive - Show #8276, aired 2020-11-09',
  players: ['Andrew', 'Monisha', 'Ben'],
  fullNames: ['Ben Lewis', 'Monisha Crisell', 'Andrew Chaikin'],
  validation: { checked: 3, mismatches: [] },
  contestants: [
    { name: 'Andrew', correct: 25, wrong: 0, coryat: 19800, finalScore: 24399 },
    { name: 'Monisha', correct: 10, wrong: 0, coryat: 10000, finalScore: 10000 },
    { name: 'Ben', correct: 20, wrong: 2, coryat: 11600, finalScore: 17200 },
  ],
  dailyDoubles: [
    { round: 'DJ', clueValue: 1600, who: 'Ben', scoreBefore: 17200, wager: 5000, correct: true, scoreAfter: 22200, allScoresBefore: [19400, 6400, 17200], cluesRemainingAfter: 13 },
  ],
};

async function pick(name: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(GAME) } as Response)));
  const user = userEvent.setup();
  render(<GameAnalyzer onEstimate={vi.fn()} />);
  await user.type(screen.getByLabelText('J-Archive game ID'), '6862');
  await user.click(screen.getByText('Load'));
  await screen.findByText(/which contestant are you/);
  await user.click(screen.getByRole('button', { name }));
  await user.click(screen.getByText('Show DD & FJ details'));
}

describe("GameAnalyzer — DD confidence follows the picked contestant", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets confidence to the contestant's accuracy and names it next to the wagers", async () => {
    await pick('Ben'); // 20 of 22 → 91%
    expect(screen.getByLabelText("Confidence you'd get the Daily Double right")).toHaveValue('91');
    expect(screen.getByText(/at 91% confidence/)).toBeInTheDocument();
  }, 15000);

  it('clamps a perfect game to the slider top of 95%', async () => {
    await pick('Andrew'); // 25 of 25
    expect(screen.getByLabelText("Confidence you'd get the Daily Double right")).toHaveValue('95');
  }, 15000);
});
