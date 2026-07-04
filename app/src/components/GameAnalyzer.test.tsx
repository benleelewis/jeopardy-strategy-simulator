// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameAnalyzer } from './GameAnalyzer';

async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Show DD & FJ details'));
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
