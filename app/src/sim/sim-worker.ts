/**
 * Web Worker for background Monte Carlo simulation.
 *
 * Messages:
 *   IN:  { type: 'computeGrid', xAxis, yAxis, pinnedValues, config, resolution, gamesPerCell }
 *   OUT: { type: 'progress', pct }
 *   OUT: { type: 'gridResult', grid }
 *
 *   IN:  { type: 'computeWinRate', knowledge, buzzerSpeed, opponentProfile, config, nGames }
 *        OR { type: 'computeWinRate', xAxis, yAxis, xVal, yVal, pinnedValues, config, nGames }
 *   OUT: { type: 'winRateResult', winRate, knowledge, buzzerSpeed }
 *
 *   IN:  { type: 'loadGames', games }          // Send games data once; worker stores it
 *   IN:  { type: 'simAllGames', xAxis, yAxis, xVal, yVal, pinnedValues, config, simsPerGame }
 *   OUT: { type: 'simAllGamesProgress', pct }
 *   OUT: { type: 'simAllGamesResult', results: { winRate: number }[] }
 *
 *   IN:  { type: 'cancel' }
 *   OUT: { type: 'error', message }
 *
 *   IN:  { type: 'buildValueTable', opponentProfile, config, seed, cacheKey }
 *   OUT: { type: 'buildValueTableProgress', pct, cacheKey }
 *   OUT: { type: 'buildValueTableResult', table, cacheKey }  (table.data is a
 *        transferred Float32Array — see the persistent-worker postMessage call)
 *   OUT: { type: 'buildValueTableError', message, cacheKey }
 *
 *   IN:  { type: 'simulateGameDetail', gameIndex, xAxis, yAxis, xVal, yVal,
 *          pinnedValues, config, seed }
 *        Runs ONE seeded simulateGame with trackHistory:true (TODOS
 *        "P2 — GameDetail DD event rows") — additive, does not touch
 *        simSingleGameDetail's existing unseeded numSims path above.
 *   OUT: { type: 'simulateGameDetailResult', gameIndex, ddEvents, scores,
 *          winner, you: { knowledge, buzzerSpeed } }
 *
 *   IN:  { type: 'computeDDImpactGrid', xAxis, yAxis, pinnedValues, config,
 *        resolution, gamesPerCell, seed? }
 *   OUT: { type: 'ddImpactProgress', pct }
 *   OUT: { type: 'ddImpactGridResult', grid }  (DDImpactCell[]: per-cell
 *        winRate(current DD strategy) - winRate(DD strategy 'off'), both
 *        run with the SAME seed/gamesPerCell so the difference isolates
 *        the DD-strategy effect rather than independent Monte Carlo noise)
 *
 *   IN:  { type: 'computeGamesDelta', xAxis, yAxis, xVal, yVal, pinnedValues,
 *          config, simsPerGame, valueTable?, seed?, requestId? }
 *        All Games "Gain from optimal play" colour mode (TODOS "P2 — All
 *        Games optimal-vs-actual delta coloring"). Same per-game loop and
 *        simsPerGame as simAllGames, run twice per game with IDENTICAL
 *        seeds: once with the current settings, once with optimal strategy
 *        (ddStrategy 'equity' + squareSelection 'ddSeek', everything else
 *        as set). Never sent in the default colour mode.
 *   OUT: { type: 'gamesDeltaProgress', pct, requestId }
 *   OUT: { type: 'gamesDeltaResult', results: { current, optimal }[],
 *          _simsPerGame, requestId }
 */

import {
  playerFrom2Axis,
  calculateWinRate,
  simulateGame,
  sampleOpponent,
  mulberry32,
  type SimConfig,
  type DDStrategy,
  DEFAULT_CONFIG,
} from './sim-engine';
import { buildValueTable, type ValueTable } from './value-function';
import { DIMENSIONS, buildSimParams, type DimensionName } from './dimensions';
import { calibrateOpponent } from './calibrate';

export interface GridCell {
  /** Normalized X-axis value [0,1] */
  x: number;
  /** Normalized Y-axis value [0,1] */
  y: number;
  winRate: number;
  // Legacy fields for backwards compat with HeatMap rendering
  knowledge: number;
  buzzerSpeed: number;
}

