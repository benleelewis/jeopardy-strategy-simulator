// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GainHeader } from './GainHeader';
import { GAIN_LEGEND, formatGain, gainMeans, type GainData } from './gain';

// Fixture: 4 games. actual mean = 0.32, optimal mean = 0.41.
const gain: GainData = {
  actual: [0.30, 0.30, 0.40, 0.28],
  optimal: [0.40, 0.50, 0.40, 0.34],
};

describe('GainHeader — "Gain from optimal play" headline + legend (P2 optimal-vs-actual)', () => {
  it('states the lift from the actual mean to the optimal mean across all games', () => {
    render(<GainHeader gain={gain} progress={null} tableStatus="ready" tableProgress={1} />);
    const headline = screen.getByRole('status');
    expect(headline.textContent).toBe(
      'Optimal wagering and DD seeking would lift you from 32% to 41% across 4 games.',
    );
  });

  it('appends a refining status while the refined delta pass is running', () => {
    render(<GainHeader gain={gain} progress={0.5} tableStatus="ready" tableProgress={1} />);
    expect(screen.getByRole('status').textContent).toContain('Refining… 50%');
  });

  it('renders the diverging legend: two blues, a neutral, two golds', () => {
    render(<GainHeader gain={gain} progress={null} tableStatus="ready" tableProgress={1} />);
    expect(screen.getByText('Gain from optimal play:')).toBeInTheDocument();
    expect(GAIN_LEGEND).toHaveLength(5);
    for (const { label } of GAIN_LEGEND) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(GAIN_LEGEND[0].cssVar).toBe('--cg-2');
    expect(GAIN_LEGEND[2].cssVar).toBe('--cg-neutral');
    expect(GAIN_LEGEND[4].cssVar).toBe('--cg-5');
  });

  it('shows the V-table build status before the table exists', () => {
    render(<GainHeader gain={null} progress={null} tableStatus="building" tableProgress={0.4} />);
    expect(screen.getByRole('status').textContent).toBe('Building the optimal-wagering table… 40%');
  });

  it('shows the computing status once the table exists but the sweep has not landed', () => {
    render(<GainHeader gain={null} progress={0.25} tableStatus="ready" tableProgress={1} />);
    expect(screen.getByRole('status').textContent).toBe('Computing gain from optimal play… 25%');
  });

  it('says so when the table build failed', () => {
    render(<GainHeader gain={null} progress={null} tableStatus="failed" tableProgress={0} />);
    expect(screen.getByRole('status').textContent).toContain('unavailable');
  });
});

describe('gain helpers', () => {
  it('gainMeans averages both arms', () => {
    const m = gainMeans(gain)!;
    expect(m.total).toBe(4);
    expect(m.from).toBeCloseTo(0.32, 10);
    expect(m.to).toBeCloseTo(0.41, 10);
    expect(gainMeans(null)).toBeNull();
    expect(gainMeans({ actual: [], optimal: [] })).toBeNull();
  });

  it('formatGain renders signed points', () => {
    expect(formatGain(0.09)).toBe('+9pp');
    expect(formatGain(-0.03)).toBe('−3pp');
    expect(formatGain(0)).toBe('0pp');
    expect(formatGain(0.004)).toBe('0pp');
  });
});
