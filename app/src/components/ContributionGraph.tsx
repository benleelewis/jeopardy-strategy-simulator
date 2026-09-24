import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from 'react';
import { GAIN_NEUTRAL, GAIN_STRONG, formatGain, type ColorMode, type GainData } from './gain';

export interface GameData {
  s: number;       // season
  d: string;       // airDate
  o: [{ n: string; k: number; b: number; fj: number; c: number },
      { n: string; k: number; b: number; fj: number; c: number }];
}

export type { ColorMode, GainData } from './gain';

interface Props {
  games: GameData[];
  winRates: number[] | null;  // parallel array, one per game
  progress: number | null;    // 0-1 during simulation, null when idle
  onGameClick: (index: number) => void;
  /** Default 'winRate' — the graph as it is today. */
  colorMode?: ColorMode;
  /** Gain mode only: per-game paired arms. null until the delta sweep lands. */
  gain?: GainData | null;
  /** Gain mode only: 0-1 during the delta sweep, null when idle. */
  gainProgress?: number | null;
}

const CELL_SIZE = 6;
const CELL_GAP = 1;
const CELL_STEP = CELL_SIZE + CELL_GAP; // also the max column pitch — see gridPitch()
// Smallest a column can shrink to before squares stop being clickable/visible.
// Below this the grid keeps horizontal scroll instead of squeezing further.
const MIN_PITCH = 4;
const ROW_GAP = 6; // extra vertical gap between season rows for click targets
const ROW_STEP = CELL_SIZE + ROW_GAP;
const LABEL_WIDTH = 40;
const TOP_PAD = 4;

