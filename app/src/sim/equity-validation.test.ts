/**
 * E-4 — Dual-config equity validation harness (PLAN.md).
 *
 * PART 1 — PAPER-REPLICATION CONFIG: reproduces the win-equity table from
 * Ben's IYSE 6644 paper ("Daily Double optimal bet amounts in Jeopardy!",
 * Fall 2022, Group 210) within ±5pp at all three published points.
 *
 * The paper's model, read from its actual simulation source
 * (JeopardySimulator.ipynb at the repo root — the paper's own code, not a
 * reconstruction):
 *   - scores = [19400, 6400, 17200], board = the 13 concrete clue values
 *     below, `player = 2` — i.e. **Ben wagers as the $17,200 SECOND-PLACE
 *     player**, not the $19,400 leader. (PLAN.md's "you = the 19400 leader"
 *     is contradicted by the notebook: the wager grid
 *     `range(0, scores[2]+1, 400)` gives exactly the paper's 44 bet
 *     amounts only for scores[2] = 17200, and `player = 2` is explicit.
 *     The published 36/45/55 numbers only reproduce from second place.)
 *   - DD outcome: Bernoulli(confidence), +wager / −wager.
 *   - Every remaining clue is awarded (+value, always correct, no wrong-
 *     answer penalties, no unanswered clues) to one of the three players
 *     uniformly at random — "all players equally likely to buzz in and
 *     answer correctly", the paper's stated limitation.
 *   - Win metric: strict lead at the END OF THE DJ ROUND ("% of simulations
 *     where Daily Double player leads at end of round" — Fig 1). No Final
 *     Jeopardy. Ties count as not leading (strict `>` in the notebook).
 *
 * Mapping onto this engine (exact, not approximate): players with b = 1,
 * p = 1, equal buzzerSpeed, rhoB = rhoP = 0, difficultyScaling: false
 * make every regular clue resolve to a uniformly random always-correct
 * buzzer — precisely the notebook's `score_clue`. includeFJ: false ends
 * the game at the round boundary. The DD outcome is drawn by the harness
 * itself (the engine state starts post-DD), matching "apply the wager
 * outcome, then roll out" from the plan.
 *
 * Board-composition note (the plan flagged this as the loosest replication
 * assumption): NOT an assumption here — the notebook hardcodes the exact
 * 13 values, so we use them verbatim. (The notebook's rollout loop
 * `for clue in board: clue = get_next_clue(board)` pops the list while
 * iterating, so the paper's own runs only ever played the FIRST 7 of the
 * 13 clues; the last 6 are small ($400/$800) and a normal-approximation
 * check shows both variants land within ~1pp of 36/45/55, so we play all
 * 13 as documented rather than replicating the bug.)
 *
 * PART 2 — PRODUCTION-CONFIG INVARIANTS (Tesauro opponents, correlations
 * on, difficulty scaling on — where the paper's numbers do NOT apply):
 * monotonicity in confidence; near-flat equity curve at the optimum
 * (Tesauro 2012's risk-mitigation property); lock preservation for the
 * 'equity' DD strategy.
 */

import { describe, it, expect } from 'vitest';
import {
  simulateFromState,
  sampleOpponent,
  playerFrom2Axis,
  mulberry32,
  type Player,
  type SimConfig,
  type SimState,
} from './sim-engine';
import { buildValueTable, equityWager } from './value-function';
import { OPPONENT_PROFILES } from './opponent-models';

// ─── Paper-replication config ────────────────────────────────────────────

/** Exact board from the paper/notebook: the 13 clue values remaining after
 *  Ben's last-DD clue on 2020-11-09 (J! Archive show #8276). Total $12,800. */
const PAPER_BOARD = [2000, 800, 1200, 1200, 400, 1600, 2000, 800, 800, 800, 400, 400, 400];

/** Ben's scores with YOU (engine player 0) = the $17,200 second-place
 *  wagerer (see file doc — the notebook's `player = 2`). Opponent order is
 *  irrelevant under the symmetric model. */
const PAPER_SCORES: [number, number, number] = [17200, 19400, 6400];

const PAPER_CONFIG: SimConfig = {
  ddStrategy: 'aggressive', // irrelevant: 0 DDs remain in the rollout
  includeFJ: false,         // paper's metric is lead at END OF ROUND
  rhoB: 0,                  // paper: independent players
  rhoP: 0,
  difficultyScaling: false, // paper: no difficulty-by-value term
  boardControl: 'leader',
};

/** b=1, p=1 ⇒ every clue: all three buzz, all correct, buzzer race decides
 *  uniformly (equal buzzerSpeed) ⇒ the notebook's uniform clue award. */
const PAPER_PLAYER: Player = { b: 1, p: 1, buzzerSpeed: 0.5, fjAccuracy: 0.5 };

/**
 * Win equity for a DD wager under the paper-replication model:
 * apply the wager outcome at `confidence`, roll out the 13-clue board via
 * simulateFromState, count strict leads (ties = loss, like the notebook).
 */
