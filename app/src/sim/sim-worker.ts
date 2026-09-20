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
 *   IN:  { type: 'simSingleGameDetail', gameIndex, xAxis, yAxis, xVal, yVal, pinnedValues, config, numSims }
 *   OUT: { type: 'simSingleGameDetailResult', gameIndex, results: { scores, winner, history, ddEvents }[] }
 *        (history/ddEvents feed GameDetail's per-run chart and, additively,
 *        GameReplay's "Watch this game" animation — Phase 1D)
 */

import {
  playerFrom2Axis,
  calculateWinRate,
  simulateGame,
  sampleOpponent,
  mulberry32,
  type SimConfig,
  type DDStrategy,
  type DDEvent,
  DEFAULT_CONFIG,
} from './sim-engine';
import { buildValueTable } from './value-function';
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
    // ddEvents is carried through additively (Phase 1D replay needs Daily
    // Double wager/correctness per clue) — existing consumers that only read
    // scores/winner/history are unaffected.
    const results: { scores: [number, number, number]; winner: number; history?: [number, number, number][]; ddEvents?: DDEvent[] }[] = [];

    for (let s = 0; s < numSims; s++) {
      const opp1 = sampleOpponent(calibrateOpponent(game.o[0]));
      const opp2 = sampleOpponent(calibrateOpponent(game.o[1]));
      const result = simulateGame(player, opp1, opp2, mergedConfig, true);
      results.push({ scores: result.scores, winner: result.winner, history: result.history, ddEvents: result.ddEvents });
    }

    self.postMessage({ type: 'simSingleGameDetailResult', gameIndex, results });
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
