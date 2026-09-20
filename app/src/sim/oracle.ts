/**
 * Strategy oracle — "what to work on" (TODOS.md "P3 — Strategy-oracle full
 * ranking", design doc Screen 3).
 *
 * At the user's current Explorer position and pinned values, every knob in
 * the registry (plus the app-level DD strategy and Final Jeopardy toggles,
 * which are SimConfig fields rather than dimensions) is moved by ONE
 * realistic step and the win-rate change is measured. The rows are then
 * ranked by that change.
 *
 * This module is pure planning + assembly: it decides WHAT to simulate
 * (`buildOraclePlan`) and turns the estimates back into ranked rows
 * (`assembleOracleRows`). The simulation itself runs in sim-worker.ts's
 * `computeOracle`, which is where `buildSimParams` and the worker's own
 * DD-strategy reconciliation live. Keeping the plan/assembly here means
 * they are unit-testable in the plain node environment, and the component
 * can import the row type without pulling in the worker module (which
 * assigns `self.onmessage` at load time).
 *
 * Step sizes ("realistic step" per knob kind — decided once, here):
 *   - skill dims (knowledge, buzzer speed, accuracy, attempt rate, buzz-race
 *     win %, Coryat): +5% of the dimension's range (`ORACLE_SKILL_STEP`).
 *     For the [0,1] rate dims that is +0.05 — about what a few months of
 *     study or buzzer practice plausibly buys; for Coryat it is +$1,500.
 *   - DD wager size (the continuous `ddAggression` fraction): a 5-point
 *     sweep (`ORACLE_WAGER_SWEEP`); the row reports the sweep value with the
 *     highest win rate and the gain over the current value.
 *   - choices (DD strategy, square selection, Final Jeopardy on/off,
 *     opponent strength anchors): every alternative value is simulated and
 *     the best one is reported against the current value.
 *
 * Every probe plays the SAME sequence of seeded games (common random
 * numbers: game i of every probe starts from the same RNG state), so a
 * probe that equals the baseline reproduces it exactly and game-by-game
 * differences isolate the knob rather than independent Monte Carlo noise.
 * The standard error of a row's delta is therefore the PAIRED one (from
 * the per-game win differences) when both probes carry per-game wins, and
 * falls back to the independent binomial formula otherwise.
 */

import {
  DIMENSIONS,
  getPinnedDimNames,
  buzzSpeedToWinPct,
  type DimensionName,
} from './dimensions';
import type { SimConfig, DDStrategy, SquareSelection } from './sim-engine';

// ─── Step definitions ──────────────────────────────────────────────

/** Skill dims move by this fraction of their range (+0.05 on a [0,1] dim). */
export const ORACLE_SKILL_STEP = 0.05;

/** DD wager fraction sweep: min bet, quarter, half, three-quarters, everything. */
export const ORACLE_WAGER_SWEEP: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

/** Opponent strength is treated as a choice between Tesauro's three anchors
 *  (dimensions.ts `interpolateOpponent`: 0 = Average, 0.5 = Champion,
 *  1 = Grand Champion), not a continuous dial — nobody "works on" a 5%
 *  stronger opponent. */
export const ORACLE_OPPONENT_ANCHORS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Average contestants' },
  { value: 0.5, label: 'Champions' },
  { value: 1, label: 'Grand champions' },
];

/** DD wagering strategies the oracle can suggest. `'equity'` is only offered
 *  when the config already carries a built value table (without one the
 *  engine silently falls back to 'aggressive', which would make the
 *  comparison meaningless). `'off'` is never suggested — it is a diagnostic
 *  setting, not a strategy a contestant can play. */
const ORACLE_DD_STRATEGIES: readonly DDStrategy[] = ['conservative', 'aggressive', 'truedd', 'equity'];

/** Whole-oracle budget, in multiples of the Explorer's refined games-per-cell:
 *  the probes share `ORACLE_ESTIMATE_BUDGET × gamesPerCell` games between
 *  them, so the run costs about the same however many rows there are. */
