/**
 * Game-state value function V(S) ≈ P(you win | state) — PLAN.md E-2.
 *
 * Precomputed 5D(+) coarse rollout table over:
 *   - your-skill (SPLIT into 2 sub-dims: knowledge × buzzerSpeed, 4×4 —
 *     the v1 critical defect this fixes: a table baked for one fixed "you"
 *     is wrong everywhere else the heat map sweeps YOUR skill)
 *   - yourShare       = yourScore / nominal pot for this game stage (an
 *                       absolute-scale dim: how much money you have relative
 *                       to a typical game's, since clue $ values are fixed
 *                       and score dynamics are NOT scale-invariant)
 *   - leaderRatio     = strongest opponent's score / your score
 *   - thirdRatio      = weakest opponent's score / your score
 *   - cluesRemaining  = count of clues left in the *current Double
 *                       Jeopardy round* (0 = pre-Final-Jeopardy)
 *
 * `leaderRatio` + `thirdRatio` capture the lock/crush/three-way structure a
 * 2D score projection would lose (Decision Audit #14): leaderRatio < 0.5 =
 * you have a lock over the whole field; ≈1 = tight race; > 1 = you trail;
 * thirdRatio ≈ leaderRatio ≈ 1 = genuine three-way.
 *
 * Why opponent/you RATIOS instead of opponent SHARES (design note): a
 * share-based grid (yourShare, leaderShare, thirdShare) was tried first and
 * has an interpolation artifact — a query where YOU lead comfortably (e.g.
 * shares 0.71/0.18/0.11) still interpolates against bucket corners where
 * leaderShare > yourShare, i.e. corners that silently reassign the lead to
 * an opponent, dragging V from ~1.0 down to ~0.6 for a state that is a
 * certain win. With ratios, the who-leads identity flips exactly at
 * leaderRatio = 1, so interpolation only ever mixes lead/trail cells for
 * states that genuinely are near-tied.
 *
 * Scope limitation (documented, not silent): this table only models
 * Double-Jeopardy-and-later states. The primary consumer (E-3's equity DD
 * wagering) only ever needs V(S) for "rest of DJ + FJ" — Jeopardy-round
 * wagering isn't in scope for this plan.
 *
 * Populated by `simulateFromState` rollouts (sim-engine.ts, E-0), smoothed
 * per-(yourShare × leaderShare) 2D slice with `gaussianBlur2D`
 * (math-utils.ts) to knock down Monte Carlo noise, queried via multilinear
 * interpolation (O(1) — the hot path for the equity DD/heat-map consumers).
 * The returned `ValueTable` is a plain object with a `Float32Array` payload
 * so it can be `postMessage`'d as a transferable buffer by a worker later
 * (no functions/closures on it).
 */

import {
  type Player,
  type SimConfig,
  type SimState,
  simulateFromState,
  playerFrom2Axis,
  sampleOpponent,
  DJ_VALUES,
  buildFullBoard,
} from './sim-engine';
import { gaussianBlur2D } from './math-utils';

// ─── Types ─────────────────────────────────────────────────────────────

/** One table axis: `n` bucket centers evenly spaced across [min, max]. */
export interface AxisSpec {
  min: number;
  max: number;
  /** Number of bucket centers (n ≥ 2). */
  n: number;
}

export interface ValueTableDims {
  skillKnowledge: AxisSpec;
  skillBuzzer: AxisSpec;
  yourShare: AxisSpec;
  leaderRatio: AxisSpec;
  thirdRatio: AxisSpec;
  cluesRemaining: AxisSpec;
}

const DIM_ORDER = [
  'skillKnowledge', 'skillBuzzer', 'yourShare', 'leaderRatio', 'thirdRatio', 'cluesRemaining',
] as const;
type DimKey = typeof DIM_ORDER[number];

