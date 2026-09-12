/**
 * Dimension configuration for N-dimensional strategy space.
 *
 * Shared between UI and Web Worker. Worker imports this module directly
 * and receives dimension NAMES (strings) via postMessage — functions
 * can't cross the structured clone boundary.
 */

import { playerFrom2Axis, mulberry32, DEFAULT_CONFIG, type Player, type SimConfig } from './sim-engine';
import { OPPONENT_PROFILES, type FamousPlayer } from './opponent-models';

// ─── Types ─────────────────────────────────────────────────────────

export interface DimensionConfig {
  name: string;
  label: string;
  type: 'player' | 'strategy' | 'environment';
  range: [number, number];
  defaultValue: number;
  /** Display unit, e.g. '%' or '$'. Purely cosmetic — never used for math. */
  unit: string;
  /** Formats a real dimension value (already in this dim's own range/units,
   *  e.g. 0.42 for a [0,1] percent dim or 18500 for a dollar dim) into a
   *  display string. A dollars-valued axis must NEVER be run through a
   *  hardcoded `pct()` helper — that's the mislabel this field exists to
   *  prevent (see P-1, "Coryat: 43%"). */
  format: (v: number) => string;
  toParams: (value: number, pinned: Record<string, number>) => {
    player?: Partial<Player>;
    sim?: Partial<SimConfig>;
    opponentProfile?: { b: number; p: number; fjAccuracy: number };
  };
}

export type DimensionName =
  | 'knowledge'
  | 'buzzerSpeed'
  | 'ddAggression'
  | 'opponentStrength'
  | 'precision'
  | 'buzzRaceWinPct'
  | 'buzzAttemptRate'
  | 'expectedCoryat'
  | 'squareSelection';

// ─── Formatters ────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function dollars(v: number): string {
  return `$${Math.round(v).toLocaleString()}`;
}

/** Convert a real dimension value into the [0,1] fraction used by `position`. */
export function valueToFraction(dim: DimensionConfig, value: number): number {
  const span = dim.range[1] - dim.range[0];
  if (span === 0) return 0;
  return clamp((value - dim.range[0]) / span, 0, 1);
}

/** Convert a [0,1] `position` fraction into the dimension's real value. */
export function fractionToValue(dim: DimensionConfig, fraction: number): number {
  return dim.range[0] + (dim.range[1] - dim.range[0]) * fraction;
}

// ─── Opponent Interpolation ────────────────────────────────────────

const ANCHORS = [
  { t: 0.0, ...OPPONENT_PROFILES.average },
  { t: 0.5, ...OPPONENT_PROFILES.champion },
  { t: 1.0, ...OPPONENT_PROFILES.grandChampion },
];

/**
 * Piecewise linear interpolation between Tesauro opponent profiles.
 * 0.0 = Average, 0.5 = Champion, 1.0 = Grand Champion.
 */
export function interpolateOpponent(strength: number): { b: number; p: number; fjAccuracy: number } {
  const s = Math.max(0, Math.min(1, strength));

  // Find surrounding anchors
  let lo = ANCHORS[0];
  let hi = ANCHORS[ANCHORS.length - 1];
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    if (s >= ANCHORS[i].t && s <= ANCHORS[i + 1].t) {
      lo = ANCHORS[i];
      hi = ANCHORS[i + 1];
      break;
    }
  }

  const range = hi.t - lo.t;
  const frac = range === 0 ? 0 : (s - lo.t) / range;

  return {
    b: lo.b + (hi.b - lo.b) * frac,
    p: lo.p + (hi.p - lo.p) * frac,
    fjAccuracy: lo.fjAccuracy + (hi.fjAccuracy - lo.fjAccuracy) * frac,
  };
}