function paperEquity(wager: number, confidence: number, nRollouts: number, seed: number): number {
  const rng = mulberry32(seed);
  const players = [PAPER_PLAYER, PAPER_PLAYER, PAPER_PLAYER];
  let wins = 0;
  for (let i = 0; i < nRollouts; i++) {
    const correct = rng() < confidence;
    const state: SimState = {
      scores: [
        PAPER_SCORES[0] + (correct ? wager : -wager),
        PAPER_SCORES[1],
        PAPER_SCORES[2],
      ],
      round: 'DJ',
      remainingClueValues: [...PAPER_BOARD],
      remainingDDCount: 0, // the DD just wagered was the round's LAST one
    };
    const result = simulateFromState(state, players, PAPER_CONFIG, rng, false);
    if (result.scores[0] > result.scores[1] && result.scores[0] > result.scores[2]) {
      wins++;
    }
  }
  return wins / nRollouts;
}

/** Formats a full equity-vs-wager curve — the failure diagnostic PLAN.md
 *  requires ("print the full equity curve, not just the assertion"). */
function formatCurve(points: { wager: number; equity: number }[]): string {
  const rows = points
    .map(p => `  $${String(p.wager).padStart(6)}  →  ${(p.equity * 100).toFixed(1)}%`)
    .join('\n');
  return `\nPaper-replication equity-vs-wager curve (55% confidence):\n${rows}\n`;
}

describe('E-4 paper replication (IYSE 6644 dual-config validation)', () => {
  // One shared computation for all assertions in this block (~7 wagers ×
  // 30k seeded rollouts). SE per point ≈ 0.3pp — well inside ±5pp.
  const N = 30000;
  const SEED = 66442022;
  const curveWagers = [0, 3200, 5000, 8000, 12400, 15200, 17200];
  const curve = curveWagers.map((wager, i) => ({
    wager,
    equity: paperEquity(wager, 0.55, N, SEED + i),
  }));
  const curveStr = formatCurve(curve);
  const eq = (wager: number) => curve.find(p => p.wager === wager)!.equity;

  it('reports the measured curve (55% confidence)', () => {
    console.log(curveStr);
    expect(curve.length).toBe(curveWagers.length);
  });

  it('equity($3,200) ≈ 36% (paper: average season-37 wager) ±5pp', () => {
    expect(Math.abs(eq(3200) - 0.36), `equity($3,200) = ${(eq(3200) * 100).toFixed(1)}%, expected 36% ±5pp${curveStr}`)
      .toBeLessThanOrEqual(0.05);
  });

  it("equity($5,000) ≈ 45% (Ben's actual wager) ±5pp", () => {
    expect(Math.abs(eq(5000) - 0.45), `equity($5,000) = ${(eq(5000) * 100).toFixed(1)}%, expected 45% ±5pp${curveStr}`)
      .toBeLessThanOrEqual(0.05);
  });

  it("equity($12,400) ≈ 55% (paper's optimal) ±5pp", () => {
    expect(Math.abs(eq(12400) - 0.55), `equity($12,400) = ${(eq(12400) * 100).toFixed(1)}%, expected 55% ±5pp${curveStr}`)
      .toBeLessThanOrEqual(0.05);
  });

  it('equity is monotonically non-decreasing across $3,200 → $5,000 → $12,400', () => {
    // Small negative slack for MC noise (SE of a difference ≈ 0.45pp);
    // the paper's "always bet bigger" finding is a >8pp-per-step effect.
    expect(eq(5000), `monotonicity broke at $5,000${curveStr}`).toBeGreaterThanOrEqual(eq(3200) - 0.01);
    expect(eq(12400), `monotonicity broke at $12,400${curveStr}`).toBeGreaterThanOrEqual(eq(5000) - 0.01);
    expect(eq(12400)).toBeGreaterThan(eq(3200));
  });
});

// ─── Production-config invariants ────────────────────────────────────────

const PRODUCTION_CONFIG: SimConfig = {
  ddStrategy: 'aggressive',
  opponentDdStrategy: 'aggressive',
  includeFJ: true,
  rhoB: 0.2,               // Tesauro 2012 correlations
  rhoP: 0.2,
  boardControl: 'leader',
  // difficultyScaling defaults to ON — production model
};

/**
 * Direct-MC production equity: apply the DD outcome, then roll out under
 * the production config against freshly sampled Tesauro opponents.
 *
 * Variance reduction: rollout i re-seeds from `seedBase + i` so the SAME
 * rollout index sees the SAME random stream across different wagers /
 * confidences (common random numbers) — differences between curve points
 * are far less noisy than the points themselves.
 */
function productionEquity(
  you: Player,
  scores: [number, number, number],
  board: number[],
  wager: number,
  confidence: number,
  nRollouts: number,
  seedBase: number,
): number {
  let wins = 0;
  for (let i = 0; i < nRollouts; i++) {
    const rng = mulberry32(seedBase + i * 7919); // prime stride de-correlates streams
    const correct = rng() < confidence;
    const opp1 = sampleOpponent(OPPONENT_PROFILES.average, rng);
    const opp2 = sampleOpponent(OPPONENT_PROFILES.average, rng);
    const state: SimState = {
      scores: [scores[0] + (correct ? wager : -wager), scores[1], scores[2]],
      round: 'DJ',
      remainingClueValues: [...board],
      remainingDDCount: 0,
    };
    const result = simulateFromState(state, [you, opp1, opp2], PRODUCTION_CONFIG, rng, false);
    if (result.winner === 0) wins++;
  }
  return wins / nRollouts;
}