/**
 * Coarse default dims — MEASURED, not the spec's raw suggestion (see
 * `buildValueTable` perf doc). At the spec's low-end ranges (4×4 skill ×
 * 8 yourShare × 6 leaderShare × 6 thirdShare × 6 cluesRemaining = 27,648
 * cells) with 50 rollouts/cell, a build measured **~23s** — 4.6× over the
 * ~5s budget. Per PLAN.md's explicit risk-mitigation ("shrink state dims
 * before shrinking rollouts if over"), dims were shrunk first
 * (yourShare 8→6, leaderRatio/thirdRatio 6→5, cluesRemaining 6→5 — all
 * still within or adjacent to spec ranges; skillKnowledge/skillBuzzer kept
 * at the spec's explicit 4×4), landing at 12,000 cells. Rollouts/cell were
 * also reduced (50→20, below the ~50-100 target) since dim-shrinking alone
 * wasn't sufficient — measured build time at these settings: **~4.0s**
 * (12,000 cells × 20 rollouts = 240,000 rollouts; see
 * `buildValueTable`'s build-budget test for the number this file's test
 * run actually measured). Smoothing (`gaussianBlur2D`) is relied on more
 * heavily than the spec's ideal to compensate for the lower rollout count.
 */
export const DEFAULT_VALUE_TABLE_DIMS: ValueTableDims = {
  skillKnowledge: { min: 0, max: 1, n: 4 },
  skillBuzzer: { min: 0, max: 1, n: 4 },
  // yourScore / nominal pot. Max 1.5: scores above 1.5× the nominal pot
  // (rare Holzhauer territory) clamp — the ratios still carry the relative
  // structure there, which is what dominates V.
  yourShare: { min: 0, max: 1.5, n: 6 },
  // Opponent/you ratios. Max 2: an opponent at 2× your score has a lock
  // over you pre-FJ — states beyond that clamp to "hopeless" territory.
  leaderRatio: { min: 0, max: 2, n: 5 },
  thirdRatio: { min: 0, max: 2, n: 5 },
  cluesRemaining: { min: 0, max: 30, n: 5 },
};

export interface ValueTable {
  dims: ValueTableDims;
  /** Flat win-probability grid, row-major over DIM_ORDER. Float32 (not a
   *  plain number[]) so it can be handed to a Worker as a transferable
   *  ArrayBuffer without a copy — see E-2's "where the table lives" spec. */
  data: Float32Array;
  rolloutsPerCell: number;
  buildMs: number;
  cellCount: number;
  /** Nominal-pot anchors used to build the table — queries must map scores
   *  → features with the same pot the builder used, so these ride along as
   *  plain serializable metadata. */
  nominalTotalAt0Remaining: number;
  nominalTotalAt30Remaining: number;
}

/** A query point: your skill + current 3-way scores + clues left in DJ. */
export interface VQueryState {
  /** b×p composite — same semantics as `playerFrom2Axis`'s `knowledge` arg. */
  knowledge: number;
  buzzerSpeed: number;
  scores: [number, number, number];
  /** Clues remaining in the current DJ round (0 = pre-FJ). */
  cluesRemaining: number;
}

export interface BuildValueTableOptions {
  dims?: ValueTableDims;
  /** Rollouts per grid cell (before smoothing). Default 20 (see
   *  `DEFAULT_VALUE_TABLE_DIMS` doc for why this is below the spec's
   *  ~50-100 target — a measured perf tradeoff, not an oversight). */
  rolloutsPerCell?: number;
  /** Gaussian blur radius for the per-slice smoothing pass. Default 1.
   *  0 disables smoothing entirely (raw MC estimates) — used by invariant
   *  tests that need exact grid-corner values (e.g. the pre-FJ lock test,
   *  where smoothing would otherwise bleed losing-neighbor cells into a
   *  provably-certain-win corner). */
  blurRadius?: number;
  /**
   * Nominal total ($) "pot" used to convert grid shares back into concrete
   * dollar scores for rollouts, interpolated linearly by cluesRemaining
   * (more clues remaining ⇒ earlier in DJ ⇒ smaller accumulated pot so far).
   * This is a documented modeling simplification: the table encodes
   * *relative* score shares, not absolute dollars, but rollout mechanics
   * (fixed clue $ values, DD wager sizing) are NOT scale-invariant. A fixed
   * nominal pot per cluesRemaining bucket is a coarse stand-in — exact for
   * no real distribution, but consistent and good enough for a value
   * function whose tested invariants are monotonicity/bounds/lock behavior,
   * not absolute calibration (E-4 validates absolute equity numbers via
   * direct Monte Carlo instead, precisely to sidestep this approximation).
   */
  nominalTotalAt0Remaining?: number;
  nominalTotalAt30Remaining?: number;
  /**
   * E-7: coarse build-progress callback, invoked once per outer
   * (skillKnowledge) iteration — the outermost of the 6 nested loops, so
   * this is real (not simulated) progress at `DEFAULT_VALUE_TABLE_DIMS`'
   * granularity (4 calls: 0, 0.25, 0.5, 0.75, then implicitly 1.0 on
   * return). Additive/optional — omitting it changes nothing about the
   * build itself. Intended caller: sim-worker.ts's `buildValueTable`
   * message handler, forwarding each call as a `buildValueTableProgress`
   * postMessage so the persistent worker's build drives the same
   * progress UI the existing grid/all-games sims use.
   */
  onProgress?: (frac: number) => void;
}