// ─── Candidate A calibration: buzz-race win % ↔ buzzerSpeed ───────────
//
// Candidate A's Y-axis ("buzz-race win % vs the field") has no closed-form
// inverse to `Player.buzzerSpeed` — the real engine's buzz resolution
// mixes buzzerSpeed-weighted contention with correlated attempt/accuracy
// draws (rhoB, rhoP via a Gaussian copula in sim-engine's `resolveBuzzer` /
// `correlatedBernoulli`, both unexported). Reproducing that exactly here
// would require exporting internals sim-engine.ts owns, so instead we
// build a small STANDALONE calibration curve, computed once at module
// init (lazily memoized) with a seeded RNG (mulberry32 — the engine's own
// PRNG) and inverted by linear interpolation over the monotone table.
//
// Definition (what the axis means): given that YOU are contending for a
// clue (you attempted and know the answer), how often do you win the
// buzzer race against the default "average" opponent field? Each of two
// average-profile opponents independently contends with probability
// b×p (attempt AND know; no rho — a documented approximation), and the
// race among contenders is buzzerSpeed-weighted — the same weighting
// sim-engine's `resolveBuzzer` uses. Conditioning on YOUR contention is
// what makes this a pure buzzer-skill axis, decoupled from your b and p.
//
// The curve honestly tops out at ~66%, not 100%: even the fastest
// possible buzzer loses weighted races when both opponents also know
// the answer. The dimension's range ends at that measured maximum
// (buzzSpeedToWinPct(1)) rather than pretending 100% is reachable.
//
// One-time cost: 21 points × 10,000 seeded races = 210,000 weighted draws
// (a few milliseconds, computed lazily once per JS context). 10,000
// trials — more than the planned "few hundred" — keeps per-point Monte
// Carlo SE ≈ ±0.5pp. At a few hundred trials the SE (~±2.5pp) exceeded
// the true spacing between adjacent points in the curve's flatter upper
// region, the monotone clamp produced flat spots, and the inverse
// round-trip (bs → win% → bs) drifted by up to 0.05; at 10k it's clean.
const BUZZ_CALIBRATION_POINTS = 21; // buzzerSpeed swept 0, 0.05, ..., 1.0
const BUZZ_CALIBRATION_TRIALS = 10000; // seeded races per point
const BUZZ_CALIBRATION_SEED = 0xB42_1912;

interface CalibrationPoint { bs: number; winPct: number }

let buzzCalibrationCache: CalibrationPoint[] | null = null;

function buildBuzzCalibration(): CalibrationPoint[] {
  const rng = mulberry32(BUZZ_CALIBRATION_SEED);
  const refB = OPPONENT_PROFILES.average.b;
  const refP = OPPONENT_PROFILES.average.p;
  const oppContendP = refB * refP; // an opponent contends if they attempt AND know
  const table: CalibrationPoint[] = [];

  for (let i = 0; i < BUZZ_CALIBRATION_POINTS; i++) {
    const bs = i / (BUZZ_CALIBRATION_POINTS - 1);
    let wins = 0;
    for (let t = 0; t < BUZZ_CALIBRATION_TRIALS; t++) {
      // You are contending (conditioned on); opponents contend
      // independently. Winner = buzzerSpeed-weighted draw among
      // contenders, mirroring sim-engine's `resolveBuzzer`.
      const opp1In = rng() < oppContendP;
      const opp2In = rng() < oppContendP;
      const weights = [bs, opp1In ? refB : 0, opp2In ? refB : 0];
      const total = weights[0] + weights[1] + weights[2];
      if (total <= 0) continue; // bs=0 and no opponents: race unresolved, you don't win

      let r = rng() * total;
      let winner = -1;
      for (let w = 0; w < weights.length; w++) {
        r -= weights[w];
        if (r <= 0) { winner = w; break; }
      }
      if (winner === 0) wins++;
    }
    table.push({ bs, winPct: wins / BUZZ_CALIBRATION_TRIALS });
  }

  // Enforce monotonicity (Monte Carlo noise can create tiny local dips;
  // the underlying relationship is monotone increasing in buzzerSpeed).
  for (let i = 1; i < table.length; i++) {
    if (table[i].winPct < table[i - 1].winPct) table[i].winPct = table[i - 1].winPct;
  }
  return table;
}