/** P2 "DD impact difference map overlay" (TODOS.md) — one cell of the
 *  computeDDImpactGrid result. */
export interface DDImpactCell {
  /** Normalized X-axis value [0,1] */
  x: number;
  /** Normalized Y-axis value [0,1] */
  y: number;
  /** winRate(current DD strategy) - winRate(DD strategy 'off'), same seed
   *  and gamesPerCell for both runs. */
  diff: number;
}

/** Default seed for computeDDImpactGrid when the caller doesn't pass one —
 *  keeps the overlay reproducible across repeat toggles at the same knobs. */
const DEFAULT_DD_IMPACT_SEED = 0xD1F5eed;

/** Default seed for computeGamesDelta — the delta sweep is reproducible
 *  across repeat mode switches at the same knobs. */
const DEFAULT_GAMES_DELTA_SEED = 0x6A1AED;

/** One game's two paired arms from `buildGamesDelta`. The gain shown on the
 *  All Games graph is `optimal - current`; the headline uses both means. */
export interface GameDeltaResult {
  /** Win rate with the settings as currently set. */
  current: number;
  /** Win rate with optimal strategy: ddStrategy 'equity' (+ V-table) and
   *  squareSelection 'ddSeek', everything else as set. */
  optimal: number;
}

let cancelled = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storedGames: any[] | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (msg.type === 'loadGames') {
    storedGames = msg.games;
    return;
  }

  if (msg.type === 'buildValueTable') {
    // E-7: built in the PERSISTENT worker (App.tsx's gameWorkerRef posts this
    // message) — never HeatMap's own worker — so the table is built exactly
    // once and handed to every consumer (see PLAN.md E-2 "where the table
    // lives"). Not gated by `cancelled`/the shared cancel flag below: a
    // table build is a distinct, longer-running operation from grid/
    // all-games sims and App.tsx handles its own cancel semantics (dropping
    // a late result) rather than interrupting this synchronous call.
    const { opponentProfile, config, seed, cacheKey } = msg;
    try {
      const rng = mulberry32(seed ?? 0xF00D);
      const table = buildValueTable(opponentProfile, config ?? DEFAULT_CONFIG, rng, {
        onProgress: (pct) => self.postMessage({ type: 'buildValueTableProgress', pct, cacheKey }),
      });
      // Transfer the Float32Array payload — no copy, per E-2's spec.
      // Cast: this tsconfig's `lib` is DOM (Window.postMessage), not
      // webworker (DedicatedWorkerGlobalScope.postMessage) — `self` here
      // is actually the latter at runtime (it's the transferable-list
      // overload real workers support), so the transfer-list argument
      // needs a local type assertion rather than a project-wide lib change.
      (self.postMessage as unknown as (message: unknown, transfer: Transferable[]) => void)(
        { type: 'buildValueTableResult', table, cacheKey },
        [table.data.buffer],
      );
    } catch (err) {
      self.postMessage({ type: 'buildValueTableError', message: String(err), cacheKey });
    }
    return;
  }

  cancelled = false;

  if (msg.type === 'computeGrid') {
    const {
      resolution,
      gamesPerCell = 200,
      xAxis = 'knowledge',
      yAxis = 'buzzerSpeed',
      pinnedValues = {},
    } = msg;
    const config = msg.config ?? DEFAULT_CONFIG;

    // Validate dimension names
    if (!DIMENSIONS[xAxis as DimensionName]) {
      self.postMessage({ type: 'error', message: `Unknown dimension: ${xAxis}` });
      return;
    }
    if (!DIMENSIONS[yAxis as DimensionName]) {
      self.postMessage({ type: 'error', message: `Unknown dimension: ${yAxis}` });
      return;
    }

    const xDim = DIMENSIONS[xAxis as DimensionName];
    const yDim = DIMENSIONS[yAxis as DimensionName];

    const grid: GridCell[] = [];
    const totalCells = (resolution + 1) * (resolution + 1);
    let computed = 0;

    for (let xi = 0; xi <= resolution; xi++) {
      for (let yi = 0; yi <= resolution; yi++) {
        if (cancelled) return;

        // Map grid indices to dimension values within their ranges
        const xNorm = xi / resolution;
        const yNorm = yi / resolution;
        const xVal = xDim.range[0] + (xDim.range[1] - xDim.range[0]) * xNorm;
        const yVal = yDim.range[0] + (yDim.range[1] - yDim.range[0]) * yNorm;

        const { player, config: cellConfig, opponentProfile } = buildSimParams(
          xAxis as DimensionName,
          yAxis as DimensionName,
          xVal,
          yVal,
          { ...pinnedValues, ...configToPinned(config) },
        );

        // Merge the base config with per-cell overrides
        const mergedConfig = resolveDDStrategy(config, cellConfig, xAxis, yAxis);
        const { winRate } = calculateWinRate(player, opponentProfile, mergedConfig, gamesPerCell);

        grid.push({
          x: xNorm,
          y: yNorm,
          winRate,
          // Legacy compat
          knowledge: xNorm,
          buzzerSpeed: yNorm,
        });
        computed++;

        if (computed % Math.max(1, Math.floor(totalCells / 20)) === 0) {
          self.postMessage({ type: 'progress', pct: computed / totalCells });
        }
      }
    }

    self.postMessage({ type: 'gridResult', grid });
  }

  if (msg.type === 'computeDDImpactGrid') {
    const {
      resolution,
      gamesPerCell = 200,
      xAxis = 'knowledge',
      yAxis = 'buzzerSpeed',
      pinnedValues = {},
      seed = DEFAULT_DD_IMPACT_SEED,
    } = msg;
    const config = msg.config ?? DEFAULT_CONFIG;

    if (!DIMENSIONS[xAxis as DimensionName]) {
      self.postMessage({ type: 'error', message: `Unknown dimension: ${xAxis}` });
      return;
    }
    if (!DIMENSIONS[yAxis as DimensionName]) {
      self.postMessage({ type: 'error', message: `Unknown dimension: ${yAxis}` });
      return;
    }

    const diffGrid = buildDDImpactGrid(
      xAxis as DimensionName,
      yAxis as DimensionName,
      pinnedValues,
      config,
      resolution,
      gamesPerCell,
      seed,
      {
        onProgress: (pct) => self.postMessage({ type: 'ddImpactProgress', pct }),
        isCancelled: () => cancelled,
      },
    );
    if (diffGrid === null) return; // cancelled mid-computation — mirrors computeGrid's abort-silently semantics

    self.postMessage({ type: 'ddImpactGridResult', grid: diffGrid });
  }

  if (msg.type === 'simAllGames') {
    const {
      xAxis = 'knowledge',
      yAxis = 'buzzerSpeed',
      xVal,
      yVal,
      pinnedValues = {},
      simsPerGame = 1,
    } = msg;
    // Use inline games if provided, else fall back to stored games
    const games = msg.games ?? storedGames;
    if (!games || games.length === 0) {
      self.postMessage({ type: 'error', message: 'No games loaded' });
      return;
    }
    const config = msg.config ?? DEFAULT_CONFIG;

    const { player, config: cellConfig } = buildSimParams(
      xAxis as DimensionName,
      yAxis as DimensionName,
      xVal,
      yVal,
      { ...pinnedValues, ...configToPinned(config) },
    );
    const mergedConfig: SimConfig = resolveDDStrategy(config, cellConfig, xAxis, yAxis);

    const results: { winRate: number }[] = [];
    const totalGames = games.length;
    const progressInterval = Math.max(1, Math.floor(totalGames / 50));

    for (let gi = 0; gi < totalGames; gi++) {
      if (cancelled) return;

      const game = games[gi];
      let wins = 0;

      for (let s = 0; s < simsPerGame; s++) {
        // Create opponents using Coryat-calibrated strength
        // Coryat captures knowledge × clue difficulty interaction
        // Use it to calibrate overall b×p product, then split via precision ratio
        const opp1 = sampleOpponent(calibrateOpponent(game.o[0]));
        const opp2 = sampleOpponent(calibrateOpponent(game.o[1]));

        const result = simulateGame(player, opp1, opp2, mergedConfig);
        if (result.winner === 0) wins++;
      }

      results.push({ winRate: wins / simsPerGame });

      if (gi % progressInterval === 0) {
        self.postMessage({ type: 'simAllGamesProgress', pct: gi / totalGames });
      }
    }

    self.postMessage({ type: 'simAllGamesResult', results, _simsPerGame: simsPerGame });
  }

  if (msg.type === 'computeGamesDelta') {
    const {
      xAxis = 'knowledge',
      yAxis = 'buzzerSpeed',
      xVal,
      yVal,
      pinnedValues = {},
      simsPerGame = 1,
      seed = DEFAULT_GAMES_DELTA_SEED,
      requestId,
    } = msg;
    const games = msg.games ?? storedGames;
    if (!games || games.length === 0) {
      self.postMessage({ type: 'error', message: 'No games loaded' });
      return;
    }
    const config = msg.config ?? DEFAULT_CONFIG;

    const results = buildGamesDelta(
      games,
      xAxis as DimensionName,
      yAxis as DimensionName,
      xVal,
      yVal,
      pinnedValues,
      config,
      simsPerGame,
      msg.valueTable,
      seed,
      {
        onProgress: (pct) => self.postMessage({ type: 'gamesDeltaProgress', pct, requestId }),
        isCancelled: () => cancelled,
      },
    );
    if (results === null) return; // cancelled mid-computation — mirrors simAllGames' abort-silently semantics

    self.postMessage({ type: 'gamesDeltaResult', results, _simsPerGame: simsPerGame, requestId });
  }

  if (msg.type === 'computeWinRate') {
    const { nGames = 1000 } = msg;
    const config = msg.config ?? DEFAULT_CONFIG;

    // Support both legacy (knowledge/buzzerSpeed/opponentProfile) and new (xAxis/yAxis/xVal/yVal) formats
    if (msg.xAxis && msg.yAxis) {
      const { xAxis, yAxis, xVal, yVal, pinnedValues = {} } = msg;
      const { player, config: cellConfig, opponentProfile } = buildSimParams(
        xAxis as DimensionName,
        yAxis as DimensionName,
        xVal,
        yVal,
        { ...pinnedValues, ...configToPinned(config) },
      );
      const mergedConfig = resolveDDStrategy(config, cellConfig, xAxis, yAxis);
      const { winRate } = calculateWinRate(player, opponentProfile, mergedConfig, nGames);
      self.postMessage({ type: 'winRateResult', winRate, xVal, yVal });
    } else {
      // Legacy format
      const { knowledge, buzzerSpeed, opponentProfile } = msg;
      const player = playerFrom2Axis(knowledge, buzzerSpeed);
      const { winRate } = calculateWinRate(player, opponentProfile, config, nGames);
      self.postMessage({ type: 'winRateResult', winRate, knowledge, buzzerSpeed });
    }
  }

  if (msg.type === 'simSingleGameDetail') {
    const {
      gameIndex,
      xAxis = 'knowledge',
      yAxis = 'buzzerSpeed',
      xVal,
      yVal,
      pinnedValues = {},
      numSims = 10,
    } = msg;
    const games = storedGames;
    if (!games || !games[gameIndex]) {
      self.postMessage({ type: 'error', message: 'Game not found' });
      return;
    }
    const config = msg.config ?? DEFAULT_CONFIG;

    const { player, config: cellConfig } = buildSimParams(
      xAxis as DimensionName,
      yAxis as DimensionName,
      xVal,
      yVal,
      { ...pinnedValues, ...configToPinned(config) },
    );
    const mergedConfig: SimConfig = resolveDDStrategy(config, cellConfig, xAxis, yAxis);

    const game = games[gameIndex];
    const results: { scores: [number, number, number]; winner: number; history?: [number, number, number][] }[] = [];

    for (let s = 0; s < numSims; s++) {
      const opp1 = sampleOpponent(calibrateOpponent(game.o[0]));
      const opp2 = sampleOpponent(calibrateOpponent(game.o[1]));
      const result = simulateGame(player, opp1, opp2, mergedConfig, true);
      results.push({ scores: result.scores, winner: result.winner, history: result.history });
    }

    self.postMessage({ type: 'simSingleGameDetailResult', gameIndex, results });
  }

  if (msg.type === 'simulateGameDetail') {
    // TODOS "P2 — GameDetail DD event rows": ONE seeded, history-tracked
    // simulation of a historical game, so the DD events (and their
    // equity-recomputation fields — see DDEvent in sim-engine.ts) are
    // reproducible across re-clicks of the same game. Additive-only: does
    // not alter simSingleGameDetail above.
    const {
      gameIndex,
      xAxis = 'knowledge',
      yAxis = 'buzzerSpeed',
      xVal,
      yVal,
      pinnedValues = {},
      seed = 0xD00D,
    } = msg;
    const games = storedGames;
    if (!games || !games[gameIndex]) {
      self.postMessage({ type: 'error', message: 'Game not found' });
      return;
    }
    const config = msg.config ?? DEFAULT_CONFIG;

    const { player, config: cellConfig } = buildSimParams(
      xAxis as DimensionName,
      yAxis as DimensionName,
      xVal,
      yVal,
      { ...pinnedValues, ...configToPinned(config) },
    );
    const mergedConfig: SimConfig = resolveDDStrategy(config, cellConfig, xAxis, yAxis);

    const game = games[gameIndex];
    const rng = mulberry32(seed);
    const opp1 = sampleOpponent(calibrateOpponent(game.o[0]), rng);
    const opp2 = sampleOpponent(calibrateOpponent(game.o[1]), rng);
    const result = simulateGame(player, opp1, opp2, mergedConfig, true, rng);

    self.postMessage({
      type: 'simulateGameDetailResult',
      gameIndex,
      ddEvents: result.ddEvents ?? [],
      scores: result.scores,
      winner: result.winner,
      you: { knowledge: player.b * player.p, buzzerSpeed: player.buzzerSpeed },
    });
  }
};

