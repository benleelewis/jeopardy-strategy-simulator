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
 *   IN:  { type: 'computeOracle', xAxis, yAxis, xVal, yVal, pinnedValues,
 *          config, gamesPerCell, seed? }
 *        Strategy oracle (TODOS "P3 — Strategy-oracle full ranking"): moves
 *        every active knob by one realistic step (sim/oracle.ts) and ranks
 *        the win-rate changes. Shares ORACLE_ESTIMATE_BUDGET × gamesPerCell
 *        games across all probes, every probe seeded identically.
 *   OUT: { type: 'oracleProgress', pct }
 *   OUT: { type: 'oracleResult', rows, baselineWinRate, gamesPerEstimate }
 *   IN:  { type: 'simSingleGameDetail', gameIndex, xAxis, yAxis, xVal, yVal, pinnedValues, config, numSims }
 *   OUT: { type: 'simSingleGameDetailResult', gameIndex, results: { scores, winner, history, ddEvents }[] }
 *        (history/ddEvents feed GameDetail's per-run chart and, additively,
 *        GameReplay's "Watch this game" animation — Phase 1D)
 *   IN:  { type: 'computeGamesDelta', xAxis, yAxis, xVal, yVal, pinnedValues,
 *          config, simsPerGame, valueTable?, seed?, requestId? }
 *        All Games "Gain from optimal play" colour mode (TODOS "P2 — All
 *        Games optimal-vs-actual delta coloring"). Same per-game loop and
 *        simsPerGame as simAllGames, run twice per game with IDENTICAL
 *        seeds: once with the current settings, once with optimal strategy
 *        (ddStrategy 'equity' + squareSelection 'ddSeek', everything else
 *        as set). Never sent in the default colour mode.
 *   OUT: { type: 'gamesDeltaProgress', pct, requestId }
 *   OUT: { type: 'gamesDeltaResult', results: { actual, optimal }[],
 *          _simsPerGame, requestId }
 *
 *   IN:  { type: 'whatIfWager', requestId, gameIndex, ddEventIndex, you:
 *          { knowledge, buzzerSpeed }, event: { round, scoresBefore,
 *          cluesRemainingAfter, correct, wager }, whatIfWagerAmount,
 *          config, n?, seed? }
 *        "What if you had wagered differently?" (TASKS.md Phase 1F).
 *        Resumes the recorded Daily Double from `event.scoresBefore` with
 *        the outcome already applied per `event.correct`, then rolls the
 *        rest of the game forward `n` times (default 2,000) via
 *        `simulateFromState` — once under the ACTUAL wager
 *        (`event.wager`), once under the WHAT-IF wager
 *        (`whatIfWagerAmount`) — with paired per-rollout seeds (see
 *        `computeWhatIfWager` below) so the two arms share every opponent
 *        draw and clue outcome up to where the differing score changes a
 *        downstream decision. Superseded by a newer `whatIfWager` or by
 *        `cancelWhatIf` (below); a superseded request is dropped silently
 *        (no result is ever posted for it).
 *   OUT: { type: 'whatIfWagerResult', requestId, gameIndex, ddEventIndex,
 *          actualWager, whatIfWagerAmount, actualWinRate, whatIfWinRate,
 *          diff, se, n }
 *
 *   IN:  { type: 'cancelWhatIf' }
 *        Invalidates any in-flight `whatIfWager` request (GameDetail sends
 *        this when the selected game changes) — no reply is posted.
 */

import {
  playerFrom2Axis,
  calculateWinRate,
  simulateGame,
  simulateFromState,
  sampleOpponent,
  mulberry32,
  buildFullBoard,
  DJ_VALUES,
  type SimConfig,
  type DDStrategy,
  type DDEvent,
  type SimState,
  type Player,
  DEFAULT_CONFIG,
} from './sim-engine';
import { buildValueTable, type ValueTable } from './value-function';
import { DIMENSIONS, buildSimParams, type DimensionName } from './dimensions';
import { calibrateOpponent } from './calibrate';
import {
  buildOraclePlan,
  assembleOracleRows,
  oracleGamesPerEstimate,
  type OracleInput,
  type OracleEstimate,
  type OracleResult,
} from './oracle';

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

/** Default seed for computeOracle — one seed shared by every probe so the
 *  ranking is reproducible and probe differences isolate the knob moved. */
const DEFAULT_ORACLE_SEED = 0x0AC1E;
/** Default seed for computeGamesDelta — the delta sweep is reproducible
 *  across repeat mode switches at the same knobs. */
const DEFAULT_GAMES_DELTA_SEED = 0x6A1AED;

/** One game's two paired arms from `buildGamesDelta`. The gain shown on the
 *  All Games graph is `optimal - current`; the headline uses both means. */
export interface GameDeltaResult {
  /** Win rate with the settings as currently set. */
  actual: number;
  /** Win rate with optimal strategy: ddStrategy 'equity' (+ V-table) and
   *  squareSelection 'ddSeek', everything else as set. */
  optimal: number;
}

let cancelled = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storedGames: any[] | null = null;

/** Bumped on every `whatIfWager`/`cancelWhatIf` message. A request captures
 *  the generation it was issued under; if the counter has moved on by the
 *  time its loop checks, it's been superseded (a newer what-if, or the
 *  selected game changed) and aborts — its own dedicated cancellation
 *  channel, independent of the shared `cancelled` flag above so opening a
 *  what-if never interrupts an unrelated in-flight grid/all-games sweep on
 *  this same persistent worker. */
let whatIfGeneration = 0;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (msg.type === 'cancelWhatIf') {
    whatIfGeneration++;
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

  if (msg.type === 'computeOracle') {
    const {
      xAxis = 'knowledge',
      yAxis = 'buzzerSpeed',
      xVal,
      yVal,
      pinnedValues = {},
      gamesPerCell = 450,
      seed = DEFAULT_ORACLE_SEED,
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

    const result = computeOracle(
      { xAxis: xAxis as DimensionName, yAxis: yAxis as DimensionName, xVal, yVal, pinnedValues, config },
      gamesPerCell,
      seed,
      {
        onProgress: (pct) => self.postMessage({ type: 'oracleProgress', pct }),
        isCancelled: () => cancelled,
      },
    );
    if (result === null) return; // cancelled — drop silently, like computeGrid

    self.postMessage({ type: 'oracleResult', ...result });
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

  if (msg.type === 'whatIfWager') {
    // "What if you had wagered differently?" (TASKS.md Phase 1F). Own
    // cancellation channel (whatIfGeneration) — see its declaration above —
    // so this never touches the shared `cancelled` flag used by grid/
    // all-games sweeps also running on this persistent worker.
    const {
      requestId,
      gameIndex,
      ddEventIndex,
      you,
      event,
      whatIfWagerAmount,
      n = 2000,
      seed = DEFAULT_WHAT_IF_SEED,
    } = msg;
    const games = storedGames;
    if (!games || !games[gameIndex]) {
      self.postMessage({ type: 'error', message: 'Game not found' });
      return;
    }
    const config: SimConfig = msg.config ?? DEFAULT_CONFIG;
    const game = games[gameIndex];
    const player = playerFrom2Axis(you.knowledge, you.buzzerSpeed);
    const opponentProfiles: [OpponentSimProfile, OpponentSimProfile] = [
      calibrateOpponent(game.o[0]),
      calibrateOpponent(game.o[1]),
    ];

    const generation = ++whatIfGeneration;
    const result = computeWhatIfWager(
      player,
      opponentProfiles,
      event,
      whatIfWagerAmount,
      config,
      n,
      seed,
      { isCancelled: () => whatIfGeneration !== generation },
    );
    if (result === null) return; // superseded — drop silently

    self.postMessage({
      type: 'whatIfWagerResult',
      requestId,
      gameIndex,
      ddEventIndex,
      actualWager: event.wager,
      whatIfWagerAmount,
      ...result,
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
export function resolveDDStrategy(
  config: SimConfig,
  cellConfig: SimConfig,
  xAxis: string,
  yAxis: string,
): SimConfig {
  const merged: SimConfig = { ...config, ...cellConfig };
  // cellConfig starts from DEFAULT_CONFIG (buildSimParams), which sets
  // includeFJ: true, so spreading it last silently discarded the user's FJ
  // toggle for every grid, marginal-returns and DD-impact cell. Re-apply it.
  // (Found while building the oracle, whose FJ-off probe read exactly 0.0.)
  if (config.includeFJ !== undefined) merged.includeFJ = config.includeFJ;
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
 * Strategy oracle (TODOS "P3 — Strategy-oracle full ranking") — pure
 * builder, exported for direct unit testing like `buildDDImpactGrid` above;
 * the `computeOracle` message handler is a thin wrapper that adds progress
 * and cancellation.
 *
 * `sim/oracle.ts` decides WHICH probes to run (one realistic step per knob)
 * and how to rank them; this function only resolves each probe's
 * (axes, pinned, config) into engine params exactly the way `computeGrid`
 * resolves a cell — `buildSimParams` + `resolveDDStrategy` — and runs it.
 * Every probe plays the same seeded games (common random numbers: game i
 * of every probe is seeded identically, so the pairing is exact even
 * though a knob change alters how many draws a game consumes): a probe
 * equal to the baseline reproduces it exactly, and a probe that differs in
 * one knob differs from the baseline only through that knob's effect. The
 * per-game wins are kept so oracle.ts can report the paired standard error.
 *
 * Returns `null` if `hooks.isCancelled()` becomes true mid-computation.
 */
export function computeOracle(
  input: OracleInput,
  gamesPerCell: number,
  seed: number = DEFAULT_ORACLE_SEED,
  hooks: { onProgress?: (pct: number) => void; isCancelled?: () => boolean } = {},
): OracleResult | null {
  const plan = buildOraclePlan(input);
  const games = oracleGamesPerEstimate(plan.probes.length, gamesPerCell);
  const estimates: Record<string, OracleEstimate> = {};

  for (let i = 0; i < plan.probes.length; i++) {
    if (hooks.isCancelled?.()) return null;
    const probe = plan.probes[i];

    const { player, config: cellConfig, opponentProfile } = buildSimParams(
      input.xAxis,
      input.yAxis,
      probe.xVal,
      probe.yVal,
      { ...probe.pinnedValues, ...configToPinned(probe.config) },
    );
    // `buildSimParams` builds its per-cell config on top of DEFAULT_CONFIG,
    // and `resolveDDStrategy` spreads that per-cell config last — so
    // DEFAULT_CONFIG's `includeFJ: true` would silently override the
    // probe's Final Jeopardy setting. Re-apply it so the FJ row (and an
    // app-level FJ-off baseline) is honest.
    const mergedConfig: SimConfig = {
      ...resolveDDStrategy(probe.config, cellConfig, input.xAxis, input.yAxis),
      includeFJ: probe.config.includeFJ,
    };

    // Same loop as calculateWinRate, but re-seeded per game (golden-ratio
    // stride keeps neighbouring game seeds far apart in mulberry32's state
    // space) so game g is paired across probes. trackHistory=true so each
    // game's ddEvents are available: the square-selection "why" line
    // reports how many Daily Doubles YOU found.
    const wins = new Uint8Array(games);
    let winCount = 0;
    let ddsFound = 0;
    for (let g = 0; g < games; g++) {
      const rng = mulberry32((seed + Math.imul(g, 0x9E3779B9)) >>> 0);
      const opp1 = sampleOpponent(opponentProfile, rng);
      const opp2 = sampleOpponent(opponentProfile, rng);
      const result = simulateGame(player, opp1, opp2, mergedConfig, true, rng);
      if (result.winner === 0) {
        wins[g] = 1;
        winCount++;
      }
      for (const event of result.ddEvents ?? []) {
        if (event.player === 0) ddsFound++;
      }
    }
    estimates[probe.id] = { winRate: winCount / games, games, ddsFoundPerGame: ddsFound / games, wins };

    hooks.onProgress?.((i + 1) / plan.probes.length);
  }

  return {
    rows: assembleOracleRows(plan, estimates),
    baselineWinRate: estimates.baseline.winRate,
    gamesPerEstimate: games,
  };
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
    let winsActual = 0;
    let winsOptimal = 0;

    for (let s = 0; s < simsPerGame; s++) {
      const simSeed = (seed + gi * simsPerGame + s) >>> 0;

      const rngCurrent = mulberry32(simSeed);
      const c1 = sampleOpponent(opp1Profile, rngCurrent);
      const c2 = sampleOpponent(opp2Profile, rngCurrent);
      if (simulateGame(player, c1, c2, currentConfig, false, rngCurrent).winner === 0) winsActual++;

      const rngOptimal = mulberry32(simSeed);
      const o1 = sampleOpponent(opp1Profile, rngOptimal);
      const o2 = sampleOpponent(opp2Profile, rngOptimal);
      if (simulateGame(player, o1, o2, optimalConfig, false, rngOptimal).winner === 0) winsOptimal++;
    }

    results.push({ actual: winsActual / simsPerGame, optimal: winsOptimal / simsPerGame });

    if (gi % progressInterval === 0) {
      hooks.onProgress?.(gi / totalGames);
    }
  }

  return results;
}

// ─── "What if you had wagered differently?" (TASKS.md Phase 1F) ──────────

/** Default seed for computeWhatIfWager — reproducible across repeat clicks
 *  of "What if" at the same wager. */
export const DEFAULT_WHAT_IF_SEED = 0x4A6170;

/** Shape `calibrateOpponent`/`OPPONENT_PROFILES` both satisfy — the only
 *  fields `sampleOpponent` reads. */
type OpponentSimProfile = { b: number; p: number; fjAccuracy: number };

/** The recorded Daily Double fields needed to resume play from it —
 *  exactly `DDEvent`'s optional/additive resume fields (sim-engine.ts) plus
 *  its always-present `wager`/`correct`. GameDetail hides the what-if
 *  control entirely when an event lacks `scoresBefore`/`cluesRemainingAfter`
 *  (older results), so by the time this runs they're known-present. */
export interface WhatIfWagerEvent {
  round: 'J' | 'DJ';
  scoresBefore: [number, number, number];
  cluesRemainingAfter: number;
  correct: boolean;
  /** The wager actually made at this Daily Double. */
  wager: number;
}

export interface WhatIfWagerResult {
  actualWinRate: number;
  whatIfWinRate: number;
  /** whatIfWinRate - actualWinRate, in [-1, 1]. */
  diff: number;
  /**
   * Paired standard error of `diff`. Computed from the per-rollout
   * (whatIf - actual) outcome differences directly (each in {-1, 0, 1}),
   * not from the two arms' independent binomial SEs added in quadrature —
   * the paired seeding correlates the two arms, so the naive independent
   * formula overstates the true uncertainty in the difference.
   */
  se: number;
  n: number;
}

/** J-round clue face values (sim-engine.ts's own `J_VALUES` is private —
 *  this is its only consumer here, so it's duplicated rather than exporting
 *  a new symbol from a file this task must not touch). */
const J_VALUES_FOR_RESUME = [200, 400, 600, 800, 1000];

/**
 * Sample a representative remaining board of `n` clue values for `round`,
 * for resuming a state we only know the CLUE COUNT of (not the actual
 * values) — same technique as `value-function.ts`'s private
 * `sampleRemainingBoard` (partial Fisher–Yates over the round's full
 * 30-clue board), parameterized by round since that function is scoped to
 * DJ-only states and this caller also resumes mid-J.
 */
export function sampleRemainingBoardForRound(round: 'J' | 'DJ', n: number, rng: () => number): number[] {
  const board = buildFullBoard(round === 'J' ? J_VALUES_FOR_RESUME : DJ_VALUES);
  const take = Math.max(0, Math.min(n, board.length));
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (board.length - i));
    const tmp = board[i]; board[i] = board[j]; board[j] = tmp;
  }
  return board.slice(0, take);
}

/**
 * Estimate how many (still-unrevealed) Daily Doubles remain in the round
 * after the one just resolved. Exact for 'J' (the round has exactly one
 * DD, and it's the one being resumed from, so none remain). For 'DJ' (2
 * DDs total, so at most 1 remains), the event alone doesn't say whether
 * this was the round's first or second DD, so it's estimated from the
 * fraction of the round still unplayed — the same clue-count-only
 * treatment `value-function.ts`'s `buildValueTable` gives any state reached
 * only via a `cluesRemaining` count.
 */
export function estimateRemainingDDCount(round: 'J' | 'DJ', cluesRemainingAfter: number): number {
  if (round === 'J') return 0;
  const clamped = Math.max(0, Math.min(29, cluesRemainingAfter));
  return Math.round(clamped / 29);
}

/**
 * Pure builder behind the `whatIfWager` message, exported for direct unit
 * testing. Resumes `event` with the DD outcome already applied — once
 * under the ACTUAL wager (`event.wager`), once under `whatIfWagerAmount` —
 * and rolls the rest of the game forward `n` times per arm via
 * `simulateFromState`.
 *
 * Paired seeds (common random numbers, same technique `buildGamesDelta`
 * above uses): rollout i's two arms both derive their RNG from the SAME
 * per-rollout seed (`seed` offset by a prime stride, matching
 * `equity-validation.test.ts`'s `productionEquity`), so they draw the same
 * sampled remaining board and the same opponent samples/clue outcomes up
 * until the differing score changes a downstream decision (e.g. who
 * controls the board next). When `whatIfWagerAmount === event.wager` the
 * two arms are bit-identical for every rollout, so `diff` and `se` are
 * both exactly 0.
 *
 * Returns `null` if `hooks.isCancelled()` becomes true mid-computation
 * (checked once per rollout — mirrors `buildDDImpactGrid`'s abort-silently
 * semantics elsewhere in this file).
 */
export function computeWhatIfWager(
  you: Player,
  opponentProfiles: [OpponentSimProfile, OpponentSimProfile],
  event: WhatIfWagerEvent,
  whatIfWagerAmount: number,
  config: SimConfig,
  n = 2000,
  seed: number = DEFAULT_WHAT_IF_SEED,
  hooks: { isCancelled?: () => boolean } = {},
): WhatIfWagerResult | null {
  const { round, scoresBefore, cluesRemainingAfter, correct, wager } = event;

  const actualScores: [number, number, number] = [...scoresBefore];
  actualScores[0] += correct ? wager : -wager;
  const whatIfScores: [number, number, number] = [...scoresBefore];
  whatIfScores[0] += correct ? whatIfWagerAmount : -whatIfWagerAmount;

  const ddCount = estimateRemainingDDCount(round, cluesRemainingAfter);

  const actualOutcomes = new Int8Array(n);
  const whatIfOutcomes = new Int8Array(n);
  let actualWins = 0;
  let whatIfWins = 0;

  for (let i = 0; i < n; i++) {
    if (hooks.isCancelled?.()) return null;

    // Prime stride de-correlates rollouts from each other (same scheme as
    // equity-validation.test.ts's productionEquity); both arms share this
    // one seed so they're paired.
    const rollSeed = (seed + i * 7919) >>> 0;

    const rngActual = mulberry32(rollSeed);
    const remainingActual = sampleRemainingBoardForRound(round, cluesRemainingAfter, rngActual);
    const opp1a = sampleOpponent(opponentProfiles[0], rngActual);
    const opp2a = sampleOpponent(opponentProfiles[1], rngActual);
    const stateActual: SimState = {
      scores: actualScores, round, remainingClueValues: remainingActual, remainingDDCount: ddCount,
    };
    const winActual = simulateFromState(stateActual, [you, opp1a, opp2a], config, rngActual, false).winner === 0 ? 1 : 0;
    actualOutcomes[i] = winActual;
    actualWins += winActual;

    const rngWhatIf = mulberry32(rollSeed);
    const remainingWhatIf = sampleRemainingBoardForRound(round, cluesRemainingAfter, rngWhatIf);
    const opp1w = sampleOpponent(opponentProfiles[0], rngWhatIf);
    const opp2w = sampleOpponent(opponentProfiles[1], rngWhatIf);
    const stateWhatIf: SimState = {
      scores: whatIfScores, round, remainingClueValues: remainingWhatIf, remainingDDCount: ddCount,
    };
    const winWhatIf = simulateFromState(stateWhatIf, [you, opp1w, opp2w], config, rngWhatIf, false).winner === 0 ? 1 : 0;
    whatIfOutcomes[i] = winWhatIf;
    whatIfWins += winWhatIf;
  }

  const actualWinRate = actualWins / n;
  const whatIfWinRate = whatIfWins / n;

  let sumDiff = 0;
  let sumDiffSq = 0;
  for (let i = 0; i < n; i++) {
    const d = whatIfOutcomes[i] - actualOutcomes[i];
    sumDiff += d;
    sumDiffSq += d * d;
  }
  const meanDiff = sumDiff / n;
  const varDiff = Math.max(0, sumDiffSq / n - meanDiff * meanDiff);
  const se = Math.sqrt(varDiff / n);

  return { actualWinRate, whatIfWinRate, diff: whatIfWinRate - actualWinRate, se, n };
}
