import { useRef, useEffect, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { SimConfig } from '../sim/sim-engine';
import type { GridCell, DDImpactCell } from '../sim/sim-worker';
import { FAMOUS_PLAYERS } from '../sim/opponent-models';
import {
  DIMENSIONS,
  getFamousPlayerPosition,
  fractionToValue,
  valueToFraction,
  type DimensionName,
} from '../sim/dimensions';
import { gaussianBlur2D } from '../sim/math-utils';

interface Props {
  position: { x: number; y: number };
  onPositionChange: (pos: { x: number; y: number }) => void;
  xAxis: DimensionName;
  yAxis: DimensionName;
  onAxisChange: (axis: 'x' | 'y', dim: DimensionName) => void;
  pinnedValues: Record<string, number>;
  config: SimConfig;
  onWinRateUpdate: (rate: number | null) => void;
  /** Bumped by App.tsx each time the GameAnalyzer bridge (P-3) lands you
   *  here — triggers a single, non-looping pulse on the YOU marker. */
  pulseToken?: number;
  /** E-7 UI-states table: while a V-table build is in flight for Optimal
   *  (equity), the heat map keeps showing the PREVIOUS strategy's colors
   *  (never blanked) but dimmed 60% + a progress readout — never
   *  confidently-wrong undimmed stale colors. 'idle' when Optimal isn't
   *  the active selection at all. */
  equityBuildStatus?: 'idle' | 'building' | 'ready' | 'failed';
  equityBuildProgress?: number;
  /** P-1C "speed vs accuracy" control: games/cell for the REFINED (second)
   *  pass only — the fast pass (150 games/cell, resolution 20) is always
   *  fixed. Defaults to 450 ("Normal"), matching the pre-existing hardcoded
   *  refined-pass count, so omitting this prop reproduces today's exact
   *  behavior/timing. */
  refinedGamesPerCell?: number;
  /** P2 "DD impact difference map overlay" (TODOS.md): when true, cells
   *  show (winRate under the current DD strategy) − (winRate under DD
   *  strategy 'off') on a diverging blue/gold scale instead of the normal
   *  win-rate coloring, with contour lines hidden and its own legend. Off
   *  by default — the default (off) rendering is unaffected. */
  showDDImpact?: boolean;
}

/** P2 DD impact overlay diverging scale: negative (current strategy loses
 *  win rate vs. never using a DD strategy) = blue, zero = neutral, positive
 *  = gold — the app's Jeopardy blue/gold palette (see index.css `.jeopardy`
 *  theme's --bg/--accent). Domain is set per-render from the data's own
 *  max magnitude (see the render effect), so this is range-only. */
const DD_IMPACT_COLOR_RANGE: [string, string, string] = ['#1a4fd6', '#f2f2f2', '#d4af37'];

const WIDTH = 560;
const HEIGHT = 560;
const MARGIN = { top: 40, right: 20, bottom: 60, left: 70 };
const INNER_W = WIDTH - MARGIN.left - MARGIN.right;
const INNER_H = HEIGHT - MARGIN.top - MARGIN.bottom;

const CONTOUR_LEVELS = [0.33, 0.50, 0.67];

const xScale = d3.scaleLinear().domain([0, 1]).range([0, INNER_W]);
const yScale = d3.scaleLinear().domain([0, 1]).range([INNER_H, 0]);
const colorScale = d3.scaleSequential(d3.interpolateRdYlGn).domain([0, 1]);

const ALL_DIMENSIONS = Object.keys(DIMENSIONS) as DimensionName[];

export function HeatMap({
  position, onPositionChange,
  xAxis, yAxis, onAxisChange,
  pinnedValues, config, onWinRateUpdate,
  pulseToken,
  equityBuildStatus = 'idle',
  equityBuildProgress = 0,
  refinedGamesPerCell = 450,
  showDDImpact = false,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [grid, setGrid] = useState<GridCell[]>([]);
  const [resolution, setResolution] = useState(20);
  const [computing, setComputing] = useState(false);
  const [progress, setProgress] = useState(0);
  // P2 DD impact overlay state — a dedicated worker (see the lifecycle
  // effect below) computes this independently of the main grid above.
  const ddImpactWorkerRef = useRef<Worker | null>(null);
  const [diffGrid, setDiffGrid] = useState<DDImpactCell[]>([]);
  const [diffComputing, setDiffComputing] = useState(false);
  const [diffProgress, setDiffProgress] = useState(0);
  const [stale, setStale] = useState(false); // true when axes changed but grid hasn't arrived yet
  // P-3: single-shot pulse on the YOU marker when the GameAnalyzer bridge
  // lands here. Rendered as a one-iteration CSS animation (see .you-pulse
  // in App.css); cleared on animationend so it never loops.
  const [pulsing, setPulsing] = useState(false);

  // Axis selector popover state
  const [popover, setPopover] = useState<{ axis: 'x' | 'y'; anchorX: number; anchorY: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const posRef = useRef(position);
  posRef.current = position;
  const onPositionChangeRef = useRef(onPositionChange);
  onPositionChangeRef.current = onPositionChange;
  const rafRef = useRef<number | null>(null);

  // Track axes for stale detection
  const prevAxesRef = useRef({ xAxis, yAxis });

  // Worker setup
  useEffect(() => {
    const worker = new Worker(
      new URL('../sim/sim-worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.pct);
      } else if (msg.type === 'gridResult') {
        setGrid(msg.grid);
        setComputing(false);
        setStale(false);
        setProgress(1);
      } else if (msg.type === 'winRateResult') {
        onWinRateUpdate(msg.winRate);
      } else if (msg.type === 'error') {
        setComputing(false);
        console.warn('Worker error:', msg.message);
      }
    };

    worker.onerror = () => {
      setComputing(false);
      console.warn('Worker crashed — falling back to main thread');
    };

    workerRef.current = worker;
    return () => worker.terminate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute grid when config/axes/pinned change
  useEffect(() => {
    if (!workerRef.current) return;

    // Detect axis change for stale fade
    if (prevAxesRef.current.xAxis !== xAxis || prevAxesRef.current.yAxis !== yAxis) {
      setStale(true);
      prevAxesRef.current = { xAxis, yAxis };
    }

    setComputing(true);
    setProgress(0);

    workerRef.current.postMessage({ type: 'cancel' });
    workerRef.current.postMessage({
      type: 'computeGrid',
      resolution: 20,
      xAxis,
      yAxis,
      pinnedValues,
      config,
      gamesPerCell: 150,
    });
    setResolution(20);
    // refinedGamesPerCell isn't read here (the fast pass is always fixed at
    // 150/cell) but is included so changing the "Speed vs Accuracy" control
    // restarts the fast+refined cycle from scratch — otherwise, if the
    // refined pass had already completed (resolution === 40), the second
    // effect below would never re-fire since its own guard requires
    // resolution === 20.
  }, [xAxis, yAxis, pinnedValues, config, refinedGamesPerCell]);

  // When fast pass completes, start refined pass.
  //
  // P-2: refined-pass sims raised 300 → 450 (1.5×). Measured on the same
  // engine + buildSimParams path in Node (tsx, mulberry32-seeded, full
  // 41×41 grid, JIT-warmed; worker wall time scales the same way):
  //   before: 300 games/cell ≈ 19.4 ms/cell ≈ 32.6 s full refined pass
  //   after:  450 games/cell ≈ 28.5 ms/cell ≈ 47.9 s full refined pass
  // Same ballpark (cost is linear in sims; 600 games/cell measured 67.6 s
  // and was rejected). Per-cell binomial SE near winRate 0.5 improves
  // ~±2.9pp → ~±2.4pp before Gaussian smoothing.
  useEffect(() => {
    if (grid.length > 0 && resolution === 20 && !computing && workerRef.current) {
      setComputing(true);
      workerRef.current.postMessage({
        type: 'computeGrid',
        resolution: 40,
        xAxis,
        yAxis,
        pinnedValues,
        config,
        gamesPerCell: refinedGamesPerCell,
      });
      setResolution(40);
    }
  }, [grid, resolution, computing, refinedGamesPerCell]); // eslint-disable-line react-hooks/exhaustive-deps

  // P2 DD impact overlay: worker lifecycle. A SEPARATE worker from the main
  // `workerRef` above so this feature's 'cancel' messages never cross-talk
  // with the primary grid's in-flight computation — each Worker instance
  // gets its own module-scoped `cancelled` flag in sim-worker.ts. Created
  // lazily only once the toggle is on; torn down (and diff state cleared)
  // when it's off, so the default (off) path never spins up this worker or
  // touches diff state at all.
  useEffect(() => {
    if (!showDDImpact) {
      setDiffGrid([]);
      setDiffComputing(false);
      setDiffProgress(0);
      return;
    }

    const worker = new Worker(
      new URL('../sim/sim-worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'ddImpactProgress') {
        setDiffProgress(msg.pct);
      } else if (msg.type === 'ddImpactGridResult') {
        setDiffGrid(msg.grid);
        setDiffComputing(false);
        setDiffProgress(1);
      } else if (msg.type === 'error') {
        setDiffComputing(false);
        console.warn('DD impact worker error:', msg.message);
      }
    };

    worker.onerror = () => {
      setDiffComputing(false);
      console.warn('DD impact worker crashed');
    };

    ddImpactWorkerRef.current = worker;
    return () => {
      worker.terminate();
      ddImpactWorkerRef.current = null;
    };
  }, [showDDImpact]);

  // P2 DD impact overlay: trigger computation. Piggybacks on the primary
  // grid's own `resolution` state (20 fast / 40 refined) and matching
  // gamesPerCell, so the overlay automatically follows the same
  // fast→refined progression the main grid already does, without a
  // separate adaptive-resolution mechanism.
  useEffect(() => {
    if (!showDDImpact) return;
    const worker = ddImpactWorkerRef.current;
    if (!worker || grid.length === 0) return;

    const gamesPerCell = resolution === 20 ? 150 : refinedGamesPerCell;
    setDiffComputing(true);
    setDiffProgress(0);
    worker.postMessage({ type: 'cancel' });
    worker.postMessage({
      type: 'computeDDImpactGrid',
      resolution,
      xAxis,
      yAxis,
      pinnedValues,
      config,
      gamesPerCell,
    });
  }, [showDDImpact, resolution, xAxis, yAxis, pinnedValues, config, refinedGamesPerCell, grid.length]);

  // P-3: fire the one-shot pulse whenever the bridge token bumps.
  useEffect(() => {
    if (pulseToken && pulseToken > 0) setPulsing(true);
  }, [pulseToken]);

  // Debounced win rate computation
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workerRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      // buildSimParams (worker side) expects REAL dimension values, not
      // [0,1] position fractions. For the legacy [0,1] dims the two were
      // identical, which hid this; a dollars axis (expectedCoryat, P-1)
      // makes the conversion load-bearing.
      workerRef.current?.postMessage({
        type: 'computeWinRate',
        xAxis,
        yAxis,
        xVal: fractionToValue(DIMENSIONS[xAxis], position.x),
        yVal: fractionToValue(DIMENSIONS[yAxis], position.y),
        pinnedValues,
        config,
        nGames: 500,
      });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [position, xAxis, yAxis, pinnedValues, config]);

  // Close popover on outside click
  useEffect(() => {
    if (!popover) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopover(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popover]);

  // Close popover on Escape
  useEffect(() => {
    if (!popover) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [popover]);

  const handleAxisLabelClick = useCallback((axis: 'x' | 'y', event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    setPopover({
      axis,
      anchorX: rect.left - svgRect.left + rect.width / 2,
      anchorY: rect.top - svgRect.top + rect.height,
    });
  }, []);

  const handleDimensionSelect = useCallback((dim: DimensionName) => {
    if (!popover) return;
    const currentDim = popover.axis === 'x' ? xAxis : yAxis;
    if (dim !== currentDim) {
      onAxisChange(popover.axis, dim);
    }
    setPopover(null);
  }, [popover, xAxis, yAxis, onAxisChange]);

  // ── Effect: Render grid + static elements ──
  useEffect(() => {
    if (!svgRef.current || grid.length === 0) return;

    const svg = d3.select(svgRef.current);
    // Only clear the main group, not axis labels (they're React-managed)
    svg.selectAll('.main-group').remove();

    // E-7: a V-table build in flight for Optimal (equity) dims the
    // PREVIOUS strategy's colors to 40% opacity (60% dimmed) rather than
    // blanking or leaving them confidently undimmed — see the UI-states
    // table. Axis-change staleness (pre-existing) wins if both apply.
    const equityDimmed = equityBuildStatus === 'building';
    const opacity = stale ? 0.3 : equityDimmed ? 0.4 : 1;

    const g = svg.append('g')
      .attr('class', 'main-group')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`)
      .style('opacity', opacity)
      .style('transition', 'opacity 0.3s ease');

    const res = Math.round(Math.sqrt(grid.length)) - 1;
    const cellW = INNER_W / res;
    const cellH = INNER_H / res;

    // Smooth grid values
    const rawValues: number[] = new Array((res + 1) * (res + 1)).fill(0);
    for (const cell of grid) {
      const xi = Math.round(cell.x * res);
      const yi = Math.round(cell.y * res);
      if (xi <= res && yi <= res) {
        rawValues[yi * (res + 1) + xi] = cell.winRate;
      }
    }
    const smoothedValues = gaussianBlur2D(rawValues, res + 1, res + 1, 2);

    // P2 DD impact overlay: only engages once a diff grid matching the
    // CURRENT resolution has arrived — while stale/still computing, the
    // normal win-rate cells below keep rendering (never blank).
    const diffReady = showDDImpact && diffGrid.length === grid.length;
    let smoothedDiffValues: number[] | null = null;
    let diffColorScale: d3.ScaleLinear<string, string> | null = null;
    if (diffReady) {
      const rawDiff: number[] = new Array((res + 1) * (res + 1)).fill(0);
      for (const cell of diffGrid) {
        const xi = Math.round(cell.x * res);
        const yi = Math.round(cell.y * res);
        if (xi <= res && yi <= res) {
          rawDiff[yi * (res + 1) + xi] = cell.diff;
        }
      }
      smoothedDiffValues = gaussianBlur2D(rawDiff, res + 1, res + 1, 2);
      let maxAbsDiff = 0.01; // floor avoids a degenerate zero-width domain
      for (const v of smoothedDiffValues) {
        if (Math.abs(v) > maxAbsDiff) maxAbsDiff = Math.abs(v);
      }
      diffColorScale = d3.scaleLinear<string>()
        .domain([-maxAbsDiff, 0, maxAbsDiff])
        .range(DD_IMPACT_COLOR_RANGE)
        .clamp(true);
    }

    // Draw cells
    g.selectAll('rect.cell')
      .data(grid)
      .join('rect')
      .attr('class', 'cell')
      .attr('x', d => xScale(d.x))
      .attr('y', d => yScale(d.y) - cellH)
      .attr('width', cellW + 1)
      .attr('height', cellH + 1)
      .attr('fill', (_, i) => (diffReady && smoothedDiffValues && diffColorScale)
        ? diffColorScale(smoothedDiffValues[i] ?? 0)
        : colorScale(smoothedValues[i] ?? 0))
      .attr('opacity', 0.85);

    // P-2 contour confidence: dash pattern keyed off refinement stage.
    // Per-cell sample counts don't come back from the worker (gridResult
    // carries winRate only), so the stage is the sample-count proxy:
    // fast pass (20×20, 150 games/cell) = dashed, refined pass (40×40,
    // 450 games/cell) = solid. Dash — NOT opacity — because faint lines
    // on a win-rate color field read as "low value here."
    const isFastPass = res <= 20;

    // Contour lines — hidden entirely while the DD impact overlay is on
    // (P2 spec: "with ... the contour lines hidden").
    if (grid.length > 100 && !showDDImpact) {
      const contourRes = res + 1;
      const raw: number[] = new Array(contourRes * contourRes).fill(0);
      for (const cell of grid) {
        const xi = Math.round(cell.x * res);
        const yi = Math.round(cell.y * res);
        if (xi < contourRes && yi < contourRes) {
          raw[yi * contourRes + xi] = cell.winRate;
        }
      }
      const values = gaussianBlur2D(raw, contourRes, contourRes, 2);

      const contours = d3.contours()
        .size([contourRes, contourRes])
        .thresholds(CONTOUR_LEVELS)(values);

      g.selectAll('path.contour')
        .data(contours)
        .join('path')
        .attr('class', 'contour')
        .attr('d', d3.geoPath(d3.geoIdentity().scale(INNER_W / (contourRes - 1)).reflectY(true).translate([0, INNER_H])))
        .attr('fill', 'none')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.7)
        .attr('stroke-dasharray', isFastPass ? '6,4' : null);

      // Contour labels
      for (const contour of contours) {
        if (contour.coordinates.length === 0) continue;
        const firstRing = contour.coordinates[0]?.[0];
        if (!firstRing || firstRing.length === 0) continue;
        const mid = firstRing[Math.floor(firstRing.length / 2)];
        if (mid) {
          const contourX = d3.scaleLinear().domain([0, contourRes - 1]).range([0, INNER_W]);
          const contourY = d3.scaleLinear().domain([0, contourRes - 1]).range([INNER_H, 0]);
          g.append('text')
            .attr('x', contourX(mid[0]))
            .attr('y', contourY(mid[1]))
            .attr('fill', '#fff')
            .attr('font-size', '11px')
            .attr('font-weight', '600')
            .attr('text-anchor', 'middle')
            .attr('dy', '0.35em')
            .style('text-shadow', '0 1px 3px rgba(0,0,0,0.7)')
            .text(`${Math.round(contour.value * 100)}%`);
        }
      }
    }

    // Click-to-teleport overlay (on top of cells/contours, under markers)
    g.append('rect')
      .attr('class', 'click-target')
      .attr('width', INNER_W)
      .attr('height', INNER_H)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('click', function (event) {
        const [mx, my] = d3.pointer(event);
        const nx = Math.max(0, Math.min(1, xScale.invert(mx)));
        const ny = Math.max(0, Math.min(1, yScale.invert(my)));
        onPositionChangeRef.current({ x: nx, y: ny });
      });

    // Famous player markers. Positions resolve per-axis (P-1: each preset's
    // dims have their own lookup — see getFamousPlayerPosition); a player
    // with no known position on either axis is hidden, never guessed.
    // Values are in real dimension units (e.g. dollars for expectedCoryat),
    // so normalize through valueToFraction before hitting the [0,1] scales.
    const xDimCfg = DIMENSIONS[xAxis];
    const yDimCfg = DIMENSIONS[yAxis];
    for (const player of FAMOUS_PLAYERS) {
      const xPos = getFamousPlayerPosition(player, xAxis);
      const yPos = getFamousPlayerPosition(player, yAxis);
      if (xPos === undefined || yPos === undefined) continue;

      const px = xScale(valueToFraction(xDimCfg, xPos));
      const py = yScale(valueToFraction(yDimCfg, yPos));
      const isEstimated = player.estimated?.has(xAxis) || player.estimated?.has(yAxis);

      if (isEstimated) {
        // Dashed uncertainty ring for estimated positions
        g.append('circle')
          .attr('cx', px)
          .attr('cy', py)
          .attr('r', 12)
          .attr('fill', 'none')
          .attr('stroke', 'rgba(255,255,255,0.4)')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,3');
      }

      g.append('circle')
        .attr('cx', px)
        .attr('cy', py)
        .attr('r', 5)
        .attr('fill', isEstimated ? 'rgba(255,255,255,0.6)' : '#fff')
        .attr('stroke', '#333')
        .attr('stroke-width', 1.5)
        .attr('opacity', isEstimated ? 0.7 : 0.9);

      g.append('text')
        .attr('x', px + 8)
        .attr('y', py + 4)
        .attr('fill', '#fff')
        .attr('font-size', '10px')
        .attr('font-weight', '500')
        .attr('opacity', isEstimated ? 0.6 : 1)
        .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8)')
        .text(player.name.split(' ').pop()!);
    }

    // YOU marker
    // Set the initial transform here (not just in the separate "Update
    // marker position" effect below, which only re-fires when `position`
    // itself changes): this whole main-group is torn down and rebuilt
    // whenever `grid` changes (e.g. the fast→refined-pass resolution bump),
    // and without an initial transform the freshly-created group briefly
    // sits untransformed at the chart's origin (top-left), overlapping the
    // title above it.
    // Read from posRef (not `position` directly) so this effect's
    // dependency array doesn't need `position` — same ref pattern the drag
    // handlers below already use, since adding it here would force a full
    // grid/contour rebuild on every drag frame (the exact cost the separate
    // "Update marker position" effect exists to avoid).
    const initialPos = posRef.current;
    const youGroup = g.append('g')
      .attr('class', 'you-marker')
      .attr('transform', `translate(${xScale(initialPos.x)},${yScale(initialPos.y)})`)
      .style('cursor', 'grab');

    youGroup.append('circle')
      .attr('r', 12)
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);

    youGroup.append('circle')
      .attr('r', 5)
      .attr('fill', '#fff');

    youGroup.append('text')
      .attr('y', -18)
      .attr('text-anchor', 'middle')
      .attr('fill', '#fff')
      .attr('font-size', '12px')
      .attr('font-weight', '700')
      .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8)')
      .text('YOU');

    // Drag handler (throttled to rAF for smooth 60fps interaction)
    const drag = d3.drag<SVGGElement, unknown>()
      .on('start', function () {
        d3.select(this).style('cursor', 'grabbing');
      })
      .on('drag', function (event) {
        const gNode = (this as SVGGElement).parentNode as SVGGElement;
        const [mx, my] = d3.pointer(event.sourceEvent, gNode);
        const xVal = Math.max(0, Math.min(1, xScale.invert(mx)));
        const yVal = Math.max(0, Math.min(1, yScale.invert(my)));
        // Update SVG position immediately for visual responsiveness
        d3.select(this).attr('transform', `translate(${xScale(xVal)},${yScale(yVal)})`);
        // Throttle React state updates to animation frames
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          onPositionChangeRef.current({ x: xVal, y: yVal });
          rafRef.current = null;
        });
      })
      .on('end', function (event) {
        d3.select(this).style('cursor', 'grab');
        // Flush any pending rAF and send final position
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const gNode = (this as SVGGElement).parentNode as SVGGElement;
        const [mx, my] = d3.pointer(event.sourceEvent, gNode);
        const xVal = Math.max(0, Math.min(1, xScale.invert(mx)));
        const yVal = Math.max(0, Math.min(1, yScale.invert(my)));
        onPositionChangeRef.current({ x: xVal, y: yVal });
      });

    youGroup.call(drag);

    // Axes — tick labels speak each dimension's own units via format()
    // (P-1 load-bearing fix: a dollars axis must never render through a
    // hardcoded percent formatter). Scales stay [0,1] fractions; ticks map
    // fraction → real value → formatted string.
    const xAxisG = d3.axisBottom(xScale)
      .ticks(5)
      .tickFormat(d => xDimCfg.format(fractionToValue(xDimCfg, +d)));

    const yAxisG = d3.axisLeft(yScale)
      .ticks(5)
      .tickFormat(d => yDimCfg.format(fractionToValue(yDimCfg, +d)));

    g.append('g')
      .attr('transform', `translate(0,${INNER_H})`)
      .call(xAxisG)
      .selectAll('text')
      .attr('fill', 'var(--text)');

    g.append('g')
      .call(yAxisG)
      .selectAll('text')
      .attr('fill', 'var(--text)');

    // Axis styling
    g.selectAll('.domain, .tick line').attr('stroke', 'var(--border)');
  }, [grid, xAxis, yAxis, stale, equityBuildStatus, showDDImpact, diffGrid]);

  // ── Effect: Update marker position ──
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const marker = svg.select<SVGGElement>('.you-marker');
    if (!marker.empty()) {
      marker.attr('transform', `translate(${xScale(position.x)},${yScale(position.y)})`);
    }
  }, [position]);

  const xDim = DIMENSIONS[xAxis];
  const yDim = DIMENSIONS[yAxis];

  // P2 DD impact overlay legend caption — same floor as the render
  // effect's color-scale domain, computed independently here (over raw,
  // unsmoothed values) since this is plain JSX, not the d3 effect.
  let diffMaxAbs = 0.01;
  for (const cell of diffGrid) {
    if (Math.abs(cell.diff) > diffMaxAbs) diffMaxAbs = Math.abs(cell.diff);
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <svg
        ref={svgRef}
        width={WIDTH}
        height={HEIGHT}
        style={{ touchAction: 'none' }}
        role="img"
        aria-label={`Win rate heat map, ${xDim.label} by ${yDim.label}`}
      >
        {/* Title */}
        <text
          x={WIDTH / 2}
          y={24}
          textAnchor="middle"
          fill="var(--text-h)"
          fontSize="16px"
          fontWeight="600"
        >
          {`Win Rate by ${xDim.label} × ${yDim.label}`}
        </text>
      </svg>

      {/* P-3: one-shot YOU-marker pulse (single CSS animation iteration,
          removed on animationend — never loops; prefers-reduced-motion
          handled in App.css). Keyed by pulseToken so repeat submits
          restart the animation. */}
      {pulsing && (
        <div
          key={pulseToken}
          className="you-pulse"
          aria-hidden="true"
          onAnimationEnd={() => setPulsing(false)}
          style={{
            left: MARGIN.left + xScale(position.x),
            top: MARGIN.top + yScale(position.y),
          }}
        />
      )}

      {/* Clickable X-axis label */}
      <button
        onClick={(e) => handleAxisLabelClick('x', e)}
        style={{
          position: 'absolute',
          bottom: 8,
          left: MARGIN.left + INNER_W / 2,
          transform: 'translateX(-50%)',
          background: 'none',
          border: 'none',
          color: 'var(--text-h)',
          fontSize: '14px',
          fontWeight: 600,
          cursor: 'pointer',
          padding: '4px 8px',
          borderRadius: 4,
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
        onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
        aria-label={`Change X-axis dimension, currently ${xDim.label}`}
      >
        {xDim.label} <span style={{ fontSize: '10px', opacity: 0.6 }}>▼</span>
      </button>

      {/* Clickable Y-axis label */}
      <button
        onClick={(e) => handleAxisLabelClick('y', e)}
        style={{
          position: 'absolute',
          top: MARGIN.top + INNER_H / 2,
          left: 4,
          transform: 'translateY(-50%) rotate(-90deg)',
          transformOrigin: 'center center',
          background: 'none',
          border: 'none',
          color: 'var(--text-h)',
          fontSize: '14px',
          fontWeight: 600,
          cursor: 'pointer',
          padding: '4px 8px',
          borderRadius: 4,
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
        onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
        aria-label={`Change Y-axis dimension, currently ${yDim.label}`}
      >
        {yDim.label} <span style={{ fontSize: '10px', opacity: 0.6 }}>▼</span>
      </button>

      {/* Axis dimension popover */}
      {popover && (
        <div
          ref={popoverRef}
          style={{
            position: 'absolute',
            left: popover.anchorX,
            top: popover.anchorY + 4,
            transform: 'translateX(-50%)',
            background: 'rgba(30, 30, 40, 0.95)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 8,
            padding: '4px 0',
            minWidth: 200,
            zIndex: 100,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}
          role="listbox"
          aria-label={`Select ${popover.axis === 'x' ? 'X' : 'Y'}-axis dimension`}
        >
          {ALL_DIMENSIONS.map((dim) => {
            const dimConfig = DIMENSIONS[dim];
            const isSelected = dim === (popover.axis === 'x' ? xAxis : yAxis);
            const isOtherAxis = dim === (popover.axis === 'x' ? yAxis : xAxis);
            return (
              <button
                key={dim}
                onClick={() => handleDimensionSelect(dim)}
                role="option"
                aria-selected={isSelected}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '10px 16px',
                  border: 'none',
                  background: isSelected ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: '#fff',
                  fontSize: '14px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  opacity: isOtherAxis ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isSelected ? 'rgba(255,255,255,0.1)' : 'transparent';
                }}
              >
                <span style={{ width: 16, textAlign: 'center' }}>{isSelected ? '✓' : ''}</span>
                <span>{dimConfig.label}</span>
                {isOtherAxis && <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.6 }}>(swap)</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* P2 DD impact overlay legend — replaces the contour-confidence
          legend (contour lines are hidden while this is on, see the
          render effect above). */}
      {showDDImpact ? (
        <div style={{ textAlign: 'center', marginTop: 4 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '11px', color: 'var(--text-muted)' }}>
            <span>−{(diffMaxAbs * 100).toFixed(0)}pp</span>
            <div
              aria-hidden="true"
              style={{
                width: 120,
                height: 10,
                borderRadius: 5,
                background: `linear-gradient(to right, ${DD_IMPACT_COLOR_RANGE[0]}, ${DD_IMPACT_COLOR_RANGE[1]}, ${DD_IMPACT_COLOR_RANGE[2]})`,
              }}
            />
            <span>+{(diffMaxAbs * 100).toFixed(0)}pp</span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: 2 }}>
            DD impact: current strategy − DD off
            {diffComputing && ` (computing… ${Math.round(diffProgress * 100)}%)`}
          </div>
        </div>
      ) : (
        grid.length > 100 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', marginTop: 4 }}>
            dashed contour = fewer samples
          </div>
        )
      )}

      {computing && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', marginTop: 8 }}>
          {stale ? 'Recomputing' : 'Computing'}... {Math.round(progress * 100)}%
        </div>
      )}

      {/* E-7: V-table build progress — heat map still shows the previous
          strategy's (dimmed) colors above while this runs. */}
      {equityBuildStatus === 'building' && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', marginTop: 4 }}>
          Building Optimal (equity) strategy... {Math.round(equityBuildProgress * 100)}%
        </div>
      )}
    </div>
  );
}