export const ORACLE_ESTIMATE_BUDGET = 12;

/** Floor on games per probe so a very small gamesPerCell still gives a
 *  usable (if wide) estimate. */
export const ORACLE_MIN_GAMES = 50;

/** Debounce applied by the StrategyOracle component before it posts a run. */
export const ORACLE_DEBOUNCE_MS = 400;

/** Games each probe gets under the shared budget. */
export function oracleGamesPerEstimate(probeCount: number, gamesPerCell: number): number {
  const perProbe = Math.floor((ORACLE_ESTIMATE_BUDGET * gamesPerCell) / Math.max(1, probeCount));
  return Math.max(ORACLE_MIN_GAMES, perProbe);
}

// ─── Types ─────────────────────────────────────────────────────────

export type OracleKind = 'skill' | 'wager' | 'choice' | 'environment';

/** The current-position inputs the oracle plans from — the same fields the
 *  worker's other position-level messages (`computeWinRate`) take. */
export interface OracleInput {
  xAxis: DimensionName;
  yAxis: DimensionName;
  /** Axis values in the dimensions' own units (not [0,1] fractions). */
  xVal: number;
  yVal: number;
  pinnedValues: Record<string, number>;
  config: SimConfig;
}

/** One simulation to run: a complete (axes, pinned, config) triple. */
export interface OracleProbe {
  /** Stable id; `'baseline'` is the current position itself. */
  id: string;
  xVal: number;
  yVal: number;
  pinnedValues: Record<string, number>;
  config: SimConfig;
}

/** What a probe produced. `ddsFoundPerGame` counts YOUR Daily Doubles
 *  (player 0) per game, used by the square-selection "why" line. `wins`
 *  is the per-game 0/1 outcome in seeded game order; two probes with
 *  `wins` of equal length are paired game-by-game for their delta's SE. */
export interface OracleEstimate {
  winRate: number;
  games: number;
  ddsFoundPerGame: number;
  wins?: Uint8Array;
}

interface OracleCandidate {
  /** Probe whose estimate this candidate reads. `'baseline'` when the
   *  candidate IS the current value (no extra simulation needed). */
  probeId: string;
  label: string;
  why: (candidate: OracleEstimate, baseline: OracleEstimate) => string;
}

interface OracleKnob {
  dimension: string;
  kind: OracleKind;
  label: string;
  currentLabel: string;
  candidates: OracleCandidate[];
  /** True when the step is impossible (e.g. a skill dim already at the top
   *  of its range) — the row is still shown so the ranking stays complete. */
  noStep?: string;
}

export interface OraclePlan {
  knobs: OracleKnob[];
  probes: OracleProbe[];
}

/** One ranked row. Plain data — crosses postMessage from the worker. */
export interface OracleRow {
  /** Registry name, or `'ddStrategy'` / `'includeFJ'` for the config-level knobs. */
  dimension: string;
  kind: OracleKind;
  /** Plain-language knob name, sentence case. */
  label: string;
  currentLabel: string;
  suggestedLabel: string;
  /** Win-rate change (fraction, e.g. 0.031 for +3.1 pp) of the suggested
   *  value versus the current one. Negative when the current value is
   *  already the best available and switching would cost win rate. */
  delta: number;
  /** Standard error of `delta`: paired over the shared seeded games when
   *  available, else from two independent binomial estimates. */
  se: number;
  /** |delta| ≥ 2·se (and se > 0): the change is outside Monte Carlo noise. */
  significant: boolean;
  /** No candidate beats the current value (delta ≤ 0), or no step exists. */
  atBest: boolean;
  /** One plain-language line explaining what the suggested change means. */
  why: string;
}

export interface OracleResult {
  rows: OracleRow[];
  baselineWinRate: number;
  gamesPerEstimate: number;
}

