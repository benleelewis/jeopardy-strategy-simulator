// Regression: ISSUE-004 — pre-2001 games failed to load (422) because every
// clue was scored at modern values, doubling each replayed score.
// Found by /qa on 2026-09-23
// Report: .gstack/qa-reports/qa-report-jeopardy-strategy-simulator-vercel-app-2026-09-23.md
import { describe, it, expect } from 'vitest';
import { parseGame, replay } from './jarchive';
import fixtureHtml from './__fixtures__/game-8276.html?raw';

describe('parseGame on a pre-2001 board (game 8276, aired 1986-01-21)', () => {
  const game = parseGame(fixtureHtml);

  it('scores Jeopardy squares at $100–$500 and Double Jeopardy at $200–$1,000', () => {
    const face = (round: 'J' | 'DJ') => [...new Set(
      game.clues.filter(c => c.round === round).map(c => c.boundValue),
    )].sort((a, b) => a - b);
    expect(face('J')).toEqual([100, 200, 300, 400, 500]);
    expect(face('DJ')).toEqual([200, 400, 600, 800, 1000]);
  });

  it('halves Daily Double squares too, though they print only the wager', () => {
    const dds = game.clues.filter(c => c.isDD);
    expect(dds.length).toBe(3);
    for (const dd of dds) expect(dd.boundValue).toBe((dd.round === 'J' ? 100 : 200) * dd.row);
  });

  it('replays Erik and Daniel exactly at every published checkpoint', () => {
    // Ann's J-Archive totals run $200 above her recorded clues (a scoring
    // correction the clue grid doesn't carry), so the check stays on the
    // other two podiums.
    const { validation } = replay(game);
    expect(validation.checked).toBe(3);
    for (const m of validation.mismatches) {
      expect(m.actual.slice(0, 2)).toEqual(m.expected.slice(0, 2));
    }
  });
});
