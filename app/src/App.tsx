import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { HeatMap } from './components/HeatMap';
import { ControlsPanel } from './components/ControlsPanel';
import { StatsPanel } from './components/StatsPanel';
import { ContributionGraph, type GameData } from './components/ContributionGraph';
import { GameDetail, type SimRun, type DDGameDetail } from './components/GameDetail';
import { GamesControls } from './components/GamesControls';
import { YourNumber } from './components/YourNumber';
import { MarginalReturns } from './components/MarginalReturns';
import { DDHeatStrip } from './components/DDHeatStrip';
import { GameAnalyzer, type GameEstimate } from './components/GameAnalyzer';
import { DEFAULT_CONFIG, type DDStrategy, type SimConfig } from './sim/sim-engine';
import type { ValueTable } from './sim/value-function';
import {
  DIMENSIONS,
  AXIS_PRESETS,
  findPresetForAxes,
  valueToFraction,
  fractionToValue,
  buzzSpeedToWinPct,
  interpolateOpponent,
  REFINED_GAMES_PER_CELL,
  type DimensionName,
  type AxisPreset,
  type RefinedSpeed,
} from './sim/dimensions';
import './App.css';

/** clue-stats.json shape (scripts/build-clue-stats.ts, E-1/E-6). Only the
 *  fields this app actually consumes are typed — the file carries more
 *  debugging metadata (see PLAN.md E-1). */
export interface ClueStats {
  generatedAt: string;
  source: {
    completeGames: number;
    [k: string]: unknown;
  };
  ddRowWeights: { J: number[]; DJ: number[] };
  ddWagerVsRoundMax: {
    J: { p10: number; p25: number; p50: number; p75: number; p90: number; mean: number; n: number };
    DJ: { p10: number; p25: number; p50: number; p75: number; p90: number; mean: number; n: number };
  };
}

/**
 * E-2's cache-key spec, keyed by the knobs that invalidate a built V-table:
 * (opponentModel, rhoB, rhoP, opponents' DD strategy incl. ddWagerFraction,
 * fjStrategy, includeFJ). rhoB/rhoP/opponentDdStrategy/fjStrategy have no UI
 * control yet (always DEFAULT_CONFIG's fixed values) but are included for
 * completeness/forward-compat — they're constants today, so they never
 * cause a spurious cache miss.
 */
interface ValueTableCacheInputs {
  opponentModel: number;
  rhoB: number;
  rhoP: number;
  opponentDdStrategy: string | null;
  ddWagerFraction: number;
  fjStrategy: string;
  includeFJ: boolean;
  /** P2 "DD seeking / square-selection strategy" (TODOS.md): the rollouts
   *  this table is built from thread `config` straight into
   *  `simulateFromState`, so a square-selection change invalidates it. */
  squareSelection: string;
  opponentSquareSelection: string;
}

function valueTableCacheKey(inputs: ValueTableCacheInputs): string {
  return JSON.stringify(inputs);
}

// --- URL hash state for shareable links ---

interface AppState {
  x: number;
  y: number;
  xAxis: DimensionName;
  yAxis: DimensionName;
  pinned: Record<string, number>;
  fj: boolean;
  theme: 'clean' | 'jeopardy';
  tab: 'your-game' | 'explorer' | 'games';
  refinedSpeed: RefinedSpeed;
  /** P2 "DD seeking / square-selection strategy" (TODOS.md). Your (player 0)
   *  and opponents' square-selection strategy. Both default off. */
  seekDD: boolean;
  opponentSeekDD: boolean;
}

function encodeState(s: AppState): string {
  const parts: string[] = [
    `x=${s.x.toFixed(3)}`,
    `y=${s.y.toFixed(3)}`,
    `xa=${s.xAxis}`,
    `ya=${s.yAxis}`,
    `fj=${s.fj ? 1 : 0}`,
    `t=${s.theme === 'jeopardy' ? 'j' : 'c'}`,
    `tab=${s.tab}`,
    `sp=${s.refinedSpeed[0]}`, // 'f' | 'n' | 'p' — Speed vs Accuracy (P-1C)
    `sk=${s.seekDD ? 1 : 0}`, // DD seeking (TODOS.md P2) — you
    `osk=${s.opponentSeekDD ? 1 : 0}`, // DD seeking — opponents
  ];
  // Only encode non-default pinned values
  for (const [name, val] of Object.entries(s.pinned)) {
    if (name !== s.xAxis && name !== s.yAxis) {
      const def = DIMENSIONS[name as DimensionName]?.defaultValue;
      if (def === undefined || Math.abs(val - def) > 0.01) {
        parts.push(`p_${name}=${val.toFixed(3)}`);
      }
    }
  }
  return parts.join('&');
}