/** Extract pinned-compatible values from SimConfig for dimensions that use config fields */
function configToPinned(config: SimConfig): Record<string, number> {
  const pinned: Record<string, number> = {};
  if (config.ddWagerFraction !== undefined) {
    pinned.ddAggression = config.ddWagerFraction;
  }
  return pinned;
}

/**
 * E-7: reconcile the App-level DD Strategy selector with buildSimParams's
 * per-cell output.
 *
 * `dimensions.ts`'s `ddAggression` dimension is *always* one of the active
 * pinned dims for every axis preset (unless it's literally one of the two
 * swept axes) and its `toParams` unconditionally returns
 * `{ ddWagerFraction, ddStrategy: 'aggressive' }` — that's `cellConfig`
 * below. A naive `{ ...config, ...cellConfig }` merge (the pre-E-7 code)
 * would silently let that per-cell default stomp any *other* DD Strategy
 * selection (`'conservative'`, `'truedd'`, or `'equity'`) the user made in
 * ControlsPanel's new segmented control — since `cellConfig` is spread
 * last, it always wins.
 *
 * Resolution: the DD Strategy selector is a whole-app choice, not a
 * per-cell sweep, so it should win over the ddAggression pinned-dim
 * default — UNLESS the user is explicitly exploring "DD Aggression" as one
 * of the two swept axes, in which case the continuous per-cell fraction
 * *is* the intended behavior and must be left alone (this is the existing,
 * pre-E-7 axis-exploration use case). `'aggressive'` itself needs no
 * special-casing: it's `cellConfig`'s own default, so the naive merge
 * already produces the right answer and this function is a no-op for it —
 * this is also why the regression-locked default (App.tsx's pre-E-7
 * hardcoded `ddStrategy: 'aggressive'`) is untouched.
 */