function getBuzzCalibration(): CalibrationPoint[] {
  if (!buzzCalibrationCache) buzzCalibrationCache = buildBuzzCalibration();
  return buzzCalibrationCache;
}

/** Forward: buzzerSpeed [0,1] → calibrated buzz-race win % [0,1]. */
export function buzzSpeedToWinPct(bs: number): number {
  const table = getBuzzCalibration();
  const x = clamp(bs, 0, 1);
  for (let i = 0; i < table.length - 1; i++) {
    if (x >= table[i].bs && x <= table[i + 1].bs) {
      const span = table[i + 1].bs - table[i].bs;
      const frac = span === 0 ? 0 : (x - table[i].bs) / span;
      return table[i].winPct + (table[i + 1].winPct - table[i].winPct) * frac;
    }
  }
  return table[table.length - 1].winPct;
}

/** Inverse (by interpolation over the monotone forward table): buzz-race
 *  win % [0,1] → buzzerSpeed [0,1]. */
export function winPctToBuzzSpeed(winPct: number): number {
  const table = getBuzzCalibration();
  const y = clamp(winPct, 0, 1);
  if (y <= table[0].winPct) return table[0].bs;
  if (y >= table[table.length - 1].winPct) return table[table.length - 1].bs;
  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i].winPct, hi = table[i + 1].winPct;
    if (y >= lo && y <= hi) {
      const span = hi - lo;
      const frac = span === 0 ? 0 : (y - lo) / span;
      return table[i].bs + (table[i + 1].bs - table[i].bs) * frac;
    }
  }
  return table[table.length - 1].bs;
}

// ─── Candidate C calibration: expected Coryat ↔ knowledge (b×p) ───────
//
// `calibrate.ts` (`calibrateOpponent`) already derives a forward
// relationship in the OTHER direction — real Coryat → (b, p) — via
// `coryatNorm = coryat / 25000` then splitting b×p by precision ratio.
// We reuse that same constant here rather than re-deriving it from a
// fresh simulation sweep (per P-1.4: "keep it simple and documented").
// Candidate C's Y-axis (buzz attempt rate) pins `b` directly; given b and
// a target Coryat, precision solves out: p ≈ coryat / (25000 × b).
//
// Known limitation (documented, accepted for the C1 bake-off): the
// famous-player CORYAT_ESTIMATES below are real historical figures that
// embed buzz-race dominance this crude scale doesn't model, so a marker
// like Jennings ($18,500 at 45% attempt rate) solves to p > 1 and clamps
// to 0.98 — the simulated player at that spot is somewhat stronger in
// precision than the real one. Axis semantics (what the C1 checkpoint
// evaluates) are unaffected.
const CORYAT_SCALE = 25000; // same constant as calibrate.ts's coryatNorm

/** Hardcoded famous-player Coryat estimates (BRAINSTORM.md K×B table) —
 *  these are real historical figures, not derived from CORYAT_SCALE. */
const CORYAT_ESTIMATES: Record<string, number> = {
  'Ken Jennings': 18500,
  'James Holzhauer': 22400,
  'Brad Rutter': 19200,
  'Amy Schneider': 17800,
  'Watson (IBM)': 20800,
  'Average': 12400,
};

// ─── Dimension Registry ────────────────────────────────────────────