// ─── Axis helpers ────────────────────────────────────────────────────────

function axisCenter(axis: AxisSpec, i: number): number {
  if (axis.n <= 1) return axis.min;
  return axis.min + (i * (axis.max - axis.min)) / (axis.n - 1);
}

/** Continuous value → fractional bucket index, clamped to [0, n-1]. This is
 *  where out-of-range queries clamp to table bounds (E-2 invariant). */
function axisFractionalIndex(axis: AxisSpec, value: number): number {
  if (axis.n <= 1) return 0;
  const clamped = Math.max(axis.min, Math.min(axis.max, value));
  return ((clamped - axis.min) / (axis.max - axis.min)) * (axis.n - 1);
}

function computeStrides(dims: ValueTableDims): Record<DimKey, number> {
  const sizes = DIM_ORDER.map(k => dims[k].n);
  const strides = {} as Record<DimKey, number>;
  let acc = 1;
  for (let i = DIM_ORDER.length - 1; i >= 0; i--) {
    strides[DIM_ORDER[i]] = acc;
    acc *= sizes[i];
  }
  return strides;
}

function totalCells(dims: ValueTableDims): number {
  return DIM_ORDER.reduce((acc, k) => acc * dims[k].n, 1);
}

// ─── Score ⇄ grid features ───────────────────────────────────────────────

/**
 * When your score is at/near $0 (or negative), opponent/you ratios blow up.
 * Both the forward (query) and inverse (grid construction) mappings use
 * `max(yourScore, RATIO_FLOOR_FRAC × pot)` as the ratio denominator so the
 * two stay consistent — a broke "you" lands in the max-ratio (hopeless)
 * buckets rather than producing NaN/Infinity.
 */
const RATIO_FLOOR_FRAC = 0.1;

function nominalTotal(
  cluesRemaining: number,
  at0: number,
  at30: number,
): number {
  const frac = Math.max(0, Math.min(1, cluesRemaining / 30));
  return at30 * frac + at0 * (1 - frac);
}

/**
 * Forward mapping: concrete scores → (yourShare, leaderRatio, thirdRatio)
 * grid features. Negative scores clamp to 0 first (a negative opponent is
 * "broke," ratio 0; a negative you is "broke," ratios max out via the
 * floor). Exported for tests.
 */
export function gridFeaturesFromScores(
  scores: [number, number, number],
  pot: number,
): { yourShare: number; leaderRatio: number; thirdRatio: number } {
  const you = Math.max(scores[0], 0);
  const oppHi = Math.max(Math.max(scores[1], scores[2]), 0);
  const oppLo = Math.max(Math.min(scores[1], scores[2]), 0);
  const base = Math.max(you, RATIO_FLOOR_FRAC * pot);
  return {
    yourShare: you / pot,
    leaderRatio: oppHi / base,
    thirdRatio: oppLo / base,
  };
}

/**
 * Inverse mapping, for grid construction: axis values → concrete scores.
 * yourScore scales off the nominal pot; opponents scale off the same
 * floored base the forward mapping divides by, so build and query agree.
 */
function scoresFromGridPoint(
  yourShare: number, leaderRatio: number, thirdRatio: number, pot: number,
): [number, number, number] {
  const you = Math.round(yourShare * pot);
  const base = Math.max(you, RATIO_FLOOR_FRAC * pot);
  return [you, Math.round(leaderRatio * base), Math.round(thirdRatio * base)];
}