function resolveDDStrategy(
  config: SimConfig,
  cellConfig: SimConfig,
  xAxis: string,
  yAxis: string,
): SimConfig {
  const merged: SimConfig = { ...config, ...cellConfig };
  const exploringDDAggressionAxis = xAxis === 'ddAggression' || yAxis === 'ddAggression';
  const selector = config.ddStrategy as DDStrategy | undefined;
  if (!exploringDDAggressionAxis && selector && selector !== 'aggressive') {
    merged.ddStrategy = selector;
    merged.ddWagerFraction = undefined;
    merged.valueTable = selector === 'equity' ? config.valueTable : undefined;
  }
  return merged;
}

/**
 * P2 "DD impact difference map overlay" (TODOS.md) — pure grid-diff
 * builder, exported for direct unit testing (no `self`/postMessage
 * dependency; the `computeDDImpactGrid` message handler above is a thin
 * wrapper that also reports progress/cancellation).
 *
 * For each cell, runs the CURRENT DD strategy (resolved exactly like
 * computeGrid's own cells) and the same cell with DD strategy forced 'off',
 * seeded IDENTICALLY per cell — same opponent samples, clue draws, and buzz
 * races — so `diff` isolates the DD-strategy effect rather than
 * independent Monte Carlo noise between two unrelated runs. When the
 * current strategy already IS 'off', `currentConfig` and `offConfig` are
 * the same simulation run twice with the same seed, so diff is exactly 0.
 *
 * Returns `null` if `hooks.isCancelled()` becomes true mid-computation
 * (caller should drop the partial result, mirroring computeGrid's
 * abort-silently semantics).
 */
