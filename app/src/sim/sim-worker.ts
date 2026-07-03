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
 */

import {
  playerFrom2Axis,
  calculateWinRate,
  simulateGame,
  sampleOpponent,
  type SimConfig,
  DEFAULT_CONFIG,
} from './sim-engine';
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
        const mergedConfig = { ...config, ...cellConfig };
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
    const mergedConfig: SimConfig = { ...config, ...cellConfig };

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
      const mergedConfig = { ...config, ...cellConfig };
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
    const mergedConfig: SimConfig = { ...config, ...cellConfig };

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
};

/** Extract pinned-compatible values from SimConfig for dimensions that use config fields */
function configToPinned(config: SimConfig): Record<string, number> {
  const pinned: Record<string, number> = {};
  if (config.ddWagerFraction !== undefined) {
    pinned.ddAggression = config.ddWagerFraction;
  }
  return pinned;
}
