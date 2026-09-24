import { describe, it, expect } from 'vitest';
import { opponentCaption } from './dimensions';

// Explorer's StatsPanel Win Rate caption — see YourNumber vs. StatsPanel
// win-rate discrepancy fix: both numbers are legitimate, they're just
// measured against different opponents, and the caption exists to say so
// in plain words.
describe('opponentCaption', () => {
  it('names Average at the 0.0 anchor', () => {
    expect(opponentCaption('knowledge', 'buzzerSpeed', 0.0)).toBe('vs. two Average opponents');
  });

  it('names Champion at the 0.5 anchor', () => {
    expect(opponentCaption('knowledge', 'buzzerSpeed', 0.5)).toBe('vs. two Champion opponents');
  });

  it('names Grand Champion at the 1.0 anchor', () => {
    expect(opponentCaption('knowledge', 'buzzerSpeed', 1.0)).toBe('vs. two Grand Champion opponents');
  });

  it('snaps to the nearest anchor within tolerance (~0.05)', () => {
    expect(opponentCaption('knowledge', 'buzzerSpeed', 0.03)).toBe('vs. two Average opponents');
    expect(opponentCaption('knowledge', 'buzzerSpeed', 0.47)).toBe('vs. two Champion opponents');
    expect(opponentCaption('knowledge', 'buzzerSpeed', 0.96)).toBe('vs. two Grand Champion opponents');
  });

  it('describes a value between Average and Champion', () => {
    expect(opponentCaption('knowledge', 'buzzerSpeed', 0.25)).toBe('vs. two opponents between Average and Champion');
  });

  it('describes a value between Champion and Grand Champion', () => {
    expect(opponentCaption('knowledge', 'buzzerSpeed', 0.75)).toBe('vs. two opponents between Champion and Grand Champion');
  });

  it('points at the axis when opponentStrength is the x-axis', () => {
    expect(opponentCaption('opponentStrength', 'buzzerSpeed', 0.5)).toBe('vs. opponents set by the Opponent Strength axis');
  });

  it('points at the axis when opponentStrength is the y-axis', () => {
    expect(opponentCaption('knowledge', 'opponentStrength', 0.5)).toBe('vs. opponents set by the Opponent Strength axis');
  });

  it('clamps out-of-range values before naming an anchor', () => {
    expect(opponentCaption('knowledge', 'buzzerSpeed', -0.2)).toBe('vs. two Average opponents');
    expect(opponentCaption('knowledge', 'buzzerSpeed', 1.2)).toBe('vs. two Grand Champion opponents');
  });
});