export const DIMENSIONS: Record<DimensionName, DimensionConfig> = {
  knowledge: {
    name: 'knowledge',
    label: 'Knowledge (buzz rate × accuracy)',
    type: 'player',
    range: [0, 1],
    defaultValue: 0.4,
    unit: '%',
    format: pct,
    toParams: (k, pinned) => {
      const bs = pinned.buzzerSpeed ?? 0.5;
      const player = playerFrom2Axis(k, bs);
      return { player: { b: player.b, p: player.p, fjAccuracy: player.fjAccuracy } };
    },
  },
  buzzerSpeed: {
    name: 'buzzerSpeed',
    label: 'Buzzer Speed',
    type: 'player',
    range: [0, 1],
    defaultValue: 0.5,
    unit: '%',
    format: pct,
    toParams: (bs) => {
      return { player: { buzzerSpeed: bs } };
    },
  },
  ddAggression: {
    name: 'ddAggression',
    label: 'DD Aggression',
    type: 'strategy',
    range: [0, 1],
    defaultValue: 0.75,
    unit: '%',
    format: pct,
    toParams: (frac) => {
      return { sim: { ddWagerFraction: frac, ddStrategy: 'aggressive' as const } };
    },
  },
  opponentStrength: {
    name: 'opponentStrength',
    label: 'Opponent Strength',
    type: 'environment',
    range: [0, 1],
    defaultValue: 0.0,
    unit: '%',
    format: pct,
    toParams: (strength) => {
      return { opponentProfile: interpolateOpponent(strength) };
    },
  },
  precision: {
    name: 'precision',
    label: 'Precision (% correct when buzzing)',
    type: 'player',
    range: [0, 1],
    defaultValue: 0.75,
    unit: '%',
    format: pct,
    // Sets Player.p directly — independent of buzz attempt rate (b), the
    // conflation this candidate exists to remove. `b` comes from whatever
    // else pins it (default knowledge composite, or buzzAttemptRate when
    // that's the other axis).
    toParams: (p) => ({ player: { p } }),
  },
  buzzRaceWinPct: {
    name: 'buzzRaceWinPct',
    label: 'Buzz-Race Win % (vs. the field)',
    type: 'player',
    // Honest range: ends at the calibrated maximum (~66% — see the
    // calibration comment above), not a fake 100% the model can't reach.
    range: [0, buzzSpeedToWinPct(1)],
    defaultValue: buzzSpeedToWinPct(0.5),
    unit: '%',
    format: pct,
    // No closed-form inverse — routes through the calibration curve above.
    toParams: (winPct) => ({ player: { buzzerSpeed: winPctToBuzzSpeed(winPct) } }),
  },
  buzzAttemptRate: {
    name: 'buzzAttemptRate',
    label: 'Buzz Attempt Rate',
    type: 'player',
    range: [0, 1],
    defaultValue: 0.55,
    unit: '%',
    format: pct,
    // Sets Player.b directly — the other half of the attempt/success split.
    toParams: (b) => ({ player: { b } }),
  },
  expectedCoryat: {
    name: 'expectedCoryat',
    label: 'Expected Coryat Score',
    type: 'player',
    range: [0, 30000],
    defaultValue: 11000,
    unit: '$',
    format: dollars,
    // Given a target Coryat and whatever pins buzzAttemptRate (b), solve
    // for precision (p) so b × p × CORYAT_SCALE ≈ coryat. See the
    // calibration comment above CORYAT_SCALE.
    toParams: (coryat, pinned) => {
      const b = pinned.buzzAttemptRate ?? DIMENSIONS.buzzAttemptRate.defaultValue;
      const p = clamp(coryat / (CORYAT_SCALE * Math.max(b, 0.05)), 0, 0.98);
      return { player: { p } };
    },
  },
  squareSelection: {
    name: 'squareSelection',
    label: 'Square Selection (DD seeking)',
    type: 'strategy',
    // A two-valued strategy on the registry's numeric axis shape: values
    // below 0.5 play top-down ('default'), 0.5 and above hunt Daily
    // Doubles ('ddSeek', Tesauro 2012's p_DD + 0.1·p_RC rule). Swept as
    // an axis it renders as two bands; pinned it is a toggle. Default 0
    // keeps every existing sweep on the regression-locked 'default' order.
    // Not in any preset's pinnedDims, so it applies only when explicitly
    // chosen as an axis (buildSimParams ignores inactive pinned dims).
    range: [0, 1],
    defaultValue: 0,
    unit: '',
    format: (v) => (v >= 0.5 ? 'DD seeking' : 'Top-down'),
    toParams: (v) => ({ sim: { squareSelection: v >= 0.5 ? 'ddSeek' : 'default' } }),
  },
};