// ─── Labels ────────────────────────────────────────────────────────

const pct = (v: number) => `${Math.round(v * 100)}%`;
const dollars = (v: number) => `$${Math.round(v).toLocaleString()}`;

/** Plain-language names for the panel (the registry labels carry
 *  parenthetical definitions that are too long for a ranked row). */
const KNOB_LABELS: Record<string, string> = {
  knowledge: 'Knowledge',
  buzzerSpeed: 'Buzzer speed',
  precision: 'Accuracy when you buzz',
  buzzAttemptRate: 'How often you buzz',
  buzzRaceWinPct: 'Buzzer races won',
  expectedCoryat: 'Coryat score',
  ddAggression: 'Daily Double wager size',
  ddStrategy: 'Daily Double strategy',
  squareSelection: 'Square selection',
  includeFJ: 'Final Jeopardy',
  opponentStrength: 'Opponents',
};

export function oracleKnobLabel(dimension: string): string {
  return KNOB_LABELS[dimension] ?? DIMENSIONS[dimension as DimensionName]?.label ?? dimension;
}

const DD_STRATEGY_LABELS: Record<DDStrategy, string> = {
  off: 'No Daily Double wagers',
  conservative: 'Conservative',
  aggressive: 'Aggressive',
  truedd: 'True Daily Double',
  equity: 'Optimal (equity)',
};

function ddStrategyWhy(strategy: DDStrategy, wagerFraction: number): string {
  switch (strategy) {
    case 'conservative': return 'Small, safe Daily Double wagers';
    case 'aggressive': return `Wagering ${pct(wagerFraction)} of your score on each Daily Double`;
    case 'truedd': return 'Betting everything on every Daily Double';
    case 'equity': return 'Each wager picked to maximise your chance of winning the game';
    case 'off': return 'Never wagering on Daily Doubles';
  }
}

function wagerLabel(fraction: number): string {
  if (fraction <= 0) return 'Minimum bet';
  if (fraction >= 1) return 'Everything';
  return `${pct(fraction)} of score`;
}

function squareSelectionLabel(v: SquareSelection): string {
  return v === 'ddSeek' ? 'Seeking Daily Doubles' : 'Top-down';
}

export function opponentLabel(strength: number): string {
  const anchor = ORACLE_OPPONENT_ANCHORS.find(a => nearly(a.value, strength));
  if (anchor) return anchor.label;
  return strength < 0.5 ? 'Between average and champion' : 'Between champion and grand champion';
}

function skillWhy(dim: DimensionName, current: number, next: number): string {
  switch (dim) {
    case 'knowledge':
      return `Answering ${pct(next)} of clues instead of ${pct(current)}`;
    case 'buzzerSpeed':
      return `Winning ${pct(buzzSpeedToWinPct(next))} of buzzer races instead of ${pct(buzzSpeedToWinPct(current))}`;
    case 'precision':
      return `Getting ${pct(next)} right when you buzz instead of ${pct(current)}`;
    case 'buzzAttemptRate':
      return `Buzzing on ${pct(next)} of clues instead of ${pct(current)}`;
    case 'buzzRaceWinPct':
      return `Winning ${pct(next)} of buzzer races instead of ${pct(current)}`;
    case 'expectedCoryat':
      return `Scoring ${dollars(next)} instead of ${dollars(current)} before wagers`;
    default:
      return `Moving from ${DIMENSIONS[dim].format(current)} to ${DIMENSIONS[dim].format(next)}`;
  }
}

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

// ─── Plan ──────────────────────────────────────────────────────────

/**
 * Decide which probes to simulate and how each knob's rows read them.
 *
 * Which knobs appear depends on the axes (only dims that actually apply
 * for this axis pair — `getPinnedDimNames` — are moved) and on the config
 * (the wager-size sweep only exists while the 'aggressive' strategy is
 * active, because that is the only strategy that reads the fraction).
 */
