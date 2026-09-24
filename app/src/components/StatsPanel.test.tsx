// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatsPanel } from './StatsPanel';

function baseProps(overrides: Partial<React.ComponentProps<typeof StatsPanel>> = {}) {
  return {
    position: { x: 0.5, y: 0.5 },
    winRate: 0.42,
    xAxis: 'knowledge' as const,
    yAxis: 'buzzerSpeed' as const,
    ...overrides,
  };
}

describe('StatsPanel — Win Rate opponent caption', () => {
  it('names the Average anchor at the default opponentStrength (0.0)', () => {
    render(<StatsPanel {...baseProps()} />);
    expect(screen.getByText('vs. two Average opponents')).toBeInTheDocument();
  });

  it('names the Champion anchor when opponentStrength is pinned to 0.5', () => {
    render(<StatsPanel {...baseProps({ pinnedValues: { opponentStrength: 0.5 } })} />);
    expect(screen.getByText('vs. two Champion opponents')).toBeInTheDocument();
  });

  it('describes a between-anchor pinned value in plain words', () => {
    render(<StatsPanel {...baseProps({ pinnedValues: { opponentStrength: 0.25 } })} />);
    expect(screen.getByText('vs. two opponents between Average and Champion')).toBeInTheDocument();
  });

  it('points at the axis when opponentStrength is the y-axis instead of pinned', () => {
    render(<StatsPanel {...baseProps({ yAxis: 'opponentStrength' })} />);
    expect(screen.getByText('vs. opponents set by the Opponent Strength axis')).toBeInTheDocument();
  });
});