export function buildDDImpactGrid(
  xAxis: DimensionName,
  yAxis: DimensionName,
  pinnedValues: Record<string, number>,
  config: SimConfig,
  resolution: number,
  gamesPerCell: number,
  seed: number = DEFAULT_DD_IMPACT_SEED,
  hooks: { onProgress?: (pct: number) => void; isCancelled?: () => boolean } = {},
): DDImpactCell[] | null {
  const xDim = DIMENSIONS[xAxis];
  const yDim = DIMENSIONS[yAxis];

  const diffGrid: DDImpactCell[] = [];
  const totalCells = (resolution + 1) * (resolution + 1);
  let computed = 0;

  for (let xi = 0; xi <= resolution; xi++) {
    for (let yi = 0; yi <= resolution; yi++) {
      if (hooks.isCancelled?.()) return null;

      const xNorm = xi / resolution;
      const yNorm = yi / resolution;
      const xVal = xDim.range[0] + (xDim.range[1] - xDim.range[0]) * xNorm;
      const yVal = yDim.range[0] + (yDim.range[1] - yDim.range[0]) * yNorm;

      const { player, config: cellConfig, opponentProfile } = buildSimParams(
        xAxis,
        yAxis,
        xVal,
        yVal,
        { ...pinnedValues, ...configToPinned(config) },
      );

      // Same resolution as computeGrid's current-strategy config...
      const currentConfig = resolveDDStrategy(config, cellConfig, xAxis, yAxis);
      // ...vs. the same config with DD strategy forced 'off' (no wager
      // fraction/value-table left over from whatever strategy is active).
      const offConfig: SimConfig = {
        ...currentConfig,
        ddStrategy: 'off',
        ddWagerFraction: undefined,
        valueTable: undefined,
      };

      // Same seed for both runs (derived per-cell so different cells
      // aren't correlated with each other) — every opponent sample, clue
      // draw, and buzz race is identical between the two runs, only the DD
      // wager/strategy differs.
      const cellSeed = (seed + xi * (resolution + 1) + yi) >>> 0;

      const { winRate: winRateCurrent } = calculateWinRate(
        player, opponentProfile, currentConfig, gamesPerCell, false, mulberry32(cellSeed),
      );
      const { winRate: winRateOff } = calculateWinRate(
        player, opponentProfile, offConfig, gamesPerCell, false, mulberry32(cellSeed),
      );

      diffGrid.push({ x: xNorm, y: yNorm, diff: winRateCurrent - winRateOff });
      computed++;

      if (computed % Math.max(1, Math.floor(totalCells / 20)) === 0) {
        hooks.onProgress?.(computed / totalCells);
      }
    }
  }

  return diffGrid;
}