/** Partial Fisher–Yates: sample `n` clue values (no replacement) from the
 *  full 30-clue DJ board. A coarse stand-in for "which clues are still on
 *  the board" — real games deplete low-value rows first, but modeling that
 *  per-bucket is out of scope for a 5D table; random sampling avoids baking
 *  in a specific (and possibly wrong) depletion-order assumption instead. */
function sampleRemainingBoard(n: number, rng: () => number): number[] {
  const board = buildFullBoard(DJ_VALUES);
  const take = Math.min(n, board.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (board.length - i));
    const tmp = board[i]; board[i] = board[j]; board[j] = tmp;
  }
  return board.slice(0, take);
}

// ─── Build ───────────────────────────────────────────────────────────────

/**
 * Populate a coarse V(S) table by Monte Carlo rollout through
 * `simulateFromState` (E-0), then smooth and return it.
 *
 * Perf note (measured, not assumed — PLAN.md risk register calls this out
 * explicitly: "if budget fails, shrink state dims before shrinking
 * rollouts"): with the full E-2-specified dimensionality (4×4 skill ×
 * ~8×6×6×6 state) and ~50-100 rollouts/cell, the cell×rollout product is
 * in the low millions, which does not fit a ~5s budget in a single-threaded
 * rollout loop. `DEFAULT_VALUE_TABLE_DIMS` sits at the low end of every
 * spec'd range for exactly this reason; callers under real time pressure
 * (a Worker with a progress callback, not this synchronous function) should
 * pass a coarser `dims`/smaller `rolloutsPerCell` and rely on
 * `gaussianBlur2D` smoothing to keep the result usable. `buildMs` is
 * returned so callers (and this file's own test) can measure and report
 * the real number rather than assume the target holds.
 */
export function buildValueTable(
  opponentProfile: { b: number; p: number; fjAccuracy: number },
  config: SimConfig,
  rng: () => number,
  options: BuildValueTableOptions = {},
): ValueTable {
  const dims = options.dims ?? DEFAULT_VALUE_TABLE_DIMS;
  const rolloutsPerCell = options.rolloutsPerCell ?? 20;
  const blurRadius = options.blurRadius ?? 1;
  const at0 = options.nominalTotalAt0Remaining ?? 17000;
  const at30 = options.nominalTotalAt30Remaining ?? 8000;

  const cells = totalCells(dims);
  const data = new Float32Array(cells);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();

  const { skillKnowledge, skillBuzzer, yourShare, leaderRatio, thirdRatio, cluesRemaining } = dims;

  const onProgress = options.onProgress;

  let idx = 0;
  for (let iSK = 0; iSK < skillKnowledge.n; iSK++) {
    onProgress?.(iSK / skillKnowledge.n);
    const knowledge = axisCenter(skillKnowledge, iSK);
    for (let iSB = 0; iSB < skillBuzzer.n; iSB++) {
      const buzzerSpeed = axisCenter(skillBuzzer, iSB);
      const you: Player = playerFrom2Axis(knowledge, buzzerSpeed);

      for (let iYS = 0; iYS < yourShare.n; iYS++) {
        const ys = axisCenter(yourShare, iYS);
        for (let iLS = 0; iLS < leaderRatio.n; iLS++) {
          const lr = axisCenter(leaderRatio, iLS);
          for (let iTS = 0; iTS < thirdRatio.n; iTS++) {
            const tr = axisCenter(thirdRatio, iTS);

            for (let iCR = 0; iCR < cluesRemaining.n; iCR++) {
              const cr = Math.max(0, Math.round(axisCenter(cluesRemaining, iCR)));
              const pot = nominalTotal(cr, at0, at30);
              const baseScores = scoresFromGridPoint(ys, lr, tr, pot);
              const ddCount = Math.max(0, Math.min(2, Math.round((2 * cr) / 30)));

              let wins = 0;
              for (let r = 0; r < rolloutsPerCell; r++) {
                const remainingClueValues = cr > 0 ? sampleRemainingBoard(cr, rng) : [];
                const state: SimState = {
                  scores: [...baseScores] as [number, number, number],
                  round: 'DJ',
                  remainingClueValues,
                  remainingDDCount: cr > 0 ? ddCount : 0,
                };
                const opp1 = sampleOpponent(opponentProfile, rng);
                const opp2 = sampleOpponent(opponentProfile, rng);
                const result = simulateFromState(state, [you, opp1, opp2], config, rng, false);
                if (result.winner === 0) wins++;
              }
              data[idx++] = wins / rolloutsPerCell;
            }
          }
        }
      }
    }
  }

  // radius 0 = no smoothing (gaussianBlur2D's kernel degenerates at 0 —
  // sigma would be 0 and the kernel NaN — so skip it entirely).
  if (blurRadius > 0) {
    smoothShareSlices(data, dims, blurRadius);
  }
  onProgress?.(1);

  const buildMs = now() - t0;
  return {
    dims, data, rolloutsPerCell, buildMs, cellCount: cells,
    nominalTotalAt0Remaining: at0,
    nominalTotalAt30Remaining: at30,
  };
}