export function buildOraclePlan(input: OracleInput): OraclePlan {
  const { xAxis, yAxis, xVal, yVal, pinnedValues, config } = input;
  const probes: OracleProbe[] = [];
  const knobs: OracleKnob[] = [];

  const baseline: OracleProbe = { id: 'baseline', xVal, yVal, pinnedValues: { ...pinnedValues }, config };
  probes.push(baseline);

  const activeDims: DimensionName[] = [xAxis, yAxis, ...getPinnedDimNames(xAxis, yAxis)];
  const isAxis = (name: DimensionName) => name === xAxis || name === yAxis;

  /** Current value of a registry dim at this position. */
  const currentOf = (name: DimensionName): number => {
    if (name === xAxis) return xVal;
    if (name === yAxis) return yVal;
    return pinnedValues[name] ?? DIMENSIONS[name].defaultValue;
  };

  /** A probe identical to the baseline except that one registry dim is
   *  moved to `value` (through the axis if it is one, else the pinned map). */
  const probeWithDim = (id: string, name: DimensionName, value: number, configPatch: Partial<SimConfig> = {}): OracleProbe => {
    const probe: OracleProbe = {
      id,
      xVal: name === xAxis ? value : xVal,
      yVal: name === yAxis ? value : yVal,
      pinnedValues: { ...pinnedValues },
      config: { ...config, ...configPatch },
    };
    if (!isAxis(name)) probe.pinnedValues[name] = value;
    probes.push(probe);
    return probe;
  };

  const probeWithConfig = (id: string, configPatch: Partial<SimConfig>): OracleProbe => {
    const probe: OracleProbe = { id, xVal, yVal, pinnedValues: { ...pinnedValues }, config: { ...config, ...configPatch } };
    probes.push(probe);
    return probe;
  };

  // 1. Skill dims: +5% of range.
  for (const name of activeDims) {
    const dim = DIMENSIONS[name];
    if (dim.type !== 'player') continue;
    const current = currentOf(name);
    const step = (dim.range[1] - dim.range[0]) * ORACLE_SKILL_STEP;
    const next = Math.min(dim.range[1], current + step);
    if (nearly(next, current)) {
      knobs.push({
        dimension: name,
        kind: 'skill',
        label: oracleKnobLabel(name),
        currentLabel: dim.format(current),
        candidates: [{ probeId: 'baseline', label: dim.format(current), why: () => 'Already at the top of the scale' }],
        noStep: 'Already at the top of the scale',
      });
      continue;
    }
    probeWithDim(`${name}+step`, name, next);
    knobs.push({
      dimension: name,
      kind: 'skill',
      label: oracleKnobLabel(name),
      currentLabel: dim.format(current),
      candidates: [{ probeId: `${name}+step`, label: dim.format(next), why: () => skillWhy(name, current, next) }],
    });
  }

  // 2. DD wager size: 5-point sweep, only while the fraction is actually read.
  const ddAggressionIsAxis = isAxis('ddAggression');
  const wagerActive = activeDims.includes('ddAggression') && (ddAggressionIsAxis || config.ddStrategy === 'aggressive');
  const currentWager = ddAggressionIsAxis
    ? currentOf('ddAggression')
    : (config.ddWagerFraction ?? pinnedValues.ddAggression ?? DIMENSIONS.ddAggression.defaultValue);
  if (wagerActive) {
    const candidates: OracleCandidate[] = ORACLE_WAGER_SWEEP.map(v => {
      const why = () => `Wagering ${wagerLabel(v).toLowerCase()} on Daily Doubles instead of ${wagerLabel(currentWager).toLowerCase()}`;
      if (nearly(v, currentWager)) return { probeId: 'baseline', label: wagerLabel(v), why };
      const id = `ddAggression=${v}`;
      probeWithDim(id, 'ddAggression', v, ddAggressionIsAxis ? {} : { ddWagerFraction: v });
      return { probeId: id, label: wagerLabel(v), why };
    });
    knobs.push({
      dimension: 'ddAggression',
      kind: 'wager',
      label: oracleKnobLabel('ddAggression'),
      currentLabel: wagerLabel(currentWager),
      candidates,
    });
  }

  // 3. DD strategy: every other strategy (equity only with a built table).
  //    Skipped while DD wager size is a swept axis — the worker then ignores
  //    the app-level selector, so every alternative would equal the baseline.
  if (!ddAggressionIsAxis) {
    const current = config.ddStrategy;
    const wagerFraction = currentWager;
    const alternatives = ORACLE_DD_STRATEGIES.filter(s => s !== current && (s !== 'equity' || config.valueTable !== undefined));
    const candidates: OracleCandidate[] = alternatives.map(s => {
      const id = `ddStrategy=${s}`;
      probeWithConfig(id, {
        ddStrategy: s,
        ddWagerFraction: s === 'aggressive' ? wagerFraction : undefined,
        valueTable: s === 'equity' ? config.valueTable : undefined,
      });
      return { probeId: id, label: DD_STRATEGY_LABELS[s], why: () => ddStrategyWhy(s, wagerFraction) };
    });
    knobs.push({
      dimension: 'ddStrategy',
      kind: 'choice',
      label: oracleKnobLabel('ddStrategy'),
      currentLabel: DD_STRATEGY_LABELS[current],
      candidates,
    });
  }

  // 4. Square selection: top-down vs seeking Daily Doubles.
  {
    const selectionIsAxis = isAxis('squareSelection');
    const current: SquareSelection = selectionIsAxis
      ? (currentOf('squareSelection') >= 0.5 ? 'ddSeek' : 'default')
      : (config.squareSelection ?? 'default');
    const alt: SquareSelection = current === 'ddSeek' ? 'default' : 'ddSeek';
    const id = `squareSelection=${alt}`;
    if (selectionIsAxis) probeWithDim(id, 'squareSelection', alt === 'ddSeek' ? 1 : 0);
    else probeWithConfig(id, { squareSelection: alt });
    const why = (c: OracleEstimate, b: OracleEstimate) => alt === 'ddSeek'
      ? `Seeking Daily Doubles finds ${c.ddsFoundPerGame.toFixed(1)} per game instead of ${b.ddsFoundPerGame.toFixed(1)}`
      : `Playing top-down finds ${c.ddsFoundPerGame.toFixed(1)} Daily Doubles per game instead of ${b.ddsFoundPerGame.toFixed(1)}`;
    knobs.push({
      dimension: 'squareSelection',
      kind: 'choice',
      label: oracleKnobLabel('squareSelection'),
      currentLabel: squareSelectionLabel(current),
      candidates: [{ probeId: id, label: squareSelectionLabel(alt), why }],
    });
  }

  // 5. Final Jeopardy on/off (a model setting, shown for scale).
  {
    const current = config.includeFJ;
    const id = `includeFJ=${!current}`;
    probeWithConfig(id, { includeFJ: !current });
    knobs.push({
      dimension: 'includeFJ',
      kind: 'environment',
      label: oracleKnobLabel('includeFJ'),
      currentLabel: current ? 'Played' : 'Skipped',
      candidates: [{
        probeId: id,
        label: current ? 'Skipped' : 'Played',
        why: () => current
          ? 'Ends the game after Double Jeopardy, so a lead cannot be overturned'
          : 'Adds the final wager, where a lead can be overturned',
      }],
    });
  }

  // 6. Opponents: the other Tesauro anchors (luck of the draw, shown for scale).
  if (activeDims.includes('opponentStrength')) {
    const current = currentOf('opponentStrength');
    const candidates: OracleCandidate[] = ORACLE_OPPONENT_ANCHORS
      .filter(a => !nearly(a.value, current))
      .map(a => {
        const id = `opponentStrength=${a.value}`;
        probeWithDim(id, 'opponentStrength', a.value);
        return {
          probeId: id,
          label: a.label,
          why: () => `Facing ${a.label.toLowerCase()} instead — the draw, not practice`,
        };
      });
    knobs.push({
      dimension: 'opponentStrength',
      kind: 'environment',
      label: oracleKnobLabel('opponentStrength'),
      currentLabel: opponentLabel(current),
      candidates,
    });
  }

  return { knobs, probes };
}

