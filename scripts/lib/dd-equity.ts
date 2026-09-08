/**
 * dd-equity.ts — exact-state Daily Double wager analysis by direct Monte
 * Carlo.
 *
 * The app's in-sim `equityWager` (app/src/sim/value-function.ts) reads a
 * coarse 6-D interpolated V(S) table, because it must return a wager inside
 * a hot simulation loop. For analyzing ONE real position offline there is no
 * such budget, so this module does the honest thing: roll the actual
 * remaining board forward thousands of times per candidate score. That
 * sidesteps every approximation the table makes (bucketed score ratios, a
 * nominal-pot stand-in for absolute dollars, a randomly sampled remaining
 * board) — see the "E-4 validates absolute equity via direct Monte Carlo
 * instead" note in value-function.ts.
 *
 * Two ideas make it cheap enough:
 *
 * 1. **Decomposition.** Equity(w) = p·V(S+w) + (1−p)·V(S−w) where V depends
 *    only on the RESULTING score. So V is evaluated once per grid score, and
 *    every candidate wager — and every value of p — is then free. A sweep
 *    over p costs nothing extra, which is what makes the break-even analysis
 *    possible.
 *
 * 2. **Common random numbers.** Grid point j uses seeds `baseSeed + i` for
 *    i = 0..N-1, the same list for every j. Neighbouring grid points then
 *    share their randomness, so the V curve is smooth and DIFFERENCES between
 *    wagers are far better resolved than each absolute level is. This is the
 *    quantity the argmax actually depends on.
 *
 * Ties are split (co-champion counts 0.5), matching the engine's documented
 * tie rule in `fjEquityGridSearch`.
 */

import {
  simulateFromState,
  simulateFinalJeopardy,
  mulberry32,
  type Player,
  type SimConfig,
  type SimState,
} from '../../app/src/sim/sim-engine';

// ─── Types ───────────────────────────────────────────────────────────────

export interface DDPosition {
  /** Scores at the moment the DD is revealed; index 0 = the wagering player. */
  scores: [number, number, number];
  /** Index 0 = the wagering player. */
  players: [Player, Player, Player];
  round: 'J' | 'DJ';
  /** Face values of the clues still unrevealed AFTER this DD resolves. */
  remainingClueValues: number[];
  /** Daily Doubles still unfound AFTER this one. */
  remainingDDCount: number;
}

export interface GridPoint {
  /** Wagering player's score after the DD resolves. */
  score: number;
  /** P(win the game) from this score. */
  v: number;
  /** Monte Carlo standard error on `v`. */
  se: number;
  /** P(lead going into Final Jeopardy). */
  pLeadPreFJ: number;
  /** P(hold a lock going into FJ — more than 2× the runner-up). */
  pLockPreFJ: number;
}

export interface WagerPoint {
  wager: number;
  equity: number;
  vWin: number;
  vLose: number;
  pLockIfWin: number;
}

export interface DDAnalysis {
  position: DDPosition;
  sims: number;
  grid: GridPoint[];
  curve: WagerPoint[];
  best: WagerPoint;
  /** Wagers whose equity is within `plateauTolerance` of the best. */
  plateau: { min: number; max: number; tolerance: number };
  /** V(S) with no wager at all — the "you never found it" baseline. */
  vBase: number;
}

export interface AnalyzeOptions {
  /** Rollouts per grid score. Default 6000. */
  sims?: number;
  /** Wager grid step in dollars. Default 200. */
  step?: number;
  /** P(the wagering player answers this DD correctly). */
  pCorrect: number;
  config: SimConfig;
  seed?: number;
  /** Equity window (absolute win-probability) counted as "tied for best". */
  plateauTolerance?: number;
}

// ─── Core ────────────────────────────────────────────────────────────────

/** Win credit from a final scoreboard, splitting ties. */
function winCredit(scores: number[]): number {
  const max = Math.max(...scores);
  if (scores[0] < max) return 0;
  return 1 / scores.filter(s => s === max).length;
}