/**
 * All Games "Gain from optimal play" (TODOS "P2 — All Games optimal-vs-actual
 * delta coloring") — pure per-game builder, exported for direct unit
 * testing (no `self`/postMessage dependency; the `computeGamesDelta`
 * message handler above is a thin wrapper that adds progress/cancellation).
 *
 * Mirrors the `simAllGames` loop exactly — same Coryat-calibrated opponent
 * sampling, same `simsPerGame` — but runs each simulation TWICE with the
 * same seed: once with the current settings (resolved exactly like
 * simAllGames resolves them) and once with optimal strategy forced on
 * (`ddStrategy: 'equity'` with `valueTable`, `squareSelection: 'ddSeek'`).
 * Seeds are derived per (game, sim) so each pair shares its opponent
 * samples, clue draws and buzz races until the two strategies diverge.
 * When the current settings already ARE optimal, both arms are the same
 * simulation run twice with the same seed, so every gain is exactly 0.
 *
 * `valueTable` is passed separately from `config.valueTable` because in the
 * default colour mode App.tsx's config only carries a table while Optimal
 * is the selected DD strategy; the optimal arm needs it regardless. When
 * it is undefined the engine's documented fallback applies (equity ->
 * 'aggressive' preset), so callers should build the table first.
 *
 * Returns `null` if `hooks.isCancelled()` becomes true mid-computation.
 */
