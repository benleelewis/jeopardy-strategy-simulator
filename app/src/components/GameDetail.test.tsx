// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { GameDetail, type DDGameDetail, type SimRun, type WhatIfResult } from './GameDetail';
import type { GameData } from './ContributionGraph';
import type { ValueTable, ValueTableDims } from '../sim/value-function';

// TODOS "P2 — GameDetail DD event rows": fixture game + one seeded sim's DD
// events (as the sim-worker's new `simulateGameDetail` message would return).
const game: GameData = {
  s: 40,
  d: '2024-01-01',
  o: [
    { n: 'Alex Trebek', k: 0.8, b: 0.5, fj: 1, c: 15000 },
    { n: 'Ken Jennings', k: 0.75, b: 0.45, fj: 1, c: 14000 },
  ],
};

// A minimal 1-cell V(S) table: every query returns the same win probability
// regardless of state. Deliberately constructed (not built from rollouts) so
// equityWager's argmax is deterministic and cheap to reason about in a test:
// with V(S) constant, Equity(bet) is identical for every candidate wager, so
// the grid search's strict `>` comparison never replaces its first
// candidate — the optimal wager is always the $5 real-rules floor.
const CONSTANT_DIMS: ValueTableDims = {
  skillKnowledge: { min: 0, max: 1, n: 1 },
  skillBuzzer: { min: 0, max: 1, n: 1 },
  yourShare: { min: 0, max: 1.5, n: 1 },
  leaderRatio: { min: 0, max: 2, n: 1 },
  thirdRatio: { min: 0, max: 2, n: 1 },
  cluesRemaining: { min: 0, max: 30, n: 1 },
};
const constantValueTable: ValueTable = {
  dims: CONSTANT_DIMS,
  data: new Float32Array([0.5]),
  rolloutsPerCell: 1,
  buildMs: 0,
  cellCount: 1,
  nominalTotalAt0Remaining: 17000,
  nominalTotalAt30Remaining: 8000,
};

const ddDetail: DDGameDetail = {
  gameIndex: 0,
  you: { knowledge: 0.5, buzzerSpeed: 0.5 },
  ddEvents: [
    {
      round: 'DJ',
      clueIndex: 12,
      player: 0,
      wager: 5000,
      correct: true,
      scoreBefore: 6000,
      scoreAfter: 11000,
      clueValue: 1600,
      scoresBefore: [6000, 4000, 3000],
      cluesRemainingAfter: 10,
      adjustedP: 0.6,
    },
    {
      round: 'J',
      clueIndex: 5,
      player: 1,
      wager: 800,
      correct: false,
      scoreBefore: 2000,
      scoreAfter: 1200,
      clueValue: 800,
      scoresBefore: [1000, 2000, 500],
      cluesRemainingAfter: 20,
      adjustedP: 0.5,
    },
  ],
};

// Non-null simResults so the (unrelated) Simulations section doesn't also
// render its own "Simulating..." text and collide with the DD section's.
const simResultsFixture: SimRun[] = [
  { scores: [11000, 6000, 4000], winner: 0 },
];

describe('GameDetail — Daily Doubles section (TODOS "P2 — GameDetail DD event rows")', () => {
  it('renders one row per DD event with round, value, who, before/after, wager, and result', () => {
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={constantValueTable}
      />,
    );

    expect(screen.getByText('Daily Doubles')).toBeInTheDocument();

    const rows = screen.getAllByRole('row');
    // header + 2 DD events
    expect(rows).toHaveLength(3);

    const yourRow = rows[1];
    expect(within(yourRow).getByText('DJ')).toBeInTheDocument();
    expect(within(yourRow).getByText('$1,600')).toBeInTheDocument();
    expect(within(yourRow).getByText('You')).toBeInTheDocument();
    expect(within(yourRow).getByText('$6,000')).toBeInTheDocument();
    expect(within(yourRow).getByText('$5,000')).toBeInTheDocument();
    expect(within(yourRow).getByText('Correct')).toBeInTheDocument();
    expect(within(yourRow).getByText('$11,000')).toBeInTheDocument();

    const oppRow = rows[2];
    expect(within(oppRow).getByText('J')).toBeInTheDocument();
    // player: 1 → game.o[0] ("Alex Trebek"), first name only.
    expect(within(oppRow).getByText('Alex')).toBeInTheDocument();
    expect(within(oppRow).getByText('Wrong')).toBeInTheDocument();
    expect(within(oppRow).getByText('$1,200')).toBeInTheDocument();
    // Opponent rows never get an equity-optimal figure.
    expect(within(oppRow).getByText('—')).toBeInTheDocument();
  });

  it('shows the equity-optimal wager and a plain-words comparison for a "you" row when the gap exceeds $500', () => {
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={constantValueTable}
      />,
    );

    // Constant-table optimal wager is always the $5 floor (see doc above);
    // you wagered $5,000, so the gap is $4,995 — over the $500 threshold.
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('$5')).toBeInTheDocument();
    expect(
      screen.getByText('You wagered $4,995 more than the equity-optimal $5.'),
    ).toBeInTheDocument();
  });

  it('omits the plain-words comparison when the gap is $500 or less', () => {
    const closeDetail: DDGameDetail = {
      gameIndex: 0,
      you: { knowledge: 0.5, buzzerSpeed: 0.5 },
      ddEvents: [
        { ...ddDetail.ddEvents[0], wager: 400 }, // $400 vs $5 optimal = $395 gap
      ],
    };
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={closeDetail}
        valueTable={constantValueTable}
      />,
    );

    expect(screen.queryByText(/equity-optimal/)).not.toBeInTheDocument();
  });

  it('shows a build-it-first hint instead of a number when no V-table is cached', () => {
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={undefined}
      />,
    );

    expect(
      screen.getByText('Build the Optimal (equity) strategy in the Explorer to see this'),
    ).toBeInTheDocument();
  });

  it('shows a simulating placeholder before the seeded DD sim result arrives', () => {
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={null}
        valueTable={constantValueTable}
      />,
    );

    expect(screen.getByText('Simulating...')).toBeInTheDocument();
  });

  it('ignores a DD detail result meant for a different game (stale-result guard)', () => {
    const staleDetail: DDGameDetail = { ...ddDetail, gameIndex: 1 };
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={staleDetail}
        valueTable={constantValueTable}
      />,
    );

    expect(screen.getByText('Simulating...')).toBeInTheDocument();
    expect(screen.queryByRole('row')).not.toBeInTheDocument();
  });
});

