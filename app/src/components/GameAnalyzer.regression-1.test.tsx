// @vitest-environment jsdom
// Regression: ISSUE-005 — the J-Archive box takes a game_id, but the number
// people know is the show #, which silently loads a different game.
// Found by /qa on 2026-09-23
// Report: .gstack/qa-reports/qa-report-jeopardy-strategy-simulator-vercel-app-2026-09-23.md
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameAnalyzer } from './GameAnalyzer';

describe('GameAnalyzer — J-Archive game ID input', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('explains that it wants the game_id, not the show number', () => {
    render(<GameAnalyzer onEstimate={vi.fn()} />);
    expect(screen.getByText(/not the show #/)).toBeInTheDocument();
  });

  it('pulls the game_id out of a pasted j-archive.com link', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, text: async () => 'nope' } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);

    await user.type(
      screen.getByLabelText('J-Archive game ID'),
      'https://j-archive.com/showgame.php?game_id=6862',
    );
    await user.click(screen.getByText('Load'));

    expect(fetchMock).toHaveBeenCalledWith('/api/jarchive?game=6862');
  });

  it('still sends a bare game_id unchanged', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, text: async () => 'nope' } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<GameAnalyzer onEstimate={vi.fn()} />);

    await user.type(screen.getByLabelText('J-Archive game ID'), ' 6862 ');
    await user.click(screen.getByText('Load'));

    expect(fetchMock).toHaveBeenCalledWith('/api/jarchive?game=6862');
  });
});
