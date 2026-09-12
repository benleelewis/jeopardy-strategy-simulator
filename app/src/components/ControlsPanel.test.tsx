// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlsPanel } from './ControlsPanel';
import type { DDStrategy } from '../sim/sim-engine';

/** Default props matching App.tsx's default axes ('knowledge'/'buzzerSpeed',
 *  P-1 preset B) — pinnedDims for this pair are exactly the two E-7 lock
 *  targets (opponentStrength, ddAggression), which is what these tests
 *  exercise. */
function baseProps(overrides: Partial<React.ComponentProps<typeof ControlsPanel>> = {}) {
  return {
    xAxis: 'knowledge' as const,
    yAxis: 'buzzerSpeed' as const,
    pinnedValues: {},
    onPinnedChange: vi.fn(),
    includeFJ: true,
    onFJChange: vi.fn(),
    theme: 'clean' as const,
    onThemeChange: vi.fn(),
    ddStrategy: 'aggressive' as DDStrategy,
    onDdStrategyChange: vi.fn(),
    equityBuildStatus: 'idle' as const,
    equityBuildProgress: 0,
    onCancelEquityBuild: vi.fn(),
    refinedSpeed: 'normal' as const,
    onRefinedSpeedChange: vi.fn(),
    ...overrides,
  };
}

describe('ControlsPanel — DD Strategy selector (E-7)', () => {
  it('renders a radiogroup with 4 options, ≥44px targets, and the current selection checked', () => {
    render(<ControlsPanel {...baseProps({ ddStrategy: 'aggressive' })} />);
    const group = screen.getByRole('radiogroup', { name: 'DD Strategy' });
    expect(group).toBeInTheDocument();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(screen.getByRole('radio', { name: /Aggressive/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Conservative/ })).toHaveAttribute('aria-checked', 'false');

    for (const r of radios) {
      const minHeight = parseInt((r as HTMLElement).style.minHeight, 10);
      expect(minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('arrow-key navigation moves the selection forward and wraps around', () => {
    const onChange = vi.fn();
    render(<ControlsPanel {...baseProps({ ddStrategy: 'aggressive', onDdStrategyChange: onChange })} />);
    const group = screen.getByRole('radiogroup', { name: 'DD Strategy' });

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('truedd');

    onChange.mockClear();
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('conservative');
  });

  it('shows build progress + a cancel affordance while building, and calls onCancelEquityBuild', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ControlsPanel {...baseProps({
      ddStrategy: 'equity', equityBuildStatus: 'building', equityBuildProgress: 0.6, onCancelEquityBuild: onCancel,
    })} />);

    expect(screen.getByText(/building… ▓▓░ 60%/)).toBeInTheDocument();
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the inline failure status without a toast when the build fails', () => {
    render(<ControlsPanel {...baseProps({ ddStrategy: 'aggressive', equityBuildStatus: 'failed' })} />);
    expect(screen.getByText('Optimal unavailable — using Aggressive')).toBeInTheDocument();
    // No toast/dialog role should exist anywhere in the document.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ControlsPanel — knob pinning while Optimal is active (E-7)', () => {
  it('renders the opponent-strength and DD-aggression sliders genuinely disabled, with a lock glyph', () => {
    render(<ControlsPanel {...baseProps({ ddStrategy: 'equity' })} />);
    const opponentSlider = screen.getByRole('slider', { name: 'Opponent Strength' });
    const ddAggSlider = screen.getByRole('slider', { name: 'DD Aggression' });

    expect(opponentSlider).toBeDisabled();
    expect(opponentSlider).toHaveAttribute('aria-disabled', 'true');
    expect(ddAggSlider).toBeDisabled();
    expect(ddAggSlider).toHaveAttribute('aria-disabled', 'true');

    // aria-disabled, not display:none — the plan's explicit a11y requirement.
    expect(opponentSlider).toBeVisible();
  });

  it('clicking a locked knob reveals the explanation text and an Unlock & rebuild action', async () => {
    const user = userEvent.setup();
    render(<ControlsPanel {...baseProps({ ddStrategy: 'equity' })} />);

    const lockOverlay = screen.getByRole('button', { name: 'Opponent Strength is locked while Optimal is active' });
    await user.click(lockOverlay);

    expect(screen.getByText(/Locked while Optimal is active — changing this rebuilds the strategy table/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock & rebuild' })).toBeInTheDocument();
  });

  it('"Unlock & rebuild" actually re-enables the slider for interaction', async () => {
    const user = userEvent.setup();
    render(<ControlsPanel {...baseProps({ ddStrategy: 'equity' })} />);

    await user.click(screen.getByRole('button', { name: 'Opponent Strength is locked while Optimal is active' }));
    await user.click(screen.getByRole('button', { name: 'Unlock & rebuild' }));

    const opponentSlider = screen.getByRole('slider', { name: 'Opponent Strength' });
    expect(opponentSlider).not.toBeDisabled();
  });

  it('the FJ checkbox is locked while Optimal is active and reveals the same explanation', async () => {
    const user = userEvent.setup();
    render(<ControlsPanel {...baseProps({ ddStrategy: 'equity' })} />);

    const fjCheckbox = screen.getByRole('checkbox', { name: /Include Final Jeopardy/ });
    expect(fjCheckbox).toBeDisabled();

    await user.click(screen.getByText(/Include Final Jeopardy/));
    expect(screen.getByRole('button', { name: 'Unlock & rebuild' })).toBeInTheDocument();
  });

  it('knobs are NOT locked when a non-equity strategy is active', () => {
    render(<ControlsPanel {...baseProps({ ddStrategy: 'aggressive' })} />);
    expect(screen.getByRole('slider', { name: 'Opponent Strength' })).not.toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Include Final Jeopardy/ })).not.toBeDisabled();
  });
});

describe('ControlsPanel — Speed vs Accuracy (P-1C)', () => {
  it('renders three stops with Normal selected by default and the games/cell count shown', () => {
    render(<ControlsPanel {...baseProps({ refinedSpeed: 'normal' })} />);
    const group = screen.getByRole('group', { name: 'Speed vs Accuracy' });
    expect(group).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Normal' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Precise' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('450 games/cell on the refined pass')).toBeInTheDocument();
  });

  it('calls onRefinedSpeedChange with the clicked stop', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlsPanel {...baseProps({ refinedSpeed: 'normal', onRefinedSpeedChange: onChange })} />);

    await user.click(screen.getByRole('button', { name: 'Precise' }));
    expect(onChange).toHaveBeenCalledWith('precise');

    await user.click(screen.getByRole('button', { name: 'Fast' }));
    expect(onChange).toHaveBeenCalledWith('fast');
  });

  it('reflects Fast and Precise selection with the correct games/cell count', () => {
    const { rerender } = render(<ControlsPanel {...baseProps({ refinedSpeed: 'fast' })} />);
    expect(screen.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('150 games/cell on the refined pass')).toBeInTheDocument();

    rerender(<ControlsPanel {...baseProps({ refinedSpeed: 'precise' })} />);
    expect(screen.getByRole('button', { name: 'Precise' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1,200 games/cell on the refined pass')).toBeInTheDocument();
  });
});