// ─── Assembly ──────────────────────────────────────────────────────

/**
 * Standard error of (a − b). When both estimates carry per-game wins over
 * the same seeded games, this is the paired SE — the sample standard
 * deviation of the per-game differences over √n — which is what the
 * common-random-numbers design actually delivers (a knob that changes the
 * outcome of only a few games gets a correspondingly tight interval).
 * Otherwise it is the independent binomial SE, sqrt(p(1−p)/n) summed in
 * quadrature.
 */
export function deltaStandardError(a: OracleEstimate, b: OracleEstimate): number {
  if (a.wins && b.wins && a.wins.length === b.wins.length && a.wins.length > 1) {
    const n = a.wins.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a.wins[i] - b.wins[i];
    const mean = sum / n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = a.wins[i] - b.wins[i] - mean;
      ss += d * d;
    }
    return Math.sqrt(ss / (n - 1) / n);
  }
  const va = (a.winRate * (1 - a.winRate)) / Math.max(1, a.games);
  const vb = (b.winRate * (1 - b.winRate)) / Math.max(1, b.games);
  return Math.sqrt(va + vb);
}

/**
 * Turn probe estimates into ranked rows. For each knob the candidate with
 * the highest win rate is the suggestion; ties go to the current value so
 * a knob already at its best reads as "keep". Rows sort by delta,
 * descending.
 */