/**
 * Estimate V(score) — P(player 0 wins) — for one post-DD score, plus the
 * pre-Final-Jeopardy lead/lock rates that explain *why* the number moves.
 *
 * Final Jeopardy is run explicitly here (rather than via `includeFJ`) so the
 * end-of-Double-Jeopardy scoreboard can be inspected before FJ wipes it out.
 */
function evaluateScore(
  pos: DDPosition,
  score: number,
  sims: number,
  config: SimConfig,
  baseSeed: number,
): GridPoint {
  const preFJConfig: SimConfig = { ...config, includeFJ: false };
  let wins = 0, leads = 0, locks = 0;

  for (let i = 0; i < sims; i++) {
    const rng = mulberry32(baseSeed + i);
    const state: SimState = {
      scores: [score, pos.scores[1], pos.scores[2]],
      round: pos.round,
      remainingClueValues: [...pos.remainingClueValues],
      remainingDDCount: pos.remainingDDCount,
    };
    const preFJ = simulateFromState(state, pos.players, preFJConfig, rng, false).scores;

    const rivalBest = Math.max(preFJ[1], preFJ[2]);
    if (preFJ[0] > rivalBest) leads++;
    if (preFJ[0] > 2 * Math.max(rivalBest, 0)) locks++;

    const final = config.includeFJ
      ? simulateFinalJeopardy(pos.players, [...preFJ] as [number, number, number], config, rng)
      : preFJ;
    wins += winCredit(final);
  }

  const v = wins / sims;
  return {
    score,
    v,
    se: Math.sqrt(Math.max(v * (1 - v), 0) / sims),
    pLeadPreFJ: leads / sims,
    pLockPreFJ: locks / sims,
  };
}

/** Highest clue value on the board in each round — the floor under the
 *  maximum legal Daily Double wager (see `maxLegalWager`). */
const ROUND_TOP_VALUE: Record<'J' | 'DJ', number> = { J: 1000, DJ: 2000 };

/**
 * The real-rules maximum: a player may wager up to the GREATER of their own
 * score and the highest dollar value on the board in that round. This is why
 * a contestant sitting on $600 in Double Jeopardy can still bet $2,000 — a
 * detail that matters exactly when it matters most, since trailing players
 * are the ones who should be betting everything.
 */
export function maxLegalWager(score: number, round: 'J' | 'DJ'): number {
  return Math.max(score, ROUND_TOP_VALUE[round]);
}

/**
 * Full wager sweep for one Daily Double position.
 *
 * The wager grid runs $0 (a stand-in for the $5 real-rules minimum — the
 * difference is far below Monte Carlo resolution) up to `maxLegalWager`, in
 * `step` increments, always including the exact maximum ("true Daily
 * Double") as a grid point even when it isn't a multiple of `step`.
 */
export function analyzeDD(pos: DDPosition, opts: AnalyzeOptions): DDAnalysis {
  const sims = opts.sims ?? 6000;
  const step = opts.step ?? 200;
  const seed = opts.seed ?? 12345;
  const tolerance = opts.plateauTolerance ?? 0.005;
  const score = pos.scores[0];
  const maxWager = maxLegalWager(score, pos.round);

  const wagers: number[] = [];
  for (let w = 0; w <= maxWager; w += step) wagers.push(w);
  if (wagers[wagers.length - 1] !== maxWager) wagers.push(maxWager);

  // Every score either branch can land on. Deduped so a wager grid symmetric
  // about `score` costs ~2× the grid, not 2× the wagers.
  const scoreSet = new Set<number>();
  for (const w of wagers) {
    scoreSet.add(score + w);
    scoreSet.add(score - w);
  }
  const gridScores = [...scoreSet].sort((a, b) => a - b);

  const grid: GridPoint[] = gridScores.map(s =>
    evaluateScore(pos, s, sims, opts.config, seed),
  );
  const byScore = new Map(grid.map(g => [g.score, g]));

  const curve: WagerPoint[] = wagers.map(w => {
    const win = byScore.get(score + w) as GridPoint;
    const lose = byScore.get(score - w) as GridPoint;
    return {
      wager: w,
      equity: opts.pCorrect * win.v + (1 - opts.pCorrect) * lose.v,
      vWin: win.v,
      vLose: lose.v,
      pLockIfWin: win.pLockPreFJ,
    };
  });

  const best = curve.reduce((a, b) => (b.equity > a.equity ? b : a));
  const within = curve.filter(c => c.equity >= best.equity - tolerance);

  return {
    position: pos,
    sims,
    grid,
    curve,
    best,
    plateau: {
      min: Math.min(...within.map(c => c.wager)),
      max: Math.max(...within.map(c => c.wager)),
      tolerance,
    },
    vBase: (byScore.get(score) as GridPoint).v,
  };
}