function decodeState(hash: string): Partial<AppState> | null {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const result: Partial<AppState> = {};

  const x = parseFloat(params.get('x') || '');
  const y = parseFloat(params.get('y') || '');
  if (!isNaN(x) && !isNaN(y)) {
    result.x = Math.max(0, Math.min(1, x));
    result.y = Math.max(0, Math.min(1, y));
  }

  const xa = params.get('xa') as DimensionName;
  if (xa && DIMENSIONS[xa]) result.xAxis = xa;

  const ya = params.get('ya') as DimensionName;
  if (ya && DIMENSIONS[ya]) result.yAxis = ya;

  const fj = params.get('fj');
  if (fj !== null) result.fj = fj !== '0';

  const t = params.get('t');
  if (t === 'j') result.theme = 'jeopardy';
  else if (t === 'c') result.theme = 'clean';

  const tab = params.get('tab') as AppState['tab'];
  if (tab && ['your-game', 'explorer', 'games'].includes(tab)) result.tab = tab;

  const sp = params.get('sp');
  if (sp === 'f') result.refinedSpeed = 'fast';
  else if (sp === 'n') result.refinedSpeed = 'normal';
  else if (sp === 'p') result.refinedSpeed = 'precise';

  const sk = params.get('sk');
  if (sk !== null) result.seekDD = sk !== '0';

  const osk = params.get('osk');
  if (osk !== null) result.opponentSeekDD = osk !== '0';

  // Pinned values
  const pinned: Record<string, number> = {};
  for (const [key, val] of params.entries()) {
    if (key.startsWith('p_')) {
      const name = key.slice(2);
      const v = parseFloat(val);
      if (!isNaN(v) && DIMENSIONS[name as DimensionName]) {
        pinned[name] = v;
      }
    }
  }
  if (Object.keys(pinned).length > 0) result.pinned = pinned;

  return Object.keys(result).length > 0 ? result : null;
}

// --- Main App ---

