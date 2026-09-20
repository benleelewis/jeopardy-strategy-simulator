// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GameReplay, type ReplayRun } from './GameReplay';
import type { DDEvent } from '../sim/sim-engine';

const NAMES: [string, string, string] = ['You', 'Alice', 'Bob'];

// A short fixture: 4 clue-by-clue snapshots (all within the J round, since
// buildFrames only switches to "Double Jeopardy" past index 30) plus a
// Daily Double on the 2nd clue. No Final Jeopardy entry, so history.length
// (4) === clueSteps (4) and buildFrames emits exactly 4 frames.
const HISTORY: [number, number, number][] = [
  [200, 0, 0],
  [200, 400, 0],
  [200, 400, -600],
  [200, 800, -600],
];

const DD_EVENTS: DDEvent[] = [
  { round: 'J', clueIndex: 1, player: 1, wager: 400, correct: true, scoreBefore: 0, scoreAfter: 400 },
];

function fixtureRun(): ReplayRun {
  return {
    scores: [200, 800, -600],
    winner: 1,
    history: HISTORY,
    ddEvents: DD_EVENTS,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('GameReplay', () => {
  it('renders the three score bars from a fixture history', () => {
    render(<GameReplay run={fixtureRun()} playerNames={NAMES} />);

    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();

    // Frame 0 === history[0]: you're up $200, opponents still at $0.
    expect(screen.getByText('$200')).toBeInTheDocument();
    expect(screen.getAllByText('$0').length).toBeGreaterThanOrEqual(2);

    expect(screen.getByText(/Jeopardy, clue 1 of 30/)).toBeInTheDocument();
  });

  it('Play advances the clue counter', () => {
    render(<GameReplay run={fixtureRun()} playerNames={NAMES} />);
    expect(screen.getByText(/clue 1 of 30/)).toBeInTheDocument();

    // Autoplay is on by default when the replay opens; advance past frame
    // 0's duration (180ms) so it steps to frame 1 (the Daily Double clue).
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(screen.getByText(/clue 2 of 30/)).toBeInTheDocument();
    expect(screen.getByText(/Daily Double: Alice wagered \$400, correct/)).toBeInTheDocument();
  });

  it('Pause stops it', () => {
    render(<GameReplay run={fixtureRun()} playerNames={NAMES} />);

    fireEvent.click(screen.getByText('Pause'));

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Still on frame 0 — nothing should have advanced while paused.
    expect(screen.getByText(/clue 1 of 30/)).toBeInTheDocument();
    expect(screen.getByText('Play')).toBeInTheDocument();
  });

  it('Restart resets to the first frame', () => {
    render(<GameReplay run={fixtureRun()} playerNames={NAMES} />);

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText(/clue 2 of 30/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Restart'));

    expect(screen.getByText(/clue 1 of 30/)).toBeInTheDocument();
    // Restart resumes playback.
    expect(screen.getByText('Pause')).toBeInTheDocument();
  });

  it('clears its timer on unmount (no orphan timers)', () => {
    const { unmount } = render(<GameReplay run={fixtureRun()} playerNames={NAMES} />);

    // A timer should be scheduled (autoplay is on by default).
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when paused, mid-playback, before unmount', () => {
    const { unmount } = render(<GameReplay run={fixtureRun()} playerNames={NAMES} />);
    fireEvent.click(screen.getByText('Pause'));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
