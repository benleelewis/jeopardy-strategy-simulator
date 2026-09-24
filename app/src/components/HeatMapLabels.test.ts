import { describe, it, expect } from 'vitest';
import {
  playerLabelText,
  placeLabels,
  boxesOverlap,
  estimateTextWidth,
  type LabelPoint,
  type Box,
} from './HeatMapLabels';

describe('playerLabelText — famous-player marker label text', () => {
  it('strips a trailing parenthetical before taking the surname ("Watson (IBM)" bug)', () => {
    expect(playerLabelText('Watson (IBM)')).toBe('Watson');
  });

  it('takes the last word of an ordinary "First Last" name', () => {
    expect(playerLabelText('Ken Jennings')).toBe('Jennings');
    expect(playerLabelText('James Holzhauer')).toBe('Holzhauer');
    expect(playerLabelText('Brad Rutter')).toBe('Rutter');
    expect(playerLabelText('Amy Schneider')).toBe('Schneider');
  });

  it('returns a single-word name unchanged', () => {
    expect(playerLabelText('Average')).toBe('Average');
  });
});

describe('placeLabels — greedy collision-avoiding label placement', () => {
  const BOUNDS = { width: 500, height: 500 };

  it('places a single, unobstructed label at the default right-of-dot offset', () => {
    const points: LabelPoint[] = [{ id: 'a', x: 100, y: 100, text: 'Jennings' }];
    const [placed] = placeLabels(points, BOUNDS, [], 10, estimateTextWidth);
    expect(placed.anchor).toBe('start');
    expect(placed.x).toBe(108); // +8 right-of-dot offset
    expect(placed.y).toBe(104); // +4 right-of-dot offset
  });

  it('gives two overlapping points (dots close together) non-overlapping label boxes', () => {
    // Mirrors the reported Schneider/Rutter and Holzhauer/Watson collisions:
    // two dots close enough that the naive right-of-dot labels would overlap.
    const points: LabelPoint[] = [
      { id: 'rutter', x: 190, y: 215, text: 'Rutter' },
      { id: 'schneider', x: 192, y: 218, text: 'Schneider' },
    ];
    const placed = placeLabels(points, BOUNDS, [], 10, estimateTextWidth);
    expect(placed).toHaveLength(2);
    expect(boxesOverlap(placed[0].box, placed[1].box)).toBe(false);
  });

  it('avoids a fixed obstacle box (e.g. the YOU marker) as well as other labels', () => {
    const points: LabelPoint[] = [{ id: 'a', x: 100, y: 100, text: 'Holzhauer' }];
    // An obstacle covering only the right-of-dot candidate region, so
    // placeLabels must fall through to left-of-dot instead.
    const obstacle: Box = { x: 100, y: 90, width: 70, height: 25 };
    const [placed] = placeLabels(points, BOUNDS, [obstacle], 10, estimateTextWidth);
    expect(placed.anchor).toBe('end');
    expect(boxesOverlap(placed.box, obstacle)).toBe(false);
  });

  it('flips a label near the right plot edge to the left (text-anchor end)', () => {
    // Dot sits close enough to the right edge that right-of-dot text would
    // run past `bounds.width`, so placeLabels should fall through to the
    // left-of-dot candidate instead.
    const points: LabelPoint[] = [{ id: 'edge', x: 495, y: 100, text: 'Schneider' }];
    const [placed] = placeLabels(points, BOUNDS, [], 10, estimateTextWidth);
    expect(placed.anchor).toBe('end');
    expect(placed.x).toBe(495 - 8); // left-of-dot offset
    expect(placed.box.x + placed.box.width).toBeLessThanOrEqual(BOUNDS.width);
  });

  it('falls back to right-of-dot when no candidate clears both bounds and overlap checks', () => {
    // Surround the dot on every side it could try (left/above/below) with
    // obstacles, and push it to the right plot edge so even right-of-dot
    // would normally be rejected for going out of bounds — placeLabels
    // still must return a placement (the documented fallback), not throw
    // or drop the label.
    const points: LabelPoint[] = [{ id: 'boxed-in', x: 498, y: 250, text: 'Watson' }];
    const obstacles: Box[] = [
      { x: 400, y: 240, width: 90, height: 30 },  // left-of-dot region
      { x: 490, y: 200, width: 60, height: 40 },  // above-right region
      { x: 490, y: 260, width: 60, height: 40 },  // below-right region
    ];
    const placed = placeLabels(points, BOUNDS, obstacles, 10, estimateTextWidth);
    expect(placed).toHaveLength(1);
    expect(placed[0].anchor).toBe('start');
    expect(placed[0].x).toBe(498 + 8);
  });

  it('is order-stable: later points route around earlier ones, not vice versa', () => {
    const points: LabelPoint[] = [
      { id: 'first', x: 200, y: 200, text: 'Rutter' },
      { id: 'second', x: 201, y: 201, text: 'Schneider' },
    ];
    const placed = placeLabels(points, BOUNDS, [], 10, estimateTextWidth);
    const first = placed.find(p => p.id === 'first')!;
    // The first point always wins the default right-of-dot slot.
    expect(first.anchor).toBe('start');
    expect(first.x).toBe(200 + 8);
  });
});

describe('estimateTextWidth — character-count fallback measurer', () => {
  it('scales with both text length and font size', () => {
    expect(estimateTextWidth('Jennings', 10)).toBeCloseTo(8 * 10 * 0.6, 5);
    expect(estimateTextWidth('', 10)).toBe(0);
    expect(estimateTextWidth('Jennings', 20)).toBeGreaterThan(estimateTextWidth('Jennings', 10));
  });
});
