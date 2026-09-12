// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContributionGraph, type GameData } from './ContributionGraph';

// jsdom has no real canvas 2D context — stub just the methods/properties
// the component calls during its draw effects (P3 ContributionGraph a11y
// task's suggested mock).
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    scale: () => {},
    fillRect: () => {},
    fillText: () => {},
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

// Small fixture: 2 seasons, 4 games total.
const games: GameData[] = [
  { s: 1, d: '2020-01-06', o: [{ n: 'A', k: 0.8, b: 0.6, fj: 1, c: 10000 }, { n: 'B', k: 0.7, b: 0.5, fj: 0, c: 8000 }] },
  { s: 1, d: '2020-01-07', o: [{ n: 'C', k: 0.6, b: 0.4, fj: 1, c: 9000 }, { n: 'D', k: 0.5, b: 0.5, fj: 0, c: 7000 }] },
  { s: 2, d: '2020-09-14', o: [{ n: 'E', k: 0.9, b: 0.7, fj: 1, c: 12000 }, { n: 'F', k: 0.6, b: 0.4, fj: 0, c: 6000 }] },
  { s: 2, d: '2020-09-15', o: [{ n: 'G', k: 0.4, b: 0.3, fj: 1, c: 5000 }, { n: 'H', k: 0.5, b: 0.5, fj: 0, c: 4000 }] },
];

// winRates: [0.8 favored, 0.4 toss-up, 0.2 underdog, 0.6 favored]
// overall = (0.8+0.4+0.2+0.6)/4 = 0.5 -> 50%
const winRates = [0.8, 0.4, 0.2, 0.6];

describe('ContributionGraph — screen-reader alternative (P3)', () => {
  it('sets role="img" and an aria-label with the game count and overall win rate', () => {
    render(<ContributionGraph games={games} winRates={winRates} progress={null} onGameClick={vi.fn()} />);
    const img = screen.getByRole('img');
    const label = img.getAttribute('aria-label') || '';
    expect(label).toContain('4 games');
    expect(label).toContain('50%');
    // favored (>50%): 0.8, 0.6 -> 2; toss-up (30-50%): 0.4 -> 1; underdog (<30%): 0.2 -> 1
    expect(label).toContain('2 favored');
    expect(label).toContain('1 toss-up');
    expect(label).toContain('1 underdog');
  });

  it('says simulating with a percentage while a simulation is in progress', () => {
    render(<ContributionGraph games={games} winRates={null} progress={0.42} onGameClick={vi.fn()} />);
    const img = screen.getByRole('img');
    const label = img.getAttribute('aria-label') || '';
    expect(label.toLowerCase()).toContain('simulating');
    expect(label).toContain('42%');
  });

  it('reports not-yet-simulated when there are no win rates and no progress', () => {
    render(<ContributionGraph games={games} winRates={null} progress={null} onGameClick={vi.fn()} />);
    const img = screen.getByRole('img');
    const label = img.getAttribute('aria-label') || '';
    expect(label).toContain('4 games');
    expect(label.toLowerCase()).toContain('not yet simulated');
  });

  it('updates the aria-label when winRates changes', () => {
    const { rerender } = render(
      <ContributionGraph games={games} winRates={null} progress={null} onGameClick={vi.fn()} />
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Not yet simulated');

    rerender(<ContributionGraph games={games} winRates={winRates} progress={null} onGameClick={vi.fn()} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Overall win rate 50%');
  });

  it('renders an offscreen per-season summary table with one row per season', () => {
    render(<ContributionGraph games={games} winRates={winRates} progress={null} onGameClick={vi.fn()} />);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    // 1 header row + 2 season rows
    expect(rows).toHaveLength(3);

    const season1Row = rows[1];
    expect(within(season1Row).getByText('Season 1')).toBeInTheDocument();
    expect(within(season1Row).getByText('2')).toBeInTheDocument(); // game count
    expect(within(season1Row).getByText('60%')).toBeInTheDocument(); // mean of 0.8, 0.4

    const season2Row = rows[2];
    expect(within(season2Row).getByText('Season 2')).toBeInTheDocument();
    expect(within(season2Row).getByText('2')).toBeInTheDocument();
    expect(within(season2Row).getByText('40%')).toBeInTheDocument(); // mean of 0.2, 0.6
  });
});

describe('ContributionGraph — keyboard season zoom (P3)', () => {
  it('has a visually hidden button per season plus an "All seasons" button', () => {
    render(<ContributionGraph games={games} winRates={winRates} progress={null} onGameClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All seasons' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Season 1 \(2 games\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Season 2 \(2 games\)/ })).toBeInTheDocument();
  });

  it('clicking a season button zooms into that season (shows the visible zoomed header)', async () => {
    const user = userEvent.setup();
    render(<ContributionGraph games={games} winRates={winRates} progress={null} onGameClick={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Season 2 \(2 games\)/ }));
    // The visible "← All Seasons" back button only renders while zoomed —
    // its presence is the signal the click actually zoomed in.
    expect(screen.getByRole('button', { name: '← All Seasons' })).toBeInTheDocument();
  });

  it('clicking "All seasons" zooms back out', async () => {
    const user = userEvent.setup();
    render(<ContributionGraph games={games} winRates={winRates} progress={null} onGameClick={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Season 1 \(2 games\)/ }));
    expect(screen.getByRole('button', { name: '← All Seasons' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All seasons' }));
    expect(screen.queryByRole('button', { name: '← All Seasons' })).not.toBeInTheDocument();
  });
});