export function buildGamesDelta(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  games: any[],
  xAxis: DimensionName,
  yAxis: DimensionName,
  xVal: number,
  yVal: number,
  pinnedValues: Record<string, number>,
  config: SimConfig,
  simsPerGame: number,
  valueTable: ValueTable | undefined,
  seed: number = DEFAULT_GAMES_DELTA_SEED,
  hooks: { onProgress?: (pct: number) => void; isCancelled?: () => boolean } = {},
): GameDeltaResult[] | null {
  const { player, config: cellConfig } = buildSimParams(
    xAxis,
    yAxis,
    xVal,
    yVal,
    { ...pinnedValues, ...configToPinned(config) },
  );
  // Same resolution as simAllGames' current-settings config...
  const currentConfig: SimConfig = resolveDDStrategy(config, cellConfig, xAxis, yAxis);
  // ...vs. the same config with optimal strategy forced on. `ddWagerFraction`
  // must be cleared: when set it overrides the ddStrategy enum entirely.
  const optimalConfig: SimConfig = {
    ...currentConfig,
    ddStrategy: 'equity',
    ddWagerFraction: undefined,
    valueTable: valueTable ?? currentConfig.valueTable,
    squareSelection: 'ddSeek',
  };

  const results: GameDeltaResult[] = [];
  const totalGames = games.length;
  const progressInterval = Math.max(1, Math.floor(totalGames / 50));

  for (let gi = 0; gi < totalGames; gi++) {
    if (hooks.isCancelled?.()) return null;

    const game = games[gi];
    const opp1Profile = calibrateOpponent(game.o[0]);
    const opp2Profile = calibrateOpponent(game.o[1]);
    let winsCurrent = 0;
    let winsOptimal = 0;

    for (let s = 0; s < simsPerGame; s++) {
      const simSeed = (seed + gi * simsPerGame + s) >>> 0;

      const rngCurrent = mulberry32(simSeed);
      const c1 = sampleOpponent(opp1Profile, rngCurrent);
      const c2 = sampleOpponent(opp2Profile, rngCurrent);
      if (simulateGame(player, c1, c2, currentConfig, false, rngCurrent).winner === 0) winsCurrent++;

      const rngOptimal = mulberry32(simSeed);
      const o1 = sampleOpponent(opp1Profile, rngOptimal);
      const o2 = sampleOpponent(opp2Profile, rngOptimal);
      if (simulateGame(player, o1, o2, optimalConfig, false, rngOptimal).winner === 0) winsOptimal++;
    }

    results.push({ current: winsCurrent / simsPerGame, optimal: winsOptimal / simsPerGame });

    if (gi % progressInterval === 0) {
      hooks.onProgress?.(gi / totalGames);
    }
  }

  return results;
}