// ─── Axis Presets (P-1) ────────────────────────────────────────────

export interface AxisPreset {
  id: 'A' | 'B' | 'C';
  label: string;
  description: string;
  xAxis: DimensionName;
  yAxis: DimensionName;
  /** Which non-axis dims are meaningful pinned controls under this preset.
   *  Dims NOT listed here neither render as sliders nor apply in
   *  buildSimParams — several dims write the same Player fields (e.g.
   *  'knowledge' writes b AND p; 'buzzRaceWinPct' writes buzzerSpeed), so
   *  letting every non-axis dim apply its default would silently clobber
   *  the visible pinned sliders. */
  pinnedDims: DimensionName[];
}

export const AXIS_PRESETS: AxisPreset[] = [
  {
    id: 'A',
    label: 'A · Interpretable',
    description: 'X = precision (% correct when you buzz). Y = buzz-race win % vs the field.',
    xAxis: 'precision',
    yAxis: 'buzzRaceWinPct',
    // p from X, buzzerSpeed from Y (inverse calibration) → b still needs
    // a source: buzzAttemptRate, pinned.
    pinnedDims: ['buzzAttemptRate', 'ddAggression', 'opponentStrength'],
  },
  {
    id: 'B',
    label: 'B · Actionable',
    description: 'X = knowledge (buzz rate × accuracy). Y = buzzer speed.',
    xAxis: 'knowledge',
    yAxis: 'buzzerSpeed',
    // The pre-P-1 layout, unchanged: axes write all Player fields.
    pinnedDims: ['ddAggression', 'opponentStrength'],
  },
  {
    id: 'C',
    label: 'C · Coryat',
    description: 'X = expected Coryat score. Y = buzz attempt rate.',
    xAxis: 'expectedCoryat',
    yAxis: 'buzzAttemptRate',
    // b from Y, p solved from X given b → buzzerSpeed still needs a
    // source: pinned.
    pinnedDims: ['buzzerSpeed', 'ddAggression', 'opponentStrength'],
  },
];

/** The original four dims — the fallback pinned set for axis pairs that
 *  don't match any preset (custom combos via the axis popover). Keeps
 *  pre-P-1 behavior exactly for all pre-P-1 axis pairs. */
const LEGACY_DIMS: DimensionName[] = ['knowledge', 'buzzerSpeed', 'ddAggression', 'opponentStrength'];

/** Find the preset (if any) whose axes match the given pair. */
export function findPresetForAxes(xAxis: DimensionName, yAxis: DimensionName): AxisPreset | undefined {
  return AXIS_PRESETS.find(p => p.xAxis === xAxis && p.yAxis === yAxis);
}

/**
 * Pinned dims that both RENDER as controls and APPLY in buildSimParams
 * for the given axis pair. Single source of truth shared by
 * ControlsPanel, GamesControls, MarginalReturns, and buildSimParams.
 */
export function getPinnedDimNames(xAxis: DimensionName, yAxis: DimensionName): DimensionName[] {
  const preset = findPresetForAxes(xAxis, yAxis);
  const base = preset ? preset.pinnedDims : LEGACY_DIMS;
  return base.filter(d => d !== xAxis && d !== yAxis);
}

// ─── Famous player positions (per-candidate axis lookup) ───────────