// ─── Deterministic bounds ────────────────────────────────────────────────

export interface LockBounds {
  /** Highest score any single opponent could still reach by end of round. */
  opponentCeiling: number;
  /** True when the ceiling is exact (no unfound DDs to double through). */
  ceilingExact: boolean;
  /** Smallest wager that makes the game unloseable if the answer is right,
   *  or null if no wager can (the ceiling is out of reach). */
  lockIfRight: number | null;
  /** Largest wager that keeps the game unloseable even if it's wrong, or
   *  null if being wrong always reopens the game. */
  lockIfWrong: number | null;
  /** True when the position is already unloseable at a $0 wager. */
  alreadyLocked: boolean;
}

/**
 * The algebra behind the Monte Carlo: how much is needed to put the game
 * out of reach outright.
 *
 * "Unloseable" means holding a lock going into Final Jeopardy — more than
 * double the runner-up — since the leader can then wager under the margin
 * and win regardless of the FJ result. The opponent ceiling assumes one
 * opponent sweeps every clue left in the round; with Daily Doubles still
 * unfound it also lets them double through each one, which makes the ceiling
 * an upper bound rather than an exact figure (flagged by `ceilingExact`).
 */
export function lockBounds(pos: DDPosition): LockBounds {
  const remainingTotal = pos.remainingClueValues.reduce((a, b) => a + b, 0);
  const maxClue = pos.remainingClueValues.length > 0 ? Math.max(...pos.remainingClueValues) : 0;

  let ceiling = Math.max(pos.scores[1], pos.scores[2]);
  for (let i = 0; i < pos.remainingDDCount; i++) {
    ceiling = Math.max(2 * ceiling, ceiling + maxClue);
  }
  ceiling += remainingTotal;

  const needed = 2 * ceiling + 1;
  const score = pos.scores[0];
  // Worst case for the leader is gaining nothing further this round, so the
  // wager is the only score change that can be counted on: right ⇒ score + w,
  // wrong ⇒ score − w, and a wager can never exceed the current score.
  const minRight = Math.max(0, needed - score);
  const maxWrong = score - needed;

  return {
    opponentCeiling: ceiling,
    ceilingExact: pos.remainingDDCount === 0,
    lockIfRight: minRight <= maxLegalWager(score, pos.round) ? minRight : null,
    lockIfWrong: maxWrong >= 0 ? maxWrong : null,
    alreadyLocked: score >= needed,
  };
}

/**
 * Optimal wager as a function of p, reusing one already-computed grid. Free
 * because the grid is indexed by resulting score, not by wager — this is what
 * turns "what if she were less sure?" into a table instead of another run.
 */
export function optimalByPCorrect(
  analysis: DDAnalysis,
  ps: number[],
): { p: number; wager: number; equity: number }[] {
  const score = analysis.position.scores[0];
  const byScore = new Map(analysis.grid.map(g => [g.score, g]));

  return ps.map(p => {
    let bestW = 0, bestE = -Infinity;
    for (const c of analysis.curve) {
      const win = byScore.get(score + c.wager) as GridPoint;
      const lose = byScore.get(score - c.wager) as GridPoint;
      const e = p * win.v + (1 - p) * lose.v;
      if (e > bestE) { bestE = e; bestW = c.wager; }
    }
    return { p, wager: bestW, equity: bestE };
  });
}
