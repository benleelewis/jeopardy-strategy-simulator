/**
 * Pure helpers for the Explorer heat map's famous-player labels (see
 * HeatMap.tsx's "Famous player markers" block). Split into a plain module
 * (no D3/DOM) so the label text and greedy collision-avoiding placement can
 * be unit-tested directly, without a browser or jsdom's unimplemented SVG
 * text-measurement APIs.
 */

/** A label's candidate content before placement: the dot it's attached to,
 *  in the same plot-local (post-scale) coordinate space as everything else
 *  `HeatMap.tsx`'s render effect draws into the `.main-group` — origin at
 *  the plot's top-left, NOT the SVG's. */
export interface LabelPoint {
  /** Stable identity (e.g. the player's full name) — used only to tag the
   *  matching PlacedLabel; placement itself never keys off it. */
  id: string;
  x: number;
  y: number;
  text: string;
}

/** Axis-aligned bounding box, plot-local coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a placed label ended up: the `<text>` element's own x/y/anchor
 *  attributes, plus the box that was actually checked for overlap (so
 *  callers/tests can reason about what was avoided). */
export interface PlacedLabel {
  id: string;
  x: number;
  y: number;
  anchor: 'start' | 'end';
  box: Box;
}

/** Measures a string's rendered width at a given font size. HeatMap.tsx
 *  passes one backed by SVGTextContentElement.getComputedTextLength() when
 *  the runtime supports it; tests (and jsdom, which doesn't implement SVG
 *  text layout) fall back to `estimateTextWidth` below. */
export type TextMeasurer = (text: string, fontSize: number) => number;

/** Average glyph width for the label font (10px system sans, weight 500)
 *  as a fraction of font size — close enough for collision avoidance,
 *  which only needs "roughly how wide," not typographic precision. */
const AVG_CHAR_WIDTH_RATIO = 0.6;

/** Character-count × font-size fallback measurer — the "else" branch the
 *  task calls for, and the only one available where no SVG DOM exists. */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * AVG_CHAR_WIDTH_RATIO;
}

/** Famous-player marker label text: the surname, with any trailing
 *  parenthetical stripped first. A bare `name.split(' ').pop()` turned
 *  "Watson (IBM)" into the label "(IBM)" — strip `(...)` off the end
 *  before taking the last word so every current/future FAMOUS_PLAYERS
 *  entry (see opponent-models.ts) produces a sensible surname label. */
export function playerLabelText(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  return words.length > 0 ? words[words.length - 1] : stripped;
}

/** Standard axis-aligned bounding box overlap test (open intervals — boxes
 *  that merely touch at an edge don't count as overlapping). */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Small breathing-room margin baked into each label's collision box, so
 *  "doesn't overlap" also means "isn't touching" — two adjacent labels
 *  would otherwise read as one run-on word. */
const LABEL_PADDING = 2;

/** Vertical extent of a line of text around its baseline: ascent above,
 *  descent below, expressed as a fraction of font size (standard-ish for
 *  a system sans at these small sizes). Used to build a label's box from
 *  just its `<text>` x/y/font-size, same as the DOM would report via
 *  getBBox(). */
const ASCENT_RATIO = 0.8;
const DESCENT_RATIO = 0.25;

/** Candidate offsets from the dot center, tried in this order: right of
 *  the dot (today's default), left of the dot (text-anchor end, so the
 *  label still reads away from the dot), above-right, below-right. Offsets
 *  match the existing right-of-dot placement (+8, +4) so the common case
 *  (no collision) renders pixel-identical to before this change. */
const CANDIDATE_OFFSETS: Array<{ dx: number; dy: number; anchor: 'start' | 'end' }> = [
  { dx: 8, dy: 4, anchor: 'start' },   // right of dot
  { dx: -8, dy: 4, anchor: 'end' },    // left of dot
  { dx: 8, dy: -8, anchor: 'start' },  // above-right
  { dx: 8, dy: 16, anchor: 'start' },  // below-right
];

/** Builds the bounding box a `<text x y text-anchor font-size>` element
 *  would occupy, padded by LABEL_PADDING on all sides. Exported (beyond
 *  `placeLabels`' own start/end candidates) so callers can build obstacle
 *  boxes for fixed, non-candidate text — e.g. HeatMap.tsx's "YOU" marker
 *  label, which is centered (`text-anchor: middle`) and never itself a
 *  placement candidate. */
export function textBoundingBox(
  x: number,
  y: number,
  anchor: 'start' | 'end' | 'middle',
  width: number,
  fontSize: number,
): Box {
  const left = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
  return {
    x: left - LABEL_PADDING,
    y: y - fontSize * ASCENT_RATIO - LABEL_PADDING,
    width: width + LABEL_PADDING * 2,
    height: fontSize * (ASCENT_RATIO + DESCENT_RATIO) + LABEL_PADDING * 2,
  };
}

function withinBounds(box: Box, bounds: { width: number; height: number }): boolean {
  return box.x >= 0 && box.y >= 0
    && box.x + box.width <= bounds.width
    && box.y + box.height <= bounds.height;
}

/**
 * Greedy collision-avoiding label placement. For each point (in the given,
 * stable order — order determines who "wins" a contested spot, so callers
 * should pass a deterministic order such as FAMOUS_PLAYERS' own), tries
 * each candidate offset in turn and takes the first whose box stays inside
 * `bounds` and doesn't overlap any `obstacles` box or any box already
 * placed for an earlier point in this same call. If no candidate clears
 * both checks, falls back to the first candidate (right-of-dot) regardless
 * of overlap — a readable-but-imperfect label beats a hidden one.
 *
 * Every placed box (including fallback placements) is added to the
 * in-progress obstacle set, so later points still route around it.
 */
export function placeLabels(
  points: LabelPoint[],
  bounds: { width: number; height: number },
  obstacles: Box[] = [],
  fontSize = 10,
  measure: TextMeasurer = estimateTextWidth,
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const placedBoxes: Box[] = [...obstacles];

  for (const point of points) {
    const width = measure(point.text, fontSize);
    let chosen: { x: number; y: number; anchor: 'start' | 'end'; box: Box } | null = null;

    for (const { dx, dy, anchor } of CANDIDATE_OFFSETS) {
      const x = point.x + dx;
      const y = point.y + dy;
      const box = textBoundingBox(x, y, anchor, width, fontSize);
      if (!withinBounds(box, bounds)) continue;
      if (placedBoxes.some(other => boxesOverlap(box, other))) continue;
      chosen = { x, y, anchor, box };
      break;
    }

    if (!chosen) {
      // Nothing cleared both checks — fall back to right-of-dot as-is.
      const fallback = CANDIDATE_OFFSETS[0];
      const x = point.x + fallback.dx;
      const y = point.y + fallback.dy;
      chosen = { x, y, anchor: fallback.anchor, box: textBoundingBox(x, y, fallback.anchor, width, fontSize) };
    }

    placedBoxes.push(chosen.box);
    placed.push({ id: point.id, x: chosen.x, y: chosen.y, anchor: chosen.anchor, box: chosen.box });
  }

  return placed;
}