/**
 * Resolve a famous player's position on an arbitrary axis dimension.
 *
 * The legacy dims (knowledge/buzzerSpeed/ddAggression/opponentStrength)
 * read straight from `player.positions` (unchanged). The P-1 candidate
 * dims are derived from the same underlying `accuracy`/`buzzIn` fields
 * already on FamousPlayer (opponent-models.ts is out of this work item's
 * file zone, so we derive rather than add new fields there):
 *   - precision        → player.accuracy directly (it already IS precision)
 *   - buzzAttemptRate   → player.buzzIn directly (it already IS attempt rate)
 *   - buzzRaceWinPct    → player.buzzIn run through the calibration curve
 *   - expectedCoryat    → hardcoded real Coryat estimates (CORYAT_ESTIMATES)
 *
 * Returns undefined when the position is unknown for this axis — callers
 * (HeatMap) hide the player rather than guess.
 */
export function getFamousPlayerPosition(player: FamousPlayer, dim: DimensionName): number | undefined {
  switch (dim) {
    case 'precision':
      return player.accuracy;
    case 'buzzAttemptRate':
      return player.buzzIn;
    case 'buzzRaceWinPct':
      return player.buzzIn !== undefined ? buzzSpeedToWinPct(player.buzzIn) : undefined;
    case 'expectedCoryat':
      return CORYAT_ESTIMATES[player.name];
    default:
      return player.positions[dim];
  }
}

// ─── Parameter Builder ─────────────────────────────────────────────

/**
 * Merge axis values + pinned values → complete simulation parameters.
 *
 * Builds a Player, SimConfig, and opponentProfile from whatever
 * combination of axes and pinned dimensions is active.
 */
export function buildSimParams(
  xAxis: DimensionName,
  yAxis: DimensionName,
  xVal: number,
  yVal: number,
  pinned: Record<string, number>,
): { player: Player; config: SimConfig; opponentProfile: { b: number; p: number; fjAccuracy: number } } {
  // Start with defaults
  let player: Player = playerFrom2Axis(
    pinned.knowledge ?? DIMENSIONS.knowledge.defaultValue,
    pinned.buzzerSpeed ?? DIMENSIONS.buzzerSpeed.defaultValue,
  );
  let config: SimConfig = { ...DEFAULT_CONFIG };
  let opponentProfile = { ...OPPONENT_PROFILES.average };

  // Build a complete pinned map with defaults for any missing values
  const fullPinned: Record<string, number> = {};
  for (const [name, dim] of Object.entries(DIMENSIONS)) {
    if (name === xAxis || name === yAxis) continue;
    fullPinned[name] = pinned[name] ?? dim.defaultValue;
  }
  // Also include axis values so toParams can reference them
  fullPinned[xAxis] = xVal;
  fullPinned[yAxis] = yVal;

  // Only the pinned dims meaningful for this axis pair actually APPLY
  // (getPinnedDimNames). Several dims write the same Player fields — e.g.
  // pinned 'buzzRaceWinPct' writes buzzerSpeed and would clobber a pinned
  // 'buzzerSpeed' slider under preset C if every non-axis dim applied its
  // default. For pre-P-1 axis pairs the active set equals the old "all
  // non-axis dims" set, so legacy behavior is unchanged.
  //
  // Order: pinned dims FIRST, axes LAST. Axes are the user's explicit
  // selection and must win any field overlap (e.g. pinned 'knowledge'
  // writes b AND p; an axis like 'precision' that writes only p must not
  // be clobbered by a later composite write).
  const activePinned = new Set<string>(getPinnedDimNames(xAxis, yAxis));
  const allDims: [string, number][] = [
    ...Object.entries(fullPinned).filter(([name]) => activePinned.has(name)),
    [xAxis, xVal],
    [yAxis, yVal],
  ];

  for (const [name, value] of allDims) {
    const dim = DIMENSIONS[name as DimensionName];
    if (!dim) continue;

    const params = dim.toParams(value, fullPinned);
    if (params.player) {
      player = { ...player, ...params.player };
    }
    if (params.sim) {
      config = { ...config, ...params.sim };
    }
    if (params.opponentProfile) {
      opponentProfile = { ...opponentProfile, ...params.opponentProfile };
    }
  }

  return { player, config, opponentProfile };
}