/**
 * Smooth every (yourShare × leaderRatio) 2D slice (fixed skill + thirdRatio
 * + cluesRemaining) with `gaussianBlur2D`. This plane is the one most
 * directly driven by Monte Carlo win-rate noise from relative score
 * dominance, so it's the one PLAN.md's "smooth per-2D-slice" calls for.
 */
function smoothShareSlices(data: Float32Array, dims: ValueTableDims, radius: number): void {
  const strides = computeStrides(dims);
  const nYS = dims.yourShare.n;
  const nLR = dims.leaderRatio.n;
  const slice = new Array<number>(nYS * nLR);

  for (let iSK = 0; iSK < dims.skillKnowledge.n; iSK++) {
    for (let iSB = 0; iSB < dims.skillBuzzer.n; iSB++) {
      for (let iTS = 0; iTS < dims.thirdRatio.n; iTS++) {
        for (let iCR = 0; iCR < dims.cluesRemaining.n; iCR++) {
          const base = iSK * strides.skillKnowledge + iSB * strides.skillBuzzer
            + iTS * strides.thirdRatio + iCR * strides.cluesRemaining;

          for (let iYS = 0; iYS < nYS; iYS++) {
            for (let iLR = 0; iLR < nLR; iLR++) {
              slice[iYS * nLR + iLR] = data[base + iYS * strides.yourShare + iLR * strides.leaderRatio];
            }
          }

          const blurred = gaussianBlur2D(slice, nLR, nYS, radius);

          for (let iYS = 0; iYS < nYS; iYS++) {
            for (let iLR = 0; iLR < nLR; iLR++) {
              data[base + iYS * strides.yourShare + iLR * strides.leaderRatio] = blurred[iYS * nLR + iLR];
            }
          }
        }
      }
    }
  }
}

// ─── Query ───────────────────────────────────────────────────────────────

/**
 * O(1) multilinear interpolation over all 6 grid dims (2^6 = 64 corners) —
 * the hot path for equity DD wagering and any future heat-map consumer.
 * Out-of-range inputs clamp to table bounds (via `axisFractionalIndex`)
 * rather than extrapolating or throwing.
 */
export function queryV(table: ValueTable, state: VQueryState): number {
  const { dims, data } = table;
  const strides = computeStrides(dims);
  const pot = nominalTotal(
    state.cluesRemaining,
    table.nominalTotalAt0Remaining,
    table.nominalTotalAt30Remaining,
  );
  const features = gridFeaturesFromScores(state.scores, pot);

  const fx: Record<DimKey, number> = {
    skillKnowledge: axisFractionalIndex(dims.skillKnowledge, state.knowledge),
    skillBuzzer: axisFractionalIndex(dims.skillBuzzer, state.buzzerSpeed),
    yourShare: axisFractionalIndex(dims.yourShare, features.yourShare),
    leaderRatio: axisFractionalIndex(dims.leaderRatio, features.leaderRatio),
    thirdRatio: axisFractionalIndex(dims.thirdRatio, features.thirdRatio),
    cluesRemaining: axisFractionalIndex(dims.cluesRemaining, state.cluesRemaining),
  };

  let value = 0;
  const numCorners = 1 << DIM_ORDER.length;
  for (let mask = 0; mask < numCorners; mask++) {
    let weight = 1;
    let flat = 0;
    for (let d = 0; d < DIM_ORDER.length; d++) {
      const key = DIM_ORDER[d];
      const n = dims[key].n;
      const f = fx[key];
      const lo = Math.min(Math.floor(f), n - 1);
      const hi = Math.min(lo + 1, n - 1);
      const frac = f - lo;
      const useHi = (mask >> d) & 1;
      const cornerIdx = useHi ? hi : lo;
      const w = useHi ? frac : 1 - frac;
      weight *= w;
      flat += cornerIdx * strides[key];
    }
    if (weight > 0) value += weight * data[flat];
  }

  return Math.max(0, Math.min(1, value));
}