export function assembleOracleRows(plan: OraclePlan, estimates: Record<string, OracleEstimate>): OracleRow[] {
  const baseline = estimates.baseline;
  if (!baseline) throw new Error('assembleOracleRows: missing baseline estimate');

  const rows: OracleRow[] = plan.knobs.map(knob => {
    let best: OracleCandidate | null = null;
    let bestEstimate: OracleEstimate = baseline;
    for (const candidate of knob.candidates) {
      const est = estimates[candidate.probeId];
      if (!est) throw new Error(`assembleOracleRows: missing estimate for ${candidate.probeId}`);
      const better = best === null
        || est.winRate > bestEstimate.winRate
        // On a tie, prefer the current value (probeId 'baseline').
        || (est.winRate === bestEstimate.winRate && candidate.probeId === 'baseline' && best.probeId !== 'baseline');
      if (better) {
        best = candidate;
        bestEstimate = est;
      }
    }

    if (best === null) {
      // A knob with no alternatives (e.g. DD strategy with nothing else to
      // offer) — keep the row so the ranking stays complete.
      return {
        dimension: knob.dimension,
        kind: knob.kind,
        label: knob.label,
        currentLabel: knob.currentLabel,
        suggestedLabel: knob.currentLabel,
        delta: 0,
        se: 0,
        significant: false,
        atBest: true,
        why: knob.noStep ?? 'No alternative to try',
      };
    }

    const isBaseline = best.probeId === 'baseline';
    const delta = isBaseline ? 0 : bestEstimate.winRate - baseline.winRate;
    const se = isBaseline ? 0 : deltaStandardError(bestEstimate, baseline);
    return {
      dimension: knob.dimension,
      kind: knob.kind,
      label: knob.label,
      currentLabel: knob.currentLabel,
      suggestedLabel: best.label,
      delta,
      se,
      significant: se > 0 && Math.abs(delta) >= 2 * se,
      atBest: delta <= 0,
      why: knob.noStep ?? best.why(bestEstimate, baseline),
    };
  });

  rows.sort((a, b) => b.delta - a.delta);
  return rows;
}
