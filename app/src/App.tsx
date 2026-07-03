import { useState, useCallback, useEffect, useRef } from 'react';
import { HeatMap } from './components/HeatMap';
import { ControlsPanel } from './components/ControlsPanel';
import { StatsPanel } from './components/StatsPanel';
import { ContributionGraph, type GameData } from './components/ContributionGraph';
import { GameDetail, type SimRun } from './components/GameDetail';
import { GamesControls } from './components/GamesControls';
import { YourNumber } from './components/YourNumber';
import { MarginalReturns } from './components/MarginalReturns';
import { GameAnalyzer, type GameEstimate } from './components/GameAnalyzer';
import { DEFAULT_CONFIG } from './sim/sim-engine';
import { DIMENSIONS, type DimensionName } from './sim/dimensions';
import './App.css';

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
  const [tab, setTab] = useState<AppState['tab']>(initial?.tab ?? 'your-game');

  // Games data
  const [games, setGames] = useState<GameData[] | null>(null);
  const [gameWinRates, setGameWinRates] = useState<number[] | null>(null);
  const [gameSimProgress, setGameSimProgress] = useState<number | null>(null);
  const [selectedGame, setSelectedGame] = useState<number | null>(null);
  const [singleGameResults, setSingleGameResults] = useState<SimRun[] | null>(null);

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

  const config = {
    ...DEFAULT_CONFIG,
    includeFJ,
    ...(xAxis !== 'ddAggression' && yAxis !== 'ddAggression'
      ? { ddWagerFraction: pinnedValues.ddAggression ?? DIMENSIONS.ddAggression.defaultValue, ddStrategy: 'aggressive' as const }
      : {}),
  };

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
    };
    const hash = encodeState(state);
    // Use replaceState to avoid polluting browser history on every drag
    window.history.replaceState(null, '', `#${hash}`);
  }, [position, xAxis, yAxis, pinnedValues, includeFJ, theme, tab]);

  // --- Load games.json on mount ---
  useEffect(() => {
    fetch('/games.json')
      .then(r => r.json())
      .then((data: GameData[]) => setGames(data))
      .catch(err => console.warn('Failed to load games.json:', err));
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
            simsPerGame: 10,
          });
        } else {
          setGameSimProgress(null);
          gameSimStale.current = false;
          simPassRef.current = 'idle';
        }
      }
    };

    return () => {
      worker.terminate();
      gameWorkerRef.current = null;
      gamesLoadedInWorker.current = false;
    };
  }, [games]);

  // --- Trigger all-games sim with debounce ---
  // Mark stale on any parameter change
  useEffect(() => {
    gameSimStale.current = true;
  }, [position.x, position.y, xAxis, yAxis, includeFJ, pinnedValues]);

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
  }, [tab, position.x, position.y, xAxis, yAxis, includeFJ, pinnedValues]);

  // --- Handlers ---

  const handleAxisChange = useCallback((axis: 'x' | 'y', newDim: DimensionName) => {
    if (axis === 'x') {
      if (newDim === yAxis) {
        setPinnedValues(prev => ({ ...prev, [xAxis]: position.x }));
        setXAxis(newDim);
        setYAxis(xAxis);
        setPosition({ x: position.y, y: position.x });
      } else {
        setPinnedValues(prev => ({ ...prev, [xAxis]: position.x }));
        setPosition(prev => ({
          x: pinnedValues[newDim] ?? DIMENSIONS[newDim].defaultValue,
          y: prev.y,
        }));
        setXAxis(newDim);
      }
    } else {
      if (newDim === xAxis) {
        setPinnedValues(prev => ({ ...prev, [yAxis]: position.y }));
        setYAxis(newDim);
        setXAxis(yAxis);
        setPosition({ x: position.y, y: position.x });
      } else {
        setPinnedValues(prev => ({ ...prev, [yAxis]: position.y }));
        setPosition(prev => ({
          x: prev.x,
          y: pinnedValues[newDim] ?? DIMENSIONS[newDim].defaultValue,
        }));
        setYAxis(newDim);
      }
    }
  }, [xAxis, yAxis, position, pinnedValues]);

  const handlePinnedChange = useCallback((name: string, value: number) => {
    setPinnedValues(prev => ({ ...prev, [name]: value }));
  }, []);

  const handleGameClick = useCallback((index: number) => {
    setSelectedGame(index);
    setSingleGameResults(null); // clear previous results

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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xAxis, yAxis, xVal, yVal, pinnedValues, config]);

  const handleGameEstimate = useCallback((estimate: GameEstimate) => {
    const estimateMap: Record<string, number> = {
      knowledge: estimate.knowledge,
      buzzerSpeed: estimate.buzzerSpeed,
    };

    const normalize = (axis: DimensionName) => {
      const dim = DIMENSIONS[axis];
      const val = estimateMap[axis];
      if (val === undefined) return undefined;
      return (val - dim.range[0]) / (dim.range[1] - dim.range[0]);
    };

    const newX = normalize(xAxis) ?? position.x;
    const newY = normalize(yAxis) ?? position.y;

    setPosition({
      x: Math.max(0, Math.min(1, newX)),
      y: Math.max(0, Math.min(1, newY)),
    });
    setTab('explorer');
  }, [xAxis, yAxis, position]);

  return (
    <div className={`app ${theme}`}>
      <header className="app-header">
        <h1>Jeopardy Strategy Simulator</h1>
        <div className="tabs">
          <button
            className={`tab ${tab === 'your-game' ? 'tab-active' : ''}`}
            onClick={() => setTab('your-game')}
          >
            Your Game
          </button>
          <button
            className={`tab ${tab === 'explorer' ? 'tab-active' : ''}`}
            onClick={() => setTab('explorer')}
          >
            Explorer
          </button>
          <button
            className={`tab ${tab === 'games' ? 'tab-active' : ''}`}
            onClick={() => setTab('games')}
          >
            All Games {games ? `(${games.length.toLocaleString()})` : ''}
          </button>
        </div>
      </header>

      <main className="app-main">
        {tab === 'your-game' ? (
          <div className="your-game-container">
            <GameAnalyzer onEstimate={handleGameEstimate} />
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
              <HeatMap
                position={position}
                onPositionChange={setPosition}
                xAxis={xAxis}
                yAxis={yAxis}
                onAxisChange={handleAxisChange}
                pinnedValues={pinnedValues}
                config={config}
                onWinRateUpdate={setWinRate}
              />
            </div>
            <div className="side-panel">
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
              <ControlsPanel
                xAxis={xAxis}
                yAxis={yAxis}
                pinnedValues={pinnedValues}
                onPinnedChange={handlePinnedChange}
                includeFJ={includeFJ}
                onFJChange={setIncludeFJ}
                theme={theme}
                onThemeChange={setTheme}
              />
            </div>
          </>
        ) : (
          <div className="games-container">
            {!games ? (
              <div className="games-loading">Loading game data...</div>
            ) : (
              <>
                <GamesControls
                  position={position}
                  onPositionChange={setPosition}
                  xAxis={xAxis}
                  yAxis={yAxis}
                  pinnedValues={pinnedValues}
                  onPinnedChange={handlePinnedChange}
                  includeFJ={includeFJ}
                  onFJChange={setIncludeFJ}
                />
                {gameWinRates && (
                  <YourNumber
                    winRates={gameWinRates}
                    isSimulating={gameSimProgress !== null}
                  />
                )}
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
