// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GamesControls } from './GamesControls';
import type { DDStrategy } from '../sim/sim-engine';

/** Default props matching App.tsx's default axes ('knowledge'/'buzzerSpeed'). */
function baseProps(overrides: Partial<React.ComponentProps<typeof GamesControls>> = {}) {
  return {
    position: { x: 0.4, y: 0.5 },
    onPositionChange: vi.fn(),
    xAxis: 'knowledge' as const,
    yAxis: 'buzzerSpeed' as const,
    pinnedValues: {},
    onPinnedChange: vi.fn(),
    includeFJ: true,
    onFJChange: vi.fn(),
    ddStrategy: 'aggressive' as DDStrategy,
    equityActive: false,
    seekDD: false,
    onSeekDDChange: vi.fn(),
    opponentSeekDD: false,
    onOpponentSeekDDChange: vi.fn(),
    ...overrides,
  };
}

describe('GamesControls — DD seeking (TODOS.md P2)', () => {
  it('both seeking checkboxes are unchecked by default', () => {
    render(<GamesControls {...baseProps()} />);
    expect(screen.getByRole('checkbox', { name: 'Seek Daily Doubles' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Opponents seek too' })).not.toBeChecked();
  });

  it('reflects checked state independently for you vs opponents', () => {
    render(<GamesControls {...baseProps({ seekDD: true, opponentSeekDD: false })} />);
    expect(screen.getByRole('checkbox', { name: 'Seek Daily Doubles' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Opponents seek too' })).not.toBeChecked();
  });

  it('calls onSeekDDChange and onOpponentSeekDDChange when toggled', async () => {
    const onSeekDDChange = vi.fn();
    const onOpponentSeekDDChange = vi.fn();
    const user = userEvent.setup();
    render(<GamesControls {...baseProps({ onSeekDDChange, onOpponentSeekDDChange })} />);

    await user.click(screen.getByRole('checkbox', { name: 'Seek Daily Doubles' }));
    expect(onSeekDDChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole('checkbox', { name: 'Opponents seek too' }));
    expect(onOpponentSeekDDChange).toHaveBeenCalledWith(true);
  });
});