export default function App() {
  // Try to restore state from URL hash
  const initial = decodeState(window.location.hash);

  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: initial?.x ?? 0.4,
    y: initial?.y ?? 0.5,
  });
  const [winRate, setWinRate] = useState<number | null>(null);
  const [xAxis, setXAxis] = useState<DimensionName>(initial?.xAxis ?? 'knowledge');
  const [yAxis, setYAxis] = useState<DimensionName>(initial?.yAxis ?? 'buzzerSpeed');
  const [pinnedValues, setPinnedValues] = useState<Record<string, number>>(() => {
    const defaults: Record<string, number> = {};
    for (const [name, dim] of Object.entries(DIMENSIONS)) {
      defaults[name] = dim.defaultValue;
    }
    return { ...defaults, ...(initial?.pinned ?? {}) };
  });
  const [includeFJ, setIncludeFJ] = useState(initial?.fj ?? true);
  const [theme, setTheme] = useState<'clean' | 'jeopardy'>(initial?.theme ?? 'clean');
  // P-1C "Speed vs Accuracy": games/cell for the Explorer grid's refined
  // pass. Default 'normal' (450) reproduces the pre-existing hardcoded
  // behavior/timing exactly.
  const [refinedSpeed, setRefinedSpeed] = useState<RefinedSpeed>(initial?.refinedSpeed ?? 'normal');
  // P2 "DD impact difference map overlay" (TODOS.md). Off by default, not
  // persisted in the URL hash (a per-session viewing toggle, not a
  // strategy/knob choice).
  const [showDDImpact, setShowDDImpact] = useState(false);
  // P2 "DD seeking / square-selection strategy" (TODOS.md). Your (player 0)
  // and opponents' square-selection strategy — Tesauro 2012's p_DD + 0.1·p_RC
  // Daily Double seeking. Both off (today's top-down order) by default.
  const [seekDD, setSeekDD] = useState(initial?.seekDD ?? false);
  const [opponentSeekDD, setOpponentSeekDD] = useState(initial?.opponentSeekDD ?? false);
  // Landing tab is All Games: it is the one view that reads on its own, with
  // no numbers to type in first. Your Game and Explorer are opt-in from there.
  const [tab, setTab] = useState<AppState['tab']>(initial?.tab ?? 'games');

  // P-3 journey bridge: bumped on each GameAnalyzer submit → the Explorer
  // YOU marker pulses once; the bridge link to All Games appears.
  const [pulseToken, setPulseToken] = useState(0);
  const bridgeVisible = pulseToken > 0;

  // E-6: empirical clue-level priors (DD row weights + wager quantiles),
  // fetched once at startup. null = not yet loaded OR load failed — both
  // cases fall back to sim-engine's hardcoded DD_ROW_WEIGHTS (console.warn'd
  // below) and hide the DD heat strip (E-7 item 7's documented fallback).
  const [clueStats, setClueStats] = useState<ClueStats | null>(null);

  // E-7: DD Strategy selector — single source of truth, shared by
  // ControlsPanel (Explorer) and GamesControls (All Games, read-only
  // reflection). Default unchanged from the pre-E-7 hardcoded value.
  const [ddStrategy, setDdStrategy] = useState<DDStrategy>('aggressive');
  // V-table cache, keyed by valueTableCacheKey(...) — never rebuilt for a
  // key already present (e.g. switching back and forth, or a tab switch).
  const [valueTableCache, setValueTableCache] = useState<Record<string, ValueTable>>({});
  const [equityBuildStatus, setEquityBuildStatus] = useState<'idle' | 'building' | 'ready' | 'failed'>('idle');
  const [equityBuildProgress, setEquityBuildProgress] = useState(0);
  const equityBuildCancelledRef = useRef(false);
  const equityBuildKeyRef = useRef<string | null>(null);
  const equityBuildingActiveRef = useRef(false);

  // Games data
  const [games, setGames] = useState<GameData[] | null>(null);
  const [gameWinRates, setGameWinRates] = useState<number[] | null>(null);
  const [gameSimProgress, setGameSimProgress] = useState<number | null>(null);
  const [selectedGame, setSelectedGame] = useState<number | null>(null);
  const [singleGameResults, setSingleGameResults] = useState<SimRun[] | null>(null);
  // TODOS "P2 — GameDetail DD event rows": one seeded, history-tracked sim's
  // DD events for the currently selected game (additive to the existing
  // unseeded singleGameResults path above).
  const [ddGameDetail, setDdGameDetail] = useState<DDGameDetail | null>(null);

  // Persistent worker for all-games simulation (avoids re-serializing 1MB games array)
  const gameWorkerRef = useRef<Worker | null>(null);
  const gamesLoadedInWorker = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we need to re-sim when switching to games tab
  const gameSimStale = useRef(true);
  // Track sim pass: 'idle' | 'fast' | 'refined'
  const simPassRef = useRef<'idle' | 'fast' | 'refined'>('idle');
  // Store params from last sim trigger so refined pass uses the same values
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prevSimParamsRef = useRef<any>({});

  // E-7: cache key for the current knob settings — computed unconditionally
  // (not just while Optimal is active) so GameAnalyzer's equity mini-chart
  // can look up an already-built table without recomputing this itself.
  const currentCacheKey = useMemo(() => valueTableCacheKey({
    opponentModel: pinnedValues.opponentStrength ?? DIMENSIONS.opponentStrength.defaultValue,
    rhoB: DEFAULT_CONFIG.rhoB,
    rhoP: DEFAULT_CONFIG.rhoP,
    opponentDdStrategy: null, // no UI control yet — always the ddStrategy fallback
    ddWagerFraction: pinnedValues.ddAggression ?? DIMENSIONS.ddAggression.defaultValue,
    fjStrategy: 'standard',
    includeFJ,
    squareSelection: seekDD ? 'ddSeek' : 'default',
    opponentSquareSelection: opponentSeekDD ? 'ddSeek' : 'default',
  }), [pinnedValues.opponentStrength, pinnedValues.ddAggression, includeFJ, seekDD, opponentSeekDD]);

  const cachedValueTable = valueTableCache[currentCacheKey];

  // Memoized: config is a dependency of HeatMap's grid effect and several
  // callbacks — a fresh object every render would retrigger them all.
  const config = useMemo(() => {
    const cfg: SimConfig = { ...DEFAULT_CONFIG, includeFJ };
    if (clueStats?.ddRowWeights) cfg.ddRowWeights = clueStats.ddRowWeights;
    // P2 "DD seeking / square-selection strategy" (TODOS.md): shared App
    // state, applies to the Explorer grid, the All Games sweep, and the
    // Your Game estimate's V-table (all consume this one `config` object).
    cfg.squareSelection = seekDD ? 'ddSeek' : 'default';
    cfg.opponentSquareSelection = opponentSeekDD ? 'ddSeek' : 'default';

    if (ddStrategy === 'equity') {
      // Equity dispatch (sim-engine.ts) needs a valueTable; until one is
      // cached for the current knobs, equity DD falls back to 'aggressive'
      // inside the engine itself (documented, never a silent min-bet) — so
      // it's safe to set ddStrategy:'equity' here even before the build
      // finishes.
      cfg.ddStrategy = 'equity';
      if (cachedValueTable) cfg.valueTable = cachedValueTable;
    } else if (xAxis === 'ddAggression' || yAxis === 'ddAggression') {
      // Exploring "DD Aggression" as a swept axis: per-cell continuous
      // fraction (buildSimParams) already handles this; the base config's
      // own ddStrategy is a no-op fallback for callers that don't sweep it.
      cfg.ddStrategy = ddStrategy;
    } else if (ddStrategy === 'aggressive') {
      // Pre-E-7 regression-locked default: 'aggressive' still honors the
      // continuous "DD Aggression" pinned slider exactly as before.
      cfg.ddStrategy = 'aggressive';
      cfg.ddWagerFraction = pinnedValues.ddAggression ?? DIMENSIONS.ddAggression.defaultValue;
    } else {
      // Conservative / True DD: discrete heuristic, no continuous override.
      cfg.ddStrategy = ddStrategy;
    }
    return cfg;
  }, [includeFJ, xAxis, yAxis, pinnedValues, ddStrategy, cachedValueTable, clueStats, seekDD, opponentSeekDD]);

  // --- URL hash sync (write) ---
  useEffect(() => {
    const state: AppState = {
      x: position.x,
      y: position.y,
      xAxis,
      yAxis,
      pinned: pinnedValues,
      fj: includeFJ,
      theme,
      tab,
      refinedSpeed,
      seekDD,
      opponentSeekDD,
    };
    const hash = encodeState(state);
    // Use replaceState to avoid polluting browser history on every drag
    window.history.replaceState(null, '', `#${hash}`);
  }, [position, xAxis, yAxis, pinnedValues, includeFJ, theme, tab, refinedSpeed, seekDD, opponentSeekDD]);

  // --- Load games.json on mount ---
  useEffect(() => {
    fetch('/games.json')
      .then(r => r.json())
      .then((data: GameData[]) => setGames(data))
      .catch(err => console.warn('Failed to load games.json:', err));
  }, []);

  // --- E-6: load clue-stats.json (empirical DD row-placement priors) ---
  // 404/malformed → visible console.warn naming the fallback in use, then
  // proceed with sim-engine's hardcoded DD_ROW_WEIGHTS (never silent).
  useEffect(() => {
    fetch('/clue-stats.json')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: ClueStats) => {
        if (!data?.ddRowWeights?.J?.length || !data?.ddRowWeights?.DJ?.length) {
          throw new Error('malformed clue-stats.json (missing ddRowWeights.J/DJ)');
        }
        setClueStats(data);
      })
      .catch(err => {
        console.warn(
          'clue-stats.json unavailable or malformed — falling back to the hardcoded DD_ROW_WEIGHTS folklore prior (sim-engine.ts). DD heat strip will stay hidden.',
          err,
        );
      });
  }, []);

  // --- Compute dimension values from position ---
  const xDim = DIMENSIONS[xAxis];
  const yDim = DIMENSIONS[yAxis];
  const xVal = xDim.range[0] + (xDim.range[1] - xDim.range[0]) * position.x;
  const yVal = yDim.range[0] + (yDim.range[1] - yDim.range[0]) * position.y;

  // --- Initialize persistent worker and send games once ---
  useEffect(() => {
    if (!games || games.length === 0) return;

    const worker = new Worker(
      new URL('./sim/sim-worker.ts', import.meta.url),
      { type: 'module' },
    );
    gameWorkerRef.current = worker;

    // Send games data once via a dedicated message
    worker.postMessage({ type: 'loadGames', games });
    gamesLoadedInWorker.current = true;

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'simSingleGameDetailResult') {
        setSingleGameResults(msg.results);
      } else if (msg.type === 'simulateGameDetailResult') {
        setDdGameDetail({ gameIndex: msg.gameIndex, ddEvents: msg.ddEvents, you: msg.you });
      } else if (msg.type === 'simAllGamesProgress') {
        setGameSimProgress(msg.pct);
      } else if (msg.type === 'simAllGamesResult') {
        setGameWinRates(msg.results.map((r: { winRate: number }) => r.winRate));
        const pass = msg._simsPerGame;
        if (pass <= 2 && simPassRef.current === 'fast') {
          // Fast pass done — start refined pass in background
          simPassRef.current = 'refined';
          setGameSimProgress(0);
          worker.postMessage({
            type: 'simAllGames',
            xAxis: prevSimParamsRef.current.xAxis,
            yAxis: prevSimParamsRef.current.yAxis,
            xVal: prevSimParamsRef.current.xVal,
            yVal: prevSimParamsRef.current.yVal,
            pinnedValues: prevSimParamsRef.current.pinnedValues,
            config: prevSimParamsRef.current.config,
            // E-7 All Games recolor: 10 → 25 sims/game (measured timing in
            // the implementation report — per-square SE ~±16pp → ~±10pp).
            simsPerGame: 25,
          });
        } else {
          setGameSimProgress(null);
          gameSimStale.current = false;
          simPassRef.current = 'idle';
        }
      } else if (msg.type === 'buildValueTableProgress') {
        if (msg.cacheKey === equityBuildKeyRef.current && !equityBuildCancelledRef.current) {
          setEquityBuildProgress(msg.pct);
        }
      } else if (msg.type === 'buildValueTableResult') {
        // Stale or cancel-dropped result: a newer build superseded this one,
        // or the user cancelled — never apply/cache it (E-7 UI states:
        // "cancel reverts selection", not "cancel then silently apply anyway").
        if (equityBuildCancelledRef.current || msg.cacheKey !== equityBuildKeyRef.current) return;
        equityBuildingActiveRef.current = false;
        setValueTableCache(prev => ({ ...prev, [msg.cacheKey]: msg.table }));
        setEquityBuildStatus('ready');
        setEquityBuildProgress(1);
      } else if (msg.type === 'buildValueTableError') {
        if (equityBuildCancelledRef.current || msg.cacheKey !== equityBuildKeyRef.current) return;
        equityBuildingActiveRef.current = false;
        console.warn('V-table build failed — Optimal (equity) unavailable, falling back to Aggressive.', msg.message);
        setEquityBuildStatus('failed');
        setDdStrategy('aggressive');
      }
    };

    worker.onerror = (ev) => {
      // Crash defense for an in-flight V-table build (E-2/E-7's documented
      // rescue): revert to the preset fallback instead of silently wrong
      // numbers. Other in-flight ops (grid/all-games sims) already have
      // their own per-consumer error handling (HeatMap's own worker,
      // simAllGames* messages) — this only needs to cover the persistent
      // worker's buildValueTable path.
      if (equityBuildingActiveRef.current) {
        equityBuildingActiveRef.current = false;
        console.warn('Persistent worker crashed during V-table build — falling back to Aggressive.', ev);
        setEquityBuildStatus('failed');
        setDdStrategy('aggressive');
      }
    };

    return () => {
      worker.terminate();
      gameWorkerRef.current = null;
      gamesLoadedInWorker.current = false;
    };
  }, [games]);

  // --- E-7: build the V-table (persistent worker) when Optimal is selected ---
  useEffect(() => {
    if (ddStrategy !== 'equity') return;
    if (valueTableCache[currentCacheKey]) {
      setEquityBuildStatus('ready');
      return;
    }
    const worker = gameWorkerRef.current;
    if (!worker || !gamesLoadedInWorker.current) return; // retries once the persistent worker exists (effect re-fires on `games`)

    equityBuildCancelledRef.current = false;
    equityBuildingActiveRef.current = true;
    equityBuildKeyRef.current = currentCacheKey;
    setEquityBuildStatus('building');
    setEquityBuildProgress(0);

    const opponentProfile = interpolateOpponent(
      pinnedValues.opponentStrength ?? DIMENSIONS.opponentStrength.defaultValue,
    );
    worker.postMessage({
      type: 'buildValueTable',
      opponentProfile,
      config: {
        includeFJ,
        rhoB: DEFAULT_CONFIG.rhoB,
        rhoP: DEFAULT_CONFIG.rhoP,
        ddWagerFraction: pinnedValues.ddAggression ?? DIMENSIONS.ddAggression.defaultValue,
        fjStrategy: 'standard',
        // P2 "DD seeking / square-selection strategy" (TODOS.md): the Your
        // Game estimate's equity chart reads this V-table, so it must be
        // built under the same square-selection knobs as the Explorer grid
        // and All Games sweep.
        squareSelection: seekDD ? 'ddSeek' : 'default',
        opponentSquareSelection: opponentSeekDD ? 'ddSeek' : 'default',
      },
      seed: 0xf00d,
      cacheKey: currentCacheKey,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ddStrategy, currentCacheKey, games]);

  /** E-7: cancel affordance — drops the in-flight build's eventual result
   *  (still computes in the background worker, just never applied/cached —
   *  see the buildValueTableResult handler above) and reverts the
   *  selection, per the plan's UI-states table ("cancel reverts selection"). */
  const handleCancelEquityBuild = useCallback(() => {
    equityBuildCancelledRef.current = true;
    equityBuildingActiveRef.current = false;
    setEquityBuildStatus('idle');
    setEquityBuildProgress(0);
    setDdStrategy('aggressive');
  }, []);

  // --- Trigger all-games sim with debounce ---
  // Mark stale on any parameter change
  useEffect(() => {
    gameSimStale.current = true;
  }, [position.x, position.y, xAxis, yAxis, includeFJ, pinnedValues, ddStrategy, cachedValueTable]);

  // Only actually run the sim when on the games tab (or when switching to it)
  useEffect(() => {
    if (tab !== 'games') return;
    if (!gameWorkerRef.current || !gamesLoadedInWorker.current) return;

    // Debounce: wait 300ms after last change before starting sim
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const worker = gameWorkerRef.current;
      if (!worker) return;

      // Cancel any in-flight sim
      worker.postMessage({ type: 'cancel' });

      // Store params for the refined pass
      const simParams = { xAxis, yAxis, xVal, yVal, pinnedValues, config };
      prevSimParamsRef.current = simParams;
      simPassRef.current = 'fast';
      setGameSimProgress(0);

      // Fast pass: 2 sims/game for quick rough results
      worker.postMessage({
        type: 'simAllGames',
        ...simParams,
        simsPerGame: 2,
      });
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, position.x, position.y, xAxis, yAxis, includeFJ, pinnedValues, ddStrategy, cachedValueTable]);

  // --- Handlers ---

  // pinnedValues store REAL dimension values; position.x/y are [0,1]
  // fractions. For the legacy [0,1] dims the two coincide, but a dollars
  // dim (expectedCoryat, P-1) needs explicit conversion when a value moves
  // between "axis position" and "pinned value".
  const stashAxisValue = (axis: DimensionName, fraction: number) =>
    setPinnedValues(prev => ({ ...prev, [axis]: fractionToValue(DIMENSIONS[axis], fraction) }));
  const restoreAxisFraction = (axis: DimensionName) =>
    valueToFraction(DIMENSIONS[axis], pinnedValues[axis] ?? DIMENSIONS[axis].defaultValue);

  const handleAxisChange = useCallback((axis: 'x' | 'y', newDim: DimensionName) => {
    if (axis === 'x') {
      if (newDim === yAxis) {
        stashAxisValue(xAxis, position.x);
        setXAxis(newDim);
        setYAxis(xAxis);
        setPosition({ x: position.y, y: position.x });
      } else {
        stashAxisValue(xAxis, position.x);
        setPosition(prev => ({
          x: restoreAxisFraction(newDim),
          y: prev.y,
        }));
        setXAxis(newDim);
      }
    } else {
      if (newDim === xAxis) {
        stashAxisValue(yAxis, position.y);
        setYAxis(newDim);
        setXAxis(yAxis);
        setPosition({ x: position.y, y: position.x });
      } else {
        stashAxisValue(yAxis, position.y);
        setPosition(prev => ({
          x: prev.x,
          y: restoreAxisFraction(newDim),
        }));
        setYAxis(newDim);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xAxis, yAxis, position, pinnedValues]);

  // P-1: axis-preset pills. Selection is stored in the existing URL-hash
  // machinery implicitly — a preset is just an (xa, ya) pair, and both are
  // already encoded/decoded (encodeState/decodeState above), so preset
  // URLs are shareable with no new hash keys.
  const activePreset = findPresetForAxes(xAxis, yAxis);

  const handlePresetSelect = useCallback((preset: AxisPreset) => {
    if (preset.xAxis === xAxis && preset.yAxis === yAxis) return;
    // Stash current axis values (in real units) so they survive as pinned
    // dims, then restore the new axes' last-known values.
    setPinnedValues(prev => ({
      ...prev,
      [xAxis]: fractionToValue(DIMENSIONS[xAxis], position.x),
      [yAxis]: fractionToValue(DIMENSIONS[yAxis], position.y),
    }));
    setXAxis(preset.xAxis);
    setYAxis(preset.yAxis);
    setPosition({
      x: valueToFraction(DIMENSIONS[preset.xAxis], pinnedValues[preset.xAxis] ?? DIMENSIONS[preset.xAxis].defaultValue),
      y: valueToFraction(DIMENSIONS[preset.yAxis], pinnedValues[preset.yAxis] ?? DIMENSIONS[preset.yAxis].defaultValue),
    });
  }, [xAxis, yAxis, position, pinnedValues]);

  const handlePinnedChange = useCallback((name: string, value: number) => {
    setPinnedValues(prev => ({ ...prev, [name]: value }));
  }, []);

  const handleGameClick = useCallback((index: number) => {
    setSelectedGame(index);
    setSingleGameResults(null); // clear previous results
    setDdGameDetail(null); // clear previous DD events (TODOS item)

    // Run single-game detail sim
    const worker = gameWorkerRef.current;
    if (worker && gamesLoadedInWorker.current) {
      worker.postMessage({
        type: 'simSingleGameDetail',
        gameIndex: index,
        xAxis,
        yAxis,
        xVal,
        yVal,
        pinnedValues,
        config,
        numSims: 10,
      });
      // TODOS "P2 — GameDetail DD event rows": one seeded, history-tracked
      // sim for the DD events section — a distinct message from
      // simSingleGameDetail above (additive, doesn't touch its payload).
      worker.postMessage({
        type: 'simulateGameDetail',
        gameIndex: index,
        xAxis,
        yAxis,
        xVal,
        yVal,
        pinnedValues,
        config,
        seed: 0xD00D + index,
      });
    }
  }, [xAxis, yAxis, xVal, yVal, pinnedValues, config]);

  const handleGameEstimate = useCallback((estimate: GameEstimate) => {
    // Map the game entry onto whichever axes are active (P-1: each preset
    // candidate gets its own estimate source):
    //  - estimate.knowledge is correct/(correct+wrong+1) — literally
    //    precision (accuracy when buzzing), so it feeds 'precision' too.
    //  - estimate.buzzerSpeed is (correct+wrong)/60 — an attempt-rate
    //    proxy, so it feeds 'buzzAttemptRate' directly and 'buzzRaceWinPct'
    //    through the forward calibration curve.
    //  - estimate.coryat is the user's real Coryat, in dollars.
    const estimateMap: Record<string, number> = {
      knowledge: estimate.knowledge,
      buzzerSpeed: estimate.buzzerSpeed,
      precision: estimate.knowledge,
      buzzAttemptRate: estimate.buzzerSpeed,
      buzzRaceWinPct: buzzSpeedToWinPct(estimate.buzzerSpeed),
      expectedCoryat: estimate.coryat,
    };

    const normalize = (axis: DimensionName) => {
      const dim = DIMENSIONS[axis];
      const val = estimateMap[axis];
      if (val === undefined) return undefined;
      return valueToFraction(dim, val);
    };

    const newX = normalize(xAxis) ?? position.x;
    const newY = normalize(yAxis) ?? position.y;

    setPosition({
      x: Math.max(0, Math.min(1, newX)),
      y: Math.max(0, Math.min(1, newY)),
    });
    setTab('explorer');
    // P-3: land on the Explorer with a one-shot pulse + bridge link.
    setPulseToken(t => t + 1);
  }, [xAxis, yAxis, position]);

  return (
    <div className={`app ${theme}`}>
      <header className="app-header">
        <h1>Jeopardy Strategy Simulator</h1>
        <div className="tabs">
          <button
            className={`tab ${tab === 'games' ? 'tab-active' : ''}`}
            onClick={() => setTab('games')}
          >
            All Games {games ? `(${games.length.toLocaleString()})` : ''}
          </button>
          <button
            className={`tab ${tab === 'explorer' ? 'tab-active' : ''}`}
            onClick={() => setTab('explorer')}
          >
            Explorer
          </button>
          <button
            className={`tab ${tab === 'your-game' ? 'tab-active' : ''}`}
            onClick={() => setTab('your-game')}
          >
            Your Game
          </button>
        </div>
      </header>

      <main className="app-main">
        {tab === 'your-game' ? (
          <div className="your-game-container">
            <GameAnalyzer onEstimate={handleGameEstimate} sharedValueTable={cachedValueTable} />
            <div className="your-game-cta">
              <p>Or jump straight to exploring:</p>
              <button
                className="skip-link"
                onClick={() => setTab('explorer')}
              >
                Skip to Explorer
              </button>
            </div>
          </div>
        ) : tab === 'explorer' ? (
          <>
            <div className="viz-container">
              <div className="viz-stack">
                {/* P-1: axis-preset pills — three candidate framings for the
                    C1 bake-off. Selection lives in the URL hash via xa/ya. */}
                <div className="axis-pills" role="group" aria-label="Axis preset">
                  {AXIS_PRESETS.map(p => (
                    <button
                      key={p.id}
                      className={`pill ${activePreset?.id === p.id ? 'pill-active' : ''}`}
                      aria-pressed={activePreset?.id === p.id}
                      title={p.description}
                      onClick={() => handlePresetSelect(p)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {activePreset && (
                  <div className="axis-pills-caption">{activePreset.description}</div>
                )}
                {/* P-3: journey bridge — routes the GameAnalyzer payoff
                    onward to the All Games spine. */}
                {bridgeVisible && (
                  <button
                    className="bridge-link"
                    onClick={() => setTab('games')}
                  >
                    Next: see how you'd do in {games ? games.length.toLocaleString() : '8,600'} real games →
                  </button>
                )}
                <HeatMap
                  position={position}
                  onPositionChange={setPosition}
                  xAxis={xAxis}
                  yAxis={yAxis}
                  onAxisChange={handleAxisChange}
                  pinnedValues={pinnedValues}
                  config={config}
                  onWinRateUpdate={setWinRate}
                  pulseToken={pulseToken}
                  equityBuildStatus={ddStrategy === 'equity' ? equityBuildStatus : 'idle'}
                  equityBuildProgress={equityBuildProgress}
                  refinedGamesPerCell={REFINED_GAMES_PER_CELL[refinedSpeed]}
                  showDDImpact={showDDImpact}
                />
              </div>
            </div>
            <div className="side-panel">
              {/* P3 mobile Explorer layout (TODOS.md): grouped into native
                  <details>/<summary> sections so they're collapsible on
                  phones with no JS. Both stay `open` — on wider screens the
                  <summary> is hidden (App.css) so this renders exactly like
                  the flat list of panels it replaces. */}
              <details className="side-section" open>
                <summary>Stats &amp; Marginal Returns</summary>
                <StatsPanel
                  position={position}
                  winRate={winRate}
                  xAxis={xAxis}
                  yAxis={yAxis}
                />
                <div style={{ padding: '12px 16px' }}>
                  <MarginalReturns
                    xAxis={xAxis}
                    yAxis={yAxis}
                    position={position}
                    pinnedValues={pinnedValues}
                    config={config}
                  />
                </div>
                {/* E-7 DD heat strip: independent of V — driven entirely by
                    clue-stats.json; hidden entirely when unavailable. */}
                <DDHeatStrip clueStats={clueStats} />
              </details>
              <details className="side-section" open>
                <summary>Controls</summary>
                <ControlsPanel
                  xAxis={xAxis}
                  yAxis={yAxis}
                  pinnedValues={pinnedValues}
                  onPinnedChange={handlePinnedChange}
                  includeFJ={includeFJ}
                  onFJChange={setIncludeFJ}
                  theme={theme}
                  onThemeChange={setTheme}
                  ddStrategy={ddStrategy}
                  onDdStrategyChange={setDdStrategy}
                  equityBuildStatus={equityBuildStatus}
                  equityBuildProgress={equityBuildProgress}
                  onCancelEquityBuild={handleCancelEquityBuild}
                  refinedSpeed={refinedSpeed}
                  onRefinedSpeedChange={setRefinedSpeed}
                  showDDImpact={showDDImpact}
                  onShowDDImpactChange={setShowDDImpact}
                  seekDD={seekDD}
                  onSeekDDChange={setSeekDD}
                  opponentSeekDD={opponentSeekDD}
                  onOpponentSeekDDChange={setOpponentSeekDD}
                />
              </details>
            </div>
          </>
        ) : (
          <div className="games-container">
            {!games ? (
              <div className="games-loading">Loading game data...</div>
            ) : (
              <>
                {/* P-4: payoff first, knobs second — YourNumber (the
                    headline + histogram) renders ABOVE the controls.
                    Pure reorder; the graph below is untouched. */}
                {gameWinRates && (
                  <YourNumber
                    winRates={gameWinRates}
                    isSimulating={gameSimProgress !== null}
                  />
                )}
                <GamesControls
                  position={position}
                  onPositionChange={setPosition}
                  xAxis={xAxis}
                  yAxis={yAxis}
                  pinnedValues={pinnedValues}
                  onPinnedChange={handlePinnedChange}
                  includeFJ={includeFJ}
                  onFJChange={setIncludeFJ}
                  ddStrategy={ddStrategy}
                  equityActive={ddStrategy === 'equity'}
                  seekDD={seekDD}
                  onSeekDDChange={setSeekDD}
                  opponentSeekDD={opponentSeekDD}
                  onOpponentSeekDDChange={setOpponentSeekDD}
                />
                <div className="games-header">
                  <p className="games-subtitle">
                    Every regular-season game, colored by your simulated win rate.
                    {gameSimProgress !== null && (
                      <span className="sim-status"> Simulating... {Math.round(gameSimProgress * 100)}%</span>
                    )}
                  </p>
                  <div className="games-legend">
                    <span className="legend-label">Win rate:</span>
                    {[
                      { cssVar: '--cg-1', fallback: '#060a30', label: '<15%' },
                      { cssVar: '--cg-2', fallback: '#0a1566', label: '15-25%' },
                      { cssVar: '--cg-3', fallback: '#1a3ba8', label: '25-40%' },
                      { cssVar: '--cg-4', fallback: '#c5a028', label: '40-55%' },
                      { cssVar: '--cg-5', fallback: '#f5d442', label: '>55%' },
                    ].map(({ cssVar, fallback, label }) => (
                      <span key={label} className="legend-item">
                        <span className="legend-swatch" style={{ background: `var(${cssVar}, ${fallback})` }} />
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="games-body">
                  <ContributionGraph
                    games={games}
                    winRates={gameWinRates}
                    progress={gameSimProgress}
                    onGameClick={handleGameClick}
                  />
                  {selectedGame !== null && games[selectedGame] && (
                    <div className="game-detail-container">
                      <GameDetail
                        game={games[selectedGame]}
                        index={selectedGame}
                        winRate={gameWinRates?.[selectedGame]}
                        onClose={() => setSelectedGame(null)}
                        simResults={singleGameResults}
                        ddDetail={ddGameDetail}
                        valueTable={cachedValueTable}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