// Zoomed view uses larger cells
const ZOOM_CELL_SIZE = 10;
const ZOOM_CELL_GAP = 2;
const ZOOM_CELL_STEP = ZOOM_CELL_SIZE + ZOOM_CELL_GAP;
const ZOOM_LABEL_WIDTH = 36;
const ZOOM_TOP_PAD = 20; // room for week/month headers

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** Organize games into season rows */
function groupBySeason(games: GameData[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (let i = 0; i < games.length; i++) {
    const s = games[i].s;
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(i);
  }
  return map;
}

/** Build a 5-row (M-F) × N-week calendar grid for a season */
function buildCalendarGrid(games: GameData[], indices: number[]): { grid: Map<string, number>; maxWeek: number } {
  const sorted = [...indices].sort((a, b) => games[a].d.localeCompare(games[b].d));
  if (sorted.length === 0) return { grid: new Map(), maxWeek: 0 };

  const firstDate = new Date(games[sorted[0]].d + 'T00:00:00Z');
  const grid = new Map<string, number>();
  let maxWeek = 0;

  for (const gi of sorted) {
    const date = new Date(games[gi].d + 'T00:00:00Z');
    const dayOfWeek = date.getUTCDay(); // 0=Sun
    if (dayOfWeek === 0 || dayOfWeek === 6) continue; // skip weekends
    const row = dayOfWeek - 1; // Mon=0, Tue=1, ... Fri=4
    const daysSinceStart = Math.floor((date.getTime() - firstDate.getTime()) / 86400000);
    const week = Math.floor(daysSinceStart / 7);
    grid.set(`${week}-${row}`, gi);
    maxWeek = Math.max(maxWeek, week);
  }

  return { grid, maxWeek };
}

/**
 * Column pitch (square + gap, px) for the all-seasons grid, chosen so every
 * column plus the season-label gutter fits inside the container's available
 * width. Never exceeds CELL_STEP (today's fixed pitch, the ceiling) and
 * never drops below MIN_PITCH (the floor, past which cells stop being
 * clickable/visible) — below the floor the grid keeps horizontal scroll
 * instead of squeezing further.
 */
export function gridPitch(availableWidth: number, maxColumns: number): number {
  if (maxColumns <= 0) return CELL_STEP;
  const ideal = Math.floor(availableWidth / maxColumns);
  return Math.max(MIN_PITCH, Math.min(CELL_STEP, ideal));
}

/** Fisher-Yates shuffle for reveal order */
function shuffleIndices(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function ContributionGraph({
  games, winRates, progress, onGameClick,
  colorMode = 'winRate', gain = null, gainProgress = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isGain = colorMode === 'gain';

  // Gain mode: per-game optimal - actual. null until the sweep lands.
  const gains = useMemo(() => {
    if (!isGain || !gain) return null;
    return gain.optimal.map((o, i) => o - gain.actual[i]);
  }, [isGain, gain]);

  // The array the cells are coloured by and the progress that drives the
  // reveal animation. In the default mode these ARE `winRates`/`progress`
  // (same references), so every memo/effect below behaves exactly as before.
  const values = isGain ? gains : winRates;
  const activeProgress = isGain ? gainProgress : progress;
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredGame, setHoveredGame] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [zoomedSeason, setZoomedSeason] = useState<number | null>(null);
  // 0 until the container is measured (jsdom's clientWidth is always 0, so
  // tests fall back to the max pitch below — same output as before this change).
  const [containerWidth, setContainerWidth] = useState(0);
  // True when the grid is wider than the container and not scrolled to the end.
  const [scrollHint, setScrollHint] = useState(false);

  // Derived from `games`. useMemo rather than refs written in an effect, so the
  // first paint sees real values instead of the empty initial ref.
  const seasonMap = useMemo(() => groupBySeason(games), [games]);
  const seasonOrder = useMemo(
    () => [...seasonMap.keys()].sort((a, b) => a - b),
    [seasonMap]
  );

  // Pre-computed reveal order for the fill-in animation
  const revealOrder = useMemo(() => shuffleIndices(games.length), [games]);

  // Build revealed set from progress
  const revealedSet = useMemo(() => {
    if (activeProgress === null || !values) return null; // show all when done
    const count = Math.floor(activeProgress * games.length);
    return new Set(revealOrder.slice(0, count));
  }, [activeProgress, games.length, values, revealOrder]);

  // Widest season, in games — sets the canvas column count
  const maxCols = useMemo(() => {
    let m = 0;
    for (const indices of seasonMap.values()) {
      m = Math.max(m, indices.length);
    }
    return m;
  }, [seasonMap]);

  // All-seasons column pitch, shrunk (down to MIN_PITCH) so the widest season
  // plus the label gutter fits the container without horizontal scroll —
  // falls back to the max (current, unshrunk) pitch until measured.
  const pitch = useMemo(
    () => (containerWidth > 0 ? gridPitch(containerWidth - LABEL_WIDTH, maxCols) : CELL_STEP),
    [containerWidth, maxCols]
  );
  const cellSize = pitch - CELL_GAP;

  // Recompute scroll-hint visibility: shown only while the grid overflows
  // the container and there's still unscrolled content to the right.
  const updateScrollHint = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    setScrollHint(overflow > 1 && el.scrollLeft < overflow - 1);
  }, []);

  // Measure the container on mount and whenever it resizes (e.g. sidebar
  // toggle, window resize, orientation change). useLayoutEffect so the first
  // paint already uses the real width instead of flashing full-size squares.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    updateScrollHint();
    // jsdom (tests) has no ResizeObserver — skip live tracking there.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
      updateScrollHint();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollHint]);

  // --- Accessibility: text alternatives for the canvas (additive, no draw changes) ---

  // Headline stats over the full winRates array: favored/toss-up/underdog
  // buckets match the thresholds used in YourNumber.tsx (>50% / 30-50% / <30%).
  const winRateSummary = useMemo(() => {
    if (!winRates || winRates.length === 0) return null;
    let sum = 0;
    let favored = 0;
    let underdog = 0;
    for (const wr of winRates) {
      sum += wr;
      if (wr > 0.5) favored++;
      else if (wr < 0.3) underdog++;
    }
    const total = winRates.length;
    return { total, overall: sum / total, favored, underdog, tossUp: total - favored - underdog };
  }, [winRates]);

  // Gain-mode headline stats: the two arm means and better/same/worse counts.
  const gainSummary = useMemo(() => {
    if (!isGain || !gain || !gains || gains.length === 0) return null;
    let sumActual = 0;
    let sumOptimal = 0;
    let better = 0;
    let worse = 0;
    for (let i = 0; i < gains.length; i++) {
      sumActual += gain.actual[i];
      sumOptimal += gain.optimal[i];
      if (gains[i] > GAIN_NEUTRAL) better++;
      else if (gains[i] < -GAIN_NEUTRAL) worse++;
    }
    const total = gains.length;
    return {
      total,
      meanActual: sumActual / total,
      meanOptimal: sumOptimal / total,
      better,
      worse,
      same: total - better - worse,
    };
  }, [isGain, gain, gains]);

  const ariaLabel = useMemo(() => {
    if (isGain) {
      if (gainProgress !== null) {
        return `Computing gain from optimal play for ${games.length} games… ${Math.round(gainProgress * 100)}% complete.`;
      }
      if (!gainSummary) {
        return `Contribution graph of ${games.length} games. Gain from optimal play not yet computed.`;
      }
      const { total, meanActual, meanOptimal, better, same, worse } = gainSummary;
      return `Contribution graph of ${total} games, colored by gain from optimal play. `
        + `Optimal wagering and DD seeking would ${meanOptimal >= meanActual ? 'lift' : 'move'} `
        + `your win rate from ${Math.round(meanActual * 100)}% `
        + `to ${Math.round(meanOptimal * 100)}%. `
        + `${better} games better (gain over ${Math.round(GAIN_NEUTRAL * 100)} points), `
        + `${same} about the same, ${worse} games worse.`;
    }
    if (progress !== null) {
      return `Simulating win rates for ${games.length} games… ${Math.round(progress * 100)}% complete.`;
    }
    if (!winRateSummary) {
      return `Contribution graph of ${games.length} games. Not yet simulated.`;
    }
    const { total, overall, favored, tossUp, underdog } = winRateSummary;
    return `Contribution graph of ${total} games. Overall win rate ${Math.round(overall * 100)}%. `
      + `${favored} favored games (win rate over 50%), ${tossUp} toss-up games (30% to 50%), `
      + `${underdog} underdog games (win rate under 30%).`;
  }, [isGain, gainProgress, gainSummary, progress, games.length, winRateSummary]);

  // Per-season summary: mean win rate + game count, for the offscreen table.
  // In gain mode `values` is the per-game gain, so this is the mean gain.
  const seasonSummaries = useMemo(() => {
    return seasonOrder.map(season => {
      const indices = seasonMap.get(season) || [];
      let meanWinRate: number | null = null;
      if (values) {
        let sum = 0;
        let n = 0;
        for (const gi of indices) {
          const wr = values[gi];
          if (wr !== undefined) {
            sum += wr;
            n++;
          }
        }
        if (n > 0) meanWinRate = sum / n;
      }
      return { season, count: indices.length, meanWinRate };
    });
  }, [seasonOrder, seasonMap, values]);

  // Zoomed calendar grid
  const zoomGrid = useMemo(() => {
    if (zoomedSeason === null) return null;
    const indices = seasonMap.get(zoomedSeason);
    if (!indices) return null;
    return buildCalendarGrid(games, indices);
  }, [zoomedSeason, games, seasonMap]);

  // Read CSS color variables
  const getColors = useCallback((canvas: HTMLCanvasElement) => {
    const computed = getComputedStyle(canvas);
    const get = (name: string, fallback: string) => computed.getPropertyValue(name).trim() || fallback;
    return {
      bg: get('--bg', '#0d1117'),
      label: get('--text-muted', '#8b949e'),
      cg1: get('--cg-1', '#060a30'),
      cg2: get('--cg-2', '#0a1566'),
      cg3: get('--cg-3', '#1a3ba8'),
      cg4: get('--cg-4', '#c5a028'),
      cg5: get('--cg-5', '#f5d442'),
      cgEmpty: get('--cg-empty', '#d4d7dd'),
      cgNeutral: get('--cg-neutral', '#9aa0ad'),
    };
  }, []);

  // Win rate → color using theme CSS variables
  const winRateColorFn = useCallback((rate: number, colors: ReturnType<typeof getColors>) => {
    if (rate < 0.15) return colors.cg1;
    if (rate < 0.25) return colors.cg2;
    if (rate < 0.40) return colors.cg3;
    if (rate < 0.55) return colors.cg4;
    return colors.cg5;
  }, []);

  // Gain → diverging colour: blue = worse, neutral grey = about the same,
  // gold = better. Reuses the win-rate ramp's ends so both modes share a theme.
  const gainColorFn = useCallback((g: number, colors: ReturnType<typeof getColors>) => {
    if (g <= -GAIN_STRONG) return colors.cg2;
    if (g < -GAIN_NEUTRAL) return colors.cg3;
    if (g <= GAIN_NEUTRAL) return colors.cgNeutral;
    if (g < GAIN_STRONG) return colors.cg4;
    return colors.cg5;
  }, []);

  const valueColorFn = isGain ? gainColorFn : winRateColorFn;

  // Get cell color considering reveal animation
  const getCellColor = useCallback((gi: number, colors: ReturnType<typeof getColors>) => {
    if (hoveredGame === gi) return '#ffffff';
    if (!values || values[gi] === undefined) return colors.cgEmpty;
    // During simulation, only show revealed cells
    if (revealedSet && !revealedSet.has(gi)) return colors.cgEmpty;
    return valueColorFn(values[gi], colors);
  }, [values, hoveredGame, revealedSet, valueColorFn]);

  // Draw canvas — all-seasons view
  useEffect(() => {
    if (zoomedSeason !== null) return; // zoomed view draws separately
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rows = seasonOrder.length;
    const cols = maxCols;
    const width = LABEL_WIDTH + cols * pitch;
    const height = TOP_PAD + rows * ROW_STEP;

    canvas.width = width * (window.devicePixelRatio || 1);
    canvas.height = height * (window.devicePixelRatio || 1);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    const colors = getColors(canvas);

    // Clear
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);

    // Draw season labels + cells
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let r = 0; r < rows; r++) {
      const season = seasonOrder[r];
      const indices = seasonMap.get(season) || [];
      const y = TOP_PAD + r * ROW_STEP;

      // Season label (clickable area)
      ctx.fillStyle = colors.label;
      ctx.fillText(`S${season}`, LABEL_WIDTH - 4, y + cellSize / 2);

      // Cells
      for (let c = 0; c < indices.length; c++) {
        const gi = indices[c];
        const x = LABEL_WIDTH + c * pitch;
        ctx.fillStyle = getCellColor(gi, colors);
        ctx.fillRect(x, y, cellSize, cellSize);
      }
    }

    updateScrollHint(); // canvas just resized — the container's overflow may have changed
  }, [games, values, hoveredGame, zoomedSeason, getColors, getCellColor, seasonOrder, seasonMap, maxCols, pitch, cellSize, updateScrollHint]);

  // Draw canvas — zoomed season view
  useEffect(() => {
    if (zoomedSeason === null || !zoomGrid) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { grid, maxWeek } = zoomGrid;
    const numWeeks = maxWeek + 1;
    const width = ZOOM_LABEL_WIDTH + numWeeks * ZOOM_CELL_STEP + 8;
    const height = ZOOM_TOP_PAD + 5 * ZOOM_CELL_STEP + 8;

    canvas.width = width * (window.devicePixelRatio || 1);
    canvas.height = height * (window.devicePixelRatio || 1);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    const colors = getColors(canvas);

    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);

    // Day labels (M-F)
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.label;
    for (let d = 0; d < 5; d++) {
      const y = ZOOM_TOP_PAD + d * ZOOM_CELL_STEP;
      ctx.fillText(DAY_LABELS[d], ZOOM_LABEL_WIDTH - 4, y + ZOOM_CELL_SIZE / 2);
    }

    // Week number headers (every 4 weeks)
    ctx.textAlign = 'center';
    ctx.font = '9px monospace';
    for (let w = 0; w < numWeeks; w += 4) {
      const x = ZOOM_LABEL_WIDTH + w * ZOOM_CELL_STEP + ZOOM_CELL_SIZE / 2;
      ctx.fillStyle = colors.label;
      ctx.fillText(`${w + 1}`, x, ZOOM_TOP_PAD - 6);
    }

    // Cells
    for (let w = 0; w <= maxWeek; w++) {
      for (let d = 0; d < 5; d++) {
        const gi = grid.get(`${w}-${d}`);
        const x = ZOOM_LABEL_WIDTH + w * ZOOM_CELL_STEP;
        const y = ZOOM_TOP_PAD + d * ZOOM_CELL_STEP;

        if (gi !== undefined) {
          ctx.fillStyle = getCellColor(gi, colors);
        } else {
          // Empty slot (no game aired)
          ctx.fillStyle = colors.bg;
        }
        ctx.fillRect(x, y, ZOOM_CELL_SIZE, ZOOM_CELL_SIZE);
      }
    }

    updateScrollHint(); // canvas just resized — the container's overflow may have changed
  }, [zoomedSeason, zoomGrid, games, values, hoveredGame, getColors, getCellColor, updateScrollHint]);

  // Hit test — all-seasons or zoomed
  const hitTest = useCallback((clientX: number, clientY: number): { gi: number | null; seasonClick: number | null } => {
    const canvas = canvasRef.current;
    if (!canvas) return { gi: null, seasonClick: null };
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    if (zoomedSeason !== null && zoomGrid) {
      // Zoomed view hit test
      const col = Math.floor((x - ZOOM_LABEL_WIDTH) / ZOOM_CELL_STEP);
      const row = Math.floor((y - ZOOM_TOP_PAD) / ZOOM_CELL_STEP);
      if (col < 0 || row < 0 || row >= 5) return { gi: null, seasonClick: null };
      const gi = zoomGrid.grid.get(`${col}-${row}`);
      return { gi: gi ?? null, seasonClick: null };
    }

    // All-seasons view
    const col = Math.floor((x - LABEL_WIDTH) / pitch);
    const row = Math.floor((y - TOP_PAD) / ROW_STEP);

    if (row < 0 || row >= seasonOrder.length) return { gi: null, seasonClick: null };

    // Click on season label area?
    if (x < LABEL_WIDTH) {
      return { gi: null, seasonClick: seasonOrder[row] };
    }

    if (col < 0) return { gi: null, seasonClick: null };
    const season = seasonOrder[row];
    const indices = seasonMap.get(season);
    if (!indices || col >= indices.length) return { gi: null, seasonClick: null };
    return { gi: indices[col], seasonClick: null };
  }, [zoomedSeason, zoomGrid, seasonOrder, seasonMap, pitch]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { gi } = hitTest(e.clientX, e.clientY);
    setHoveredGame(gi);
    if (gi !== null && games[gi]) {
      const game = games[gi];
      let wrText: string;
      if (isGain) {
        const g = gains?.[gi];
        wrText = g !== undefined && gain
          ? `${Math.round(gain.actual[gi] * 100)}% → ${Math.round(gain.optimal[gi] * 100)}% (${formatGain(g)})`
          : 'computing gain...';
      } else {
        const wr = winRates?.[gi];
        wrText = wr !== undefined ? `${Math.round(wr * 100)}% win` : 'simulating...';
      }
      setTooltip({
        x: e.clientX,
        y: e.clientY,
        text: `S${game.s} ${game.d} — ${wrText}`,
      });
    } else {
      setTooltip(null);
    }
  }, [hitTest, games, winRates, isGain, gains, gain]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const { gi, seasonClick } = hitTest(e.clientX, e.clientY);
    if (seasonClick !== null && zoomedSeason === null) {
      setZoomedSeason(seasonClick);
    } else if (gi !== null) {
      onGameClick(gi);
    }
  }, [hitTest, onGameClick, zoomedSeason]);

  const handleMouseLeave = useCallback(() => {
    setHoveredGame(null);
    setTooltip(null);
  }, []);

  return (
    <div style={{ position: 'relative' }}>
      {zoomedSeason !== null && (
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => setZoomedSeason(null)}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--accent)',
              padding: '4px 12px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            ← All Seasons
          </button>
          <span style={{ color: 'var(--text-h)', fontWeight: 600, fontSize: 14 }}>
            Season {zoomedSeason}
          </span>
        </div>
      )}
      {/* Wraps the scroll container so the fade overlay can be positioned
          against it without affecting the container's own overflow box. */}
      <div style={{ position: 'relative' }}>
        <div
          ref={containerRef}
          style={{ overflowX: 'auto', padding: '8px 0' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          onScroll={updateScrollHint}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={ariaLabel}
            style={{ cursor: 'pointer', display: 'block' }}
          />
        </div>
        {/* Overflow cue for when even MIN_PITCH doesn't fit (e.g. phones) —
            a right-edge fade using the same --bg the canvas paints itself
            with, so it blends in both themes. Purely visual: never blocks
            the scroll or click handlers above it. */}
        {scrollHint && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 28,
              background: 'linear-gradient(to right, transparent, var(--bg))',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      {scrollHint && (
        <div style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'right', marginTop: -4 }}>
          Scroll for more →
        </div>
      )}
      {/* Screen-reader / keyboard alternatives — additive only, never
          affects the canvas drawing or mouse interaction above. */}
      <div className="visually-hidden">
        <table>
          <caption>{isGain ? 'Gain from optimal play by season' : 'Win rate by season'}</caption>
          <thead>
            <tr>
              <th scope="col">Season</th>
              <th scope="col">Games</th>
              <th scope="col">{isGain ? 'Mean gain from optimal play' : 'Mean win rate'}</th>
            </tr>
          </thead>
          <tbody>
            {seasonSummaries.map(({ season, count, meanWinRate }) => (
              <tr key={season}>
                <td>Season {season}</td>
                <td>{count}</td>
                <td>{meanWinRate !== null
                  ? (isGain ? formatGain(meanWinRate) : `${Math.round(meanWinRate * 100)}%`)
                  : (isGain ? 'Not yet computed' : 'Not yet simulated')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <nav aria-label="Jump to season">
          <ul>
            <li>
              <button type="button" onClick={() => setZoomedSeason(null)}>
                All seasons
              </button>
            </li>
            {seasonOrder.map(season => (
              <li key={season}>
                <button type="button" onClick={() => setZoomedSeason(season)}>
                  Season {season} ({seasonMap.get(season)?.length ?? 0} games)
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {tooltip && (
        <div style={{
          position: 'fixed',
          left: tooltip.x + 12,
          top: tooltip.y - 8,
          background: '#060a30',
          color: '#f5d442',
          padding: '4px 8px',
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'monospace',
          pointerEvents: 'none',
          zIndex: 100,
          border: '1px solid #1a3ba8',
          whiteSpace: 'nowrap',
        }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