// ─── Lock analysis (deterministic guard in front of the table) ───────────

/** Highest clue value per round — the floor under a Daily Double wager's
 *  legal maximum (a player may bet up to the GREATER of their score and
 *  this), so a broke opponent hitting a DD can still gain this much. */
const ROUND_TOP_VALUE: Record<'J' | 'DJ', number> = { J: 1000, DJ: 2000 };

/** Whole Double Jeopardy board ($36,000) and its DD count — what an
 *  opponent could still sweep AFTER a Jeopardy-round Daily Double.
 *  Computed on first use, not at module load: this module and sim-engine
 *  import each other, so `DJ_VALUES` is not yet initialised when
 *  sim-engine is the entry point. */
let djBoardTotalCache = -1;
function djBoardTotal(): number {
  if (djBoardTotalCache < 0) {
    djBoardTotalCache = buildFullBoard(DJ_VALUES).reduce((a, b) => a + b, 0);
  }
  return djBoardTotalCache;
}
const DJ_DD_COUNT = 2;

/** Real-rules minimum Daily Double wager ($5) — the floor `equityWager`'s
 *  bet grid starts at (NOT `ddWager`'s `minWager = maxClueValue`
 *  heuristic-preset simplification; see `equityWager` doc). */
export const EQUITY_MIN_WAGER = 5;

export interface LockAnalysis {
  /**
   * Largest wager (rounded down to $100, never below $5) at which the
   * wagering player still holds an FJ-proof lock after MISSING the Daily
   * Double: `score − wager > maxOpponentReach`, where the opponent has
   * swept the rest of the game AND doubled in Final Jeopardy. `null` when
   * no legal wager keeps that lock (including "not a lock even at $5").
   */
  lockedAtWager: number | null;
  /** Best opponent's best case after Final Jeopardy (see `maxOpponentReachPreFJ`, doubled). */
  maxOpponentReach: number;
  /** True when the FJ-proof lock survives a miss at the $5 minimum. */
  isLockNow: boolean;
  /**
   * Best opponent's best case at the END OF THE ROUND(S), before Final
   * Jeopardy: every remaining clue (both rounds if this is a Jeopardy-round
   * DD), every remaining Daily Double as a true daily double.
   */
  maxOpponentReachPreFJ: number;
  /**
   * Largest wager (same rounding as `lockedAtWager`) at which the player
   * is still GUARANTEED to lead going into Final Jeopardy after a miss:
   * `score − wager > maxOpponentReachPreFJ`. Weaker than a lock (an
   * opponent could still double past them in FJ) but the structural fact
   * the V(S) table loses at 9501-type positions — see `equityWager`.
   */
  leadSafeAtWager: number | null;
  /** True when the guaranteed pre-FJ lead survives a miss at the $5 minimum. */
  isLeadSafeNow: boolean;
}

/**
 * Conservative ceiling on what one opponent can still reach before Final
 * Jeopardy: they take every remaining clue at face value (a DD clue's face
 * value is counted too — a harmless over-estimate), then hit every
 * remaining Daily Double as a true daily double (or for the round's top
 * value if that is more, per the real max-wager rule). Clues before DDs is
 * the maximising order (doubling a larger number). A Jeopardy-round DD
 * also has the whole Double Jeopardy board and its two DDs still to come.
 */