describe('GameDetail — "What if you had wagered differently?" (TASKS.md Phase 1F)', () => {
  it('shows the what-if control only on a "you" row with the resume fields present', () => {
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={constantValueTable}
      />,
    );

    const rows = screen.getAllByRole('row');
    const yourRow = rows[1];
    const oppRow = rows[2];

    expect(within(yourRow).getByRole('button', { name: 'What if' })).toBeInTheDocument();
    expect(within(oppRow).queryByRole('button', { name: 'What if' })).not.toBeInTheDocument();
  });

  it('hides the control when the event lacks scoresBefore/cluesRemainingAfter (older results)', () => {
    const oldDetail: DDGameDetail = {
      gameIndex: 0,
      you: { knowledge: 0.5, buzzerSpeed: 0.5 },
      ddEvents: [
        { ...ddDetail.ddEvents[0], scoresBefore: undefined, cluesRemainingAfter: undefined },
      ],
    };
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={oldDetail}
        valueTable={constantValueTable}
      />,
    );

    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).queryByRole('button', { name: 'What if' })).not.toBeInTheDocument();
  });

  it('clicking "What if" reports the row index and the typed wager to the caller', () => {
    const onWhatIfWager = vi.fn();
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={constantValueTable}
        onWhatIfWager={onWhatIfWager}
      />,
    );

    const input = screen.getByLabelText('What-if wager for Daily Double 0') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '6000' } });
    fireEvent.click(screen.getByRole('button', { name: 'What if' }));

    expect(onWhatIfWager).toHaveBeenCalledWith(0, 6000);
  });

  it('clamps a typed wager above the real-rules max (max(score, clue value)) before reporting it', () => {
    const onWhatIfWager = vi.fn();
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={constantValueTable}
        onWhatIfWager={onWhatIfWager}
      />,
    );

    // event 0: scoreBefore $6,000, clueValue $1,600 → real-rules max is $6,000.
    const input = screen.getByLabelText('What-if wager for Daily Double 0');
    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'What if' }));

    expect(onWhatIfWager).toHaveBeenCalledWith(0, 6000);
  });

  it('renders the result line from a fixture whatIfWager message, with the equity-optimal note', () => {
    const whatIfResult: WhatIfResult = {
      gameIndex: 0,
      ddEventIndex: 0,
      actualWager: 5000,
      whatIfWagerAmount: 5,
      actualWinRate: 0.41,
      whatIfWinRate: 0.47,
      diff: 0.06,
      se: 0.02,
    };
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={constantValueTable}
        whatIfResult={whatIfResult}
      />,
    );

    // Constant-table optimal wager is always the $5 floor (see doc above);
    // the fixture's whatIfWagerAmount ($5) matches it, so the equity-optimal
    // note should render alongside the win-chance line.
    expect(
      screen.getByText(/Win chance: 41% with your \$5,000 → 47% with \$5/),
    ).toBeInTheDocument();
    expect(screen.getByText('This is the equity-optimal wager for this state.')).toBeInTheDocument();
  });

  it('does not render a stale result for a different game', () => {
    const whatIfResult: WhatIfResult = {
      gameIndex: 1, // a different game than the one being rendered (index 0)
      ddEventIndex: 0,
      actualWager: 5000,
      whatIfWagerAmount: 6000,
      actualWinRate: 0.41,
      whatIfWinRate: 0.47,
      diff: 0.06,
      se: 0.02,
    };
    render(
      <GameDetail
        game={game}
        index={0}
        winRate={0.4}
        onClose={() => {}}
        simResults={simResultsFixture}
        ddDetail={ddDetail}
        valueTable={constantValueTable}
        whatIfResult={whatIfResult}
      />,
    );

    expect(screen.queryByText(/Win chance:/)).not.toBeInTheDocument();
  });
});
