import { useRef, useEffect, useCallback, useState, useMemo } from 'react';

export interface GameData {
  s: number;       // season
  d: string;       // airDate
  o: [{ n: string; k: number; b: number; fj: number; c: number },
      { n: string; k: number; b: number; fj: number; c: number }];
}

interface Props {
  games: GameData[];
  winRates: number[] | null;  // parallel array, one per game
  progress: number | null;    // 0-1 during simulation, null when idle
  onGameClick: (index: number) => void;
}

const CELL_SIZE = 6;
const CELL_GAP = 1;
const CELL_STEP = CELL_SIZE + CELL_GAP;
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

/** Fisher-Yates shuffle for reveal order */
function shuffleIndices(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function ContributionGraph({ games, winRates, progress, onGameClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredGame, setHoveredGame] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [zoomedSeason, setZoomedSeason] = useState<number | null>(null);

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
    if (progress === null || !winRates) return null; // show all when done
    const count = Math.floor(progress * games.length);
    return new Set(revealOrder.slice(0, count));
  }, [progress, games.length, winRates, revealOrder]);

  // Widest season, in games — sets the canvas column count
  const maxCols = useMemo(() => {
    let m = 0;
    for (const indices of seasonMap.values()) {
      m = Math.max(m, indices.length);
    }
    return m;
  }, [seasonMap]);

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
      cgEmpty: get('--cg-empty', '#0a0e3d'),
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

  // Get cell color considering reveal animation
  const getCellColor = useCallback((gi: number, colors: ReturnType<typeof getColors>) => {
    if (hoveredGame === gi) return '#ffffff';
    if (!winRates || winRates[gi] === undefined) return colors.cgEmpty;
    // During simulation, only show revealed cells
    if (revealedSet && !revealedSet.has(gi)) return colors.cgEmpty;
    return winRateColorFn(winRates[gi], colors);
  }, [winRates, hoveredGame, revealedSet, winRateColorFn]);

  // Draw canvas — all-seasons view
  useEffect(() => {
    if (zoomedSeason !== null) return; // zoomed view draws separately
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rows = seasonOrder.length;
    const cols = maxCols;
    const width = LABEL_WIDTH + cols * CELL_STEP;
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
      ctx.fillText(`S${season}`, LABEL_WIDTH - 4, y + CELL_SIZE / 2);

      // Cells
      for (let c = 0; c < indices.length; c++) {
        const gi = indices[c];
        const x = LABEL_WIDTH + c * CELL_STEP;
        ctx.fillStyle = getCellColor(gi, colors);
        ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
      }
    }
  }, [games, winRates, hoveredGame, zoomedSeason, getColors, getCellColor, seasonOrder, seasonMap, maxCols]);

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
  }, [zoomedSeason, zoomGrid, games, winRates, hoveredGame, getColors, getCellColor]);

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
    const col = Math.floor((x - LABEL_WIDTH) / CELL_STEP);
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
  }, [zoomedSeason, zoomGrid, seasonOrder, seasonMap]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { gi } = hitTest(e.clientX, e.clientY);
    setHoveredGame(gi);
    if (gi !== null && games[gi]) {
      const game = games[gi];
      const wr = winRates?.[gi];
      const wrText = wr !== undefined ? `${Math.round(wr * 100)}% win` : 'simulating...';
      setTooltip({
        x: e.clientX,
        y: e.clientY,
        text: `S${game.s} ${game.d} — ${wrText}`,
      });
    } else {
      setTooltip(null);
    }
  }, [hitTest, games, winRates]);

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
      <div
        ref={containerRef}
        style={{ overflowX: 'auto', padding: '8px 0' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        <canvas
          ref={canvasRef}
          style={{ cursor: 'pointer', display: 'block' }}
        />
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