describe('E-4 production-config invariants (Tesauro opponents, correlations, difficulty scaling)', () => {
  // Ben-like strong player; leader state this time (production invariants
  // are state-agnostic properties, not paper-number replication).
  const you = playerFrom2Axis(0.55, 0.6);
  const scores: [number, number, number] = [19400, 6400, 17200];
  const board = PAPER_BOARD;

  it('equity is monotone non-decreasing in DD confidence', () => {
    const wager = 5000;
    const n = 6000;
    const eqs = [0.35, 0.55, 0.75].map(conf =>
      productionEquity(you, scores, board, wager, conf, n, 424242),
    );
    const msg = `equity by confidence [35%, 55%, 75%] = ${eqs.map(e => (e * 100).toFixed(1) + '%').join(', ')}`;
    // Paired seeds make the comparison tight; allow 1pp residual noise.
    expect(eqs[1], msg).toBeGreaterThanOrEqual(eqs[0] - 0.01);
    expect(eqs[2], msg).toBeGreaterThanOrEqual(eqs[1] - 0.01);
    expect(eqs[2], msg).toBeGreaterThan(eqs[0]);
  });

  it('equity-vs-wager curve is near-flat at the optimum (Tesauro risk-mitigation property)', () => {
    // Tesauro 2012: shading the bet down from the argmax costs almost no
    // equity (Watson's $9,300 → $6,700 example cost 0.2% equity). Assert:
    // moving $2,600 below the measured optimum costs ≤ 0.5pp + MC noise
    // allowance (paired rollouts keep difference noise near ±0.7pp, so the
    // tolerance is 1.5pp total — tolerance-based per PLAN.md).
    const n = 12000;
    const confidence = 0.65; // "55%+ confidence" regime per the plan
    const step = 1300;
    const wagers: number[] = [];
    for (let w = 5; w <= scores[0]; w += step) wagers.push(w);
    const eqs = wagers.map(w => productionEquity(you, scores, board, w, confidence, n, 777001));

    let bestIdx = 0;
    for (let i = 1; i < eqs.length; i++) if (eqs[i] > eqs[bestIdx]) bestIdx = i;
    const optWager = wagers[bestIdx];
    const belowWager = Math.max(5, optWager - 2600);
    const eqBelow = productionEquity(you, scores, board, belowWager, confidence, n, 777001);

    const curveStr = wagers.map((w, i) => `  $${String(w).padStart(6)} → ${(eqs[i] * 100).toFixed(1)}%`).join('\n');
    const msg = `optimum $${optWager} = ${(eqs[bestIdx] * 100).toFixed(1)}%, $${belowWager} = ${(eqBelow * 100).toFixed(1)}%\nfull curve:\n${curveStr}`;
    console.log(`[E-4 production] near-flat check:\n${msg}`);
    expect(eqs[bestIdx] - eqBelow, msg).toBeLessThanOrEqual(0.015);
  }, 20000);

  it("equity DD strategy never converts a pre-FJ lock into a possible loss (lock preservation)", () => {
    // Build a production V-table (coarse but seeded/deterministic).
    const table = buildValueTable(OPPONENT_PROFILES.average, PRODUCTION_CONFIG, mulberry32(99), {
      dims: {
        skillKnowledge: { min: 0, max: 1, n: 3 },
        skillBuzzer: { min: 0, max: 1, n: 3 },
        yourShare: { min: 0, max: 1.5, n: 6 },
        leaderRatio: { min: 0, max: 2, n: 5 },
        thirdRatio: { min: 0, max: 2, n: 5 },
        cluesRemaining: { min: 0, max: 30, n: 4 },
      },
      rolloutsPerCell: 15,
    });

    // Late game, crushing lead: $30,000 vs $4,000/$3,000, one $400 clue
    // left after this DD. Opponents' max pre-FJ score = 4,000 + 400 =
    // 4,400 ⇒ any wager ≤ 30,000 − 2×4,400 − 1 = $21,199 preserves a
    // guaranteed win even if the DD misses AND an opponent takes the last
    // clue AND doubles in FJ. A wager above that opens a losable game.
    const lockScores: [number, number, number] = [30000, 4000, 3000];
    const maxOppPreFJ = Math.max(lockScores[1], lockScores[2]) + 400;
    const lockSafeMax = lockScores[0] - 2 * maxOppPreFJ - 1;

    const wager = equityWager(
      { knowledge: 0.55, buzzerSpeed: 0.6 },
      lockScores,
      1,     // clues remaining after this DD
      0.55,  // DD confidence
      table,
    );

    expect(wager).toBeGreaterThanOrEqual(5);
    expect(wager, `equity wager $${wager} would break the lock (safe max $${lockSafeMax})`)
      .toBeLessThanOrEqual(lockSafeMax);
  }, 20000);
});
