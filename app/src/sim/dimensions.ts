/**
 * Dimension configuration for N-dimensional strategy space.
 *
 * Shared between UI and Web Worker. Worker imports this module directly
 * and receives dimension NAMES (strings) via postMessage — functions
 * can't cross the structured clone boundary.
 */

import { playerFrom2Axis, DEFAULT_CONFIG, type Player, type SimConfig } from './sim-engine';
import { OPPONENT_PROFILES } from './opponent-models';

// ─── Types ─────────────────────────────────────────────────────────

export interface DimensionConfig {
  name: string;
  label: string;
  type: 'player' | 'strategy' | 'environment';
  range: [number, number];
  defaultValue: number;
  toParams: (value: number, pinned: Record<string, number>) => {
    player?: Partial<Player>;
    sim?: Partial<SimConfig>;
    opponentProfile?: { b: number; p: number; fjAccuracy: number };
  };
}

export type DimensionName = 'knowledge' | 'buzzerSpeed' | 'ddAggression' | 'opponentStrength';

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

// ─── Dimension Registry ────────────────────────────────────────────

export const DIMENSIONS: Record<DimensionName, DimensionConfig> = {
  knowledge: {
    name: 'knowledge',
    label: 'Knowledge (buzz rate × accuracy)',
    type: 'player',
    range: [0, 1],
    defaultValue: 0.4,
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
    toParams: (strength) => {
      return { opponentProfile: interpolateOpponent(strength) };
    },
  },
};

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

  // Apply all dimensions (axes + pinned)
  const allDims: [string, number][] = [
    [xAxis, xVal],
    [yAxis, yVal],
    ...Object.entries(fullPinned).filter(([name]) => name !== xAxis && name !== yAxis),
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