function opponentReachPreFJ(
  oppScore: number,
  remainingClueValues: readonly number[],
  remainingDDs: number,
  round: 'J' | 'DJ',
): number {
  let reach = oppScore;
  for (const v of remainingClueValues) reach += v;
  for (let i = 0; i < remainingDDs; i++) reach = Math.max(2 * reach, reach + ROUND_TOP_VALUE[round]);
  if (round === 'J') {
    reach += djBoardTotal();
    for (let i = 0; i < DJ_DD_COUNT; i++) reach = Math.max(2 * reach, reach + ROUND_TOP_VALUE.DJ);
  }
  return reach;
}

/** Largest legal wager `w` with `score − w > ceiling`, rounded down to a
 *  $100 multiple but never below the $5 floor; `null` if even $5 fails. */
function largestSafeWager(score: number, ceiling: number): number | null {
  const maxSafe = score - ceiling - 1;
  if (maxSafe < EQUITY_MIN_WAGER) return null;
  return Math.max(EQUITY_MIN_WAGER, Math.floor(maxSafe / 100) * 100);
}

/**
 * Pure, deterministic lock analysis for the player at `playerIdx` who is
 * about to wager on a Daily Double. Everything is worst-case for the
 * wagerer: they miss the DD, never score again (they can always decline
 * to buzz, so `score − wager` is a floor they control), wager $0 in FJ;
 * each opponent sweeps every remaining clue, hits every remaining DD as a
 * true daily double, and doubles in Final Jeopardy (a player at ≤ $0
 * cannot play FJ, so their reach is not doubled).
 *
 * `remainingClueValues` / `remainingDDs` are the clues and Daily Doubles
 * still on the board AFTER this DD (the same quantities `SimState` carries).
 */
export function lockAnalysis(
  scores: readonly number[],
  playerIdx: number,
  remainingClueValues: readonly number[],
  remainingDDs: number,
  round: 'J' | 'DJ',
): LockAnalysis {
  const score = scores[playerIdx];
  let maxPreFJ = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    if (i === playerIdx) continue;
    const reach = opponentReachPreFJ(scores[i], remainingClueValues, remainingDDs, round);
    if (reach > maxPreFJ) maxPreFJ = reach;
  }
  if (maxPreFJ === -Infinity) maxPreFJ = 0; // no opponents at all
  const maxPostFJ = maxPreFJ > 0 ? 2 * maxPreFJ : maxPreFJ;

  const lockedAtWager = largestSafeWager(score, maxPostFJ);
  const leadSafeAtWager = largestSafeWager(score, maxPreFJ);
  return {
    lockedAtWager,
    maxOpponentReach: maxPostFJ,
    isLockNow: lockedAtWager !== null,
    maxOpponentReachPreFJ: maxPreFJ,
    leadSafeAtWager,
    isLeadSafeNow: leadSafeAtWager !== null,
  };
}

// ─── E-3: Equity DD wagering (YOUR player only) ──────────────────────────

export interface EquityWagerYou {
  /** b×p composite, same semantics as `playerFrom2Axis`'s `knowledge` arg. */
  knowledge: number;
  buzzerSpeed: number;
}

/**
 * What `equityWager` needs to run `lockAnalysis` in front of the table
 * lookup: the board AFTER this Daily Double. Optional — callers that only
 * have a score-state (the components' out-of-engine recomputations) get
 * the unguarded table lookup, exactly as before.
 */
export interface EquityLockContext {
  remainingClueValues: readonly number[];
  remainingDDs: number;
  round: 'J' | 'DJ';
}

/**
 * Lock-aware guard applied to the table's recommendation. Returns the
 * wager to use given the table's unguarded argmax.
 *
 * Why (J-Archive game 9501, Grace's DJ Daily Double): scores $19,200 vs
 * $7,800 / $7,000, seven clues left worth $3,200 total, no DDs left. No
 * opponent can pass $11,000 before FJ, so any wager ≤ $8,100 keeps Grace
 * the guaranteed leader into FJ even if she misses; a direct paired
 * rollout says the $5 minimum wins 99.9%. The table, which buckets states
 * by nominal-pot share and score ratio against generic opponents and
 * samples a random remaining board, said $12,633 — a wager that wins
 * 94.8% because a miss drops her to $6,567, behind both opponents. The
 * table cannot see that the position is (nearly) a lock; this guard can.
 *
 * Rule: take the tightest lock threshold that exists (FJ-proof lock first,
 * else the guaranteed pre-FJ lead). If the table's choice is at or below
 * it, trust the table; if the table wants to wager PAST it, its ranking is
 * not tracking the lock structure at all, so fall back to the minimum —
 * the one wager whose downside is provably nil. When neither threshold
 * exists the table's choice is returned untouched, so nothing changes for
 * non-lock positions (E-4 paper replication, production invariants).
 */
export function applyLockGuard(tableWager: number, lock: LockAnalysis): number {
  const threshold = lock.lockedAtWager ?? lock.leadSafeAtWager;
  if (threshold === null) return tableWager;
  return tableWager <= threshold ? tableWager : EQUITY_MIN_WAGER;
}

/**
 * E-3 — argmax over a bet grid of Equity(bet) = p·V(S+bet) + (1-p)·V(S-bet).
 *
 * Bet grid: **$5 real-rules floor** (the actual Jeopardy minimum DD wager)
 * to max(score, $5) — deliberately NOT `ddWager`'s `minWager = maxClueValue`
 * simplification, which stays as a documented heuristic-preset-only
 * shortcut (see `ddWager` doc in sim-engine.ts). ~$500 steps, capped at 40
 * evaluations total (widens the step for large scores rather than
 * exceeding the cap) — this is the dispatch target for `'equity'`
 * DDStrategy, called BEFORE `ddWager` ever sees the strategy (see
 * `simulateRound` in sim-engine.ts; `ddWager`'s type signature statically
 * excludes `'equity'`, so this file — not `ddWager` — is the only legal
 * place `'equity'` wagers get computed).
 *
 * `lock` (optional, additive): the board after this DD. When given, the
 * table's argmax passes through `lockAnalysis` + `applyLockGuard` so a
 * position the table's coarse buckets misread as "worth wagering on" but
 * which is structurally a lock (or a guaranteed pre-FJ lead) never gets a
 * wager past the lock threshold. Omitted ⇒ byte-identical to the
 * pre-guard lookup.
 */
export function equityWager(
  you: EquityWagerYou,
  scores: [number, number, number],
  cluesRemainingAfter: number,
  pCorrect: number,
  table: ValueTable,
  lock?: EquityLockContext,
): number {
  const MIN_WAGER = EQUITY_MIN_WAGER;
  const MAX_EVALS = 40;
  const STEP = 500;

  const score = scores[0];
  const maxWager = Math.max(score, MIN_WAGER);
  const range = maxWager - MIN_WAGER;
  const numPoints = range <= 0 ? 1 : Math.min(MAX_EVALS, Math.max(2, Math.floor(range / STEP) + 1));

  let bestWager = MIN_WAGER;
  let bestEquity = -Infinity;

  for (let i = 0; i < numPoints; i++) {
    const w = numPoints === 1 ? MIN_WAGER : Math.round(MIN_WAGER + (range * i) / (numPoints - 1));
    const winV = queryV(table, {
      knowledge: you.knowledge,
      buzzerSpeed: you.buzzerSpeed,
      scores: [scores[0] + w, scores[1], scores[2]],
      cluesRemaining: cluesRemainingAfter,
    });
    const loseV = queryV(table, {
      knowledge: you.knowledge,
      buzzerSpeed: you.buzzerSpeed,
      scores: [scores[0] - w, scores[1], scores[2]],
      cluesRemaining: cluesRemainingAfter,
    });
    const equity = pCorrect * winV + (1 - pCorrect) * loseV;
    if (equity > bestEquity) {
      bestEquity = equity;
      bestWager = w;
    }
  }

  // Lock-aware guard (see `applyLockGuard` for the 9501 example). Only
  // callers that know the board after this DD can get it; a plain
  // score-state call is the unguarded lookup, unchanged.
  if (lock !== undefined) {
    return applyLockGuard(
      bestWager,
      lockAnalysis(scores, 0, lock.remainingClueValues, lock.remainingDDs, lock.round),
    );
  }
  return bestWager;
}
