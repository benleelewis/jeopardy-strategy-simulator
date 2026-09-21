/**
 * Lock-aware guard in front of the V(S) table lookup (value-function.ts:
 * `lockAnalysis`, `applyLockGuard`, and `equityWager`'s optional `lock`
 * context).
 *
 * Motivating case — J-Archive game 9501, Grace's Double Jeopardy Daily
 * Double: scores $19,200 (Grace) / $7,800 / $7,000, seven clues left
 * ($400 ×6, $800 — $3,200 total), no DDs left. A direct paired rollout
 * says the $5 minimum wins 99.9%; the table said $12,633, which wins
 * 94.8%. Deterministically: no opponent can pass $11,000 before Final
 * Jeopardy, so any wager ≤ $8,100 keeps Grace the guaranteed leader into
 * FJ even after a miss. (It is NOT an FJ-proof lock: an opponent at
 * $11,000 doubling to $22,000 beats $19,195 — so the FJ-proof tier is
 * null here and the guaranteed-lead tier is what fires.)
 */

import { describe, it, expect } from 'vitest';
import {
  lockAnalysis,
  applyLockGuard,
  equityWager,
  buildValueTable,
  EQUITY_MIN_WAGER,
  type EquityLockContext,
  type ValueTable,
} from './value-function';
import { simulateGame, mulberry32, DEFAULT_CONFIG, type Player, type SimConfig } from './sim-engine';
import { OPPONENT_PROFILES } from './opponent-models';

// ─── The 9501 position (index 0 = Grace, the wagerer) ──────────────────

const G9501_SCORES: [number, number, number] = [19200, 7800, 7000];
const G9501_BOARD = [400, 400, 400, 400, 400, 400, 800];
const G9501_LOCK: EquityLockContext = { remainingClueValues: G9501_BOARD, remainingDDs: 0, round: 'DJ' };

describe('lockAnalysis', () => {
  it('9501: guaranteed lead at the minimum, largest lead-safe wager $8,100, not FJ-proof', () => {
    const a = lockAnalysis(G9501_SCORES, 0, G9501_BOARD, 0, 'DJ');
    expect(a.maxOpponentReachPreFJ).toBe(7800 + 3200);
    expect(a.maxOpponentReach).toBe(2 * 11000);
    expect(a.isLeadSafeNow).toBe(true);
    // 19,200 − 11,000 − 1 = 8,199 ⇒ rounded down to $8,100.
    expect(a.leadSafeAtWager).toBe(8100);
    // 19,195 < 22,000: an opponent sweeping the board and doubling in FJ
    // could still pass her, so there is no FJ-proof lock at any wager.
    expect(a.isLockNow).toBe(false);
    expect(a.lockedAtWager).toBeNull();
  });

  it('a position whose largest FJ-proof-safe wager is exactly $4,000', () => {
    // Opponent ceiling: 6,000 + 5×$400 = 8,000 pre-FJ, 16,000 after FJ.
    // 20,100 − 16,000 − 1 = 4,099 ⇒ $4,000.
    const a = lockAnalysis([20100, 6000, 1000], 0, [400, 400, 400, 400, 400], 0, 'DJ');
    expect(a.maxOpponentReach).toBe(16000);
    expect(a.isLockNow).toBe(true);
    expect(a.lockedAtWager).toBe(4000);
    // The guaranteed-lead tier is looser: 20,100 − 8,000 − 1 = 12,099 ⇒ $12,000.
    expect(a.leadSafeAtWager).toBe(12000);
  });

  it('a non-lock position returns null for both tiers', () => {
    const a = lockAnalysis([10000, 9000, 8000], 0, [400, 800, 1200, 1600, 2000], 1, 'DJ');
    expect(a.lockedAtWager).toBeNull();
    expect(a.isLockNow).toBe(false);
    expect(a.leadSafeAtWager).toBeNull();
    expect(a.isLeadSafeNow).toBe(false);
  });

  it('a trailing wagerer is never a lock', () => {
    const a = lockAnalysis([5000, 12000, 3000], 0, [400], 0, 'DJ');
    expect(a.lockedAtWager).toBeNull();
    expect(a.leadSafeAtWager).toBeNull();
  });

  it('remaining Daily Doubles double the opponent after the clues (true daily double)', () => {
    const noDD = lockAnalysis([20000, 4000, 1000], 0, [400, 400], 0, 'DJ');
    const oneDD = lockAnalysis([20000, 4000, 1000], 0, [400, 400], 1, 'DJ');
    // 4,000 + 800 = 4,800; ×2 ⇒ 9,600 pre-FJ; ×2 ⇒ 19,200 after FJ.
    expect(noDD.maxOpponentReachPreFJ).toBe(4800);
    expect(oneDD.maxOpponentReachPreFJ).toBe(9600);
    expect(oneDD.maxOpponentReach).toBe(19200);
    expect(noDD.lockedAtWager).toBe(10300);  // 20,000 − 9,600 − 1 = 10,399
    expect(oneDD.lockedAtWager).toBe(700);   // 20,000 − 19,200 − 1 = 799
    expect(oneDD.lockedAtWager!).toBeLessThan(noDD.lockedAtWager!);
  });

  it('a broke opponent can still wager the round top value on a Daily Double', () => {
    // $0 opponents, nothing left but one DD: max(2×0, 0 + 2,000) = 2,000
    // pre-FJ, 4,000 after FJ ⇒ 5,000 − 4,000 − 1 = 999 ⇒ $900.
    const dj = lockAnalysis([5000, 0, 0], 0, [], 1, 'DJ');
    expect(dj.maxOpponentReachPreFJ).toBe(2000);
    expect(dj.lockedAtWager).toBe(900);
    // Same in Jeopardy, but the whole DJ board is still to come ⇒ no lock.
    const j = lockAnalysis([5000, 0, 0], 0, [], 1, 'J');
    expect(j.maxOpponentReachPreFJ).toBe((1000 + 36000) * 4);
    expect(j.lockedAtWager).toBeNull();
    expect(j.leadSafeAtWager).toBeNull();
  });

  it('Final Jeopardy doubling is what separates the two tiers', () => {
    const a = lockAnalysis([30000, 4000, 3000], 0, [400], 0, 'DJ');
    expect(a.maxOpponentReachPreFJ).toBe(4400);
    expect(a.maxOpponentReach).toBe(8800);
    // Matches the E-4 lock-preservation test's own arithmetic
    // (lockSafeMax = 30,000 − 2×4,400 − 1 = 21,199 ⇒ $21,100).
    expect(a.lockedAtWager).toBe(21100);
    expect(a.leadSafeAtWager).toBe(25500); // 30,000 − 4,400 − 1 = 25,599
  });

  it('an opponent at or below $0 after the round is not doubled in FJ', () => {
    const a = lockAnalysis([100, -3000, -3000], 0, [], 0, 'DJ');
    expect(a.maxOpponentReachPreFJ).toBe(-3000);
    expect(a.maxOpponentReach).toBe(-3000);
    // 100 − (−3000) − 1 = 3,099 ⇒ $3,000 — more than the score, but the
    // bet grid never exceeds the score anyway; the guard only caps.
    expect(a.lockedAtWager).toBe(3000);
  });

  it('never returns a wager below the $5 floor; a sub-$5 margin is null', () => {
    // 10,000 − 2×4,990 − 1 = 19 ⇒ rounds to $0, clamped up to $5.
    expect(lockAnalysis([10000, 4990, 0], 0, [], 0, 'DJ').lockedAtWager).toBe(EQUITY_MIN_WAGER);
    // 10,000 − 2×4,998 − 1 = 3 < 5 ⇒ null.
    expect(lockAnalysis([10000, 4998, 0], 0, [], 0, 'DJ').lockedAtWager).toBeNull();
  });

  it('works for any playerIdx (opponents are the other two)', () => {
    const podium = [7800, 19200, 7000];
    const a = lockAnalysis(podium, 1, G9501_BOARD, 0, 'DJ');
    expect(a.leadSafeAtWager).toBe(8100);
    expect(a.lockedAtWager).toBeNull();
    const b = lockAnalysis(podium, 0, G9501_BOARD, 0, 'DJ');
    expect(b.leadSafeAtWager).toBeNull();
  });
});

describe('applyLockGuard', () => {
  const g9501 = lockAnalysis(G9501_SCORES, 0, G9501_BOARD, 0, 'DJ');

  it('9501: a table wager past the lead-safe threshold falls back to the minimum', () => {
    expect(applyLockGuard(12633, g9501)).toBe(EQUITY_MIN_WAGER);
    expect(applyLockGuard(8200, g9501)).toBe(EQUITY_MIN_WAGER);
  });

  it('9501: a table wager at or below the threshold is kept', () => {
    expect(applyLockGuard(8100, g9501)).toBe(8100);
    expect(applyLockGuard(3000, g9501)).toBe(3000);
    expect(applyLockGuard(5, g9501)).toBe(5);
  });

  it('uses the FJ-proof threshold when one exists (the tighter of the two)', () => {
    const a = lockAnalysis([30000, 4000, 3000], 0, [400], 0, 'DJ'); // 21,100 / 25,500
    expect(applyLockGuard(21100, a)).toBe(21100);
    expect(applyLockGuard(23000, a)).toBe(EQUITY_MIN_WAGER); // lead-safe but not lock-safe
    expect(applyLockGuard(30000, a)).toBe(EQUITY_MIN_WAGER);
  });

  it('is the identity when no lock exists', () => {
    const none = lockAnalysis([10000, 9000, 8000], 0, [400, 800, 1200], 1, 'DJ');
    for (const w of [5, 2500, 7000, 10000]) expect(applyLockGuard(w, none)).toBe(w);
  });
});

// ─── equityWager with the guard ─────────────────────────────────────────

function smallTable(seed: number): ValueTable {
  return buildValueTable(OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(seed), {
    dims: {
      skillKnowledge: { min: 0, max: 1, n: 3 },
      skillBuzzer: { min: 0, max: 1, n: 3 },
      yourShare: { min: 0, max: 1.5, n: 6 },
      leaderRatio: { min: 0, max: 2, n: 5 },
      thirdRatio: { min: 0, max: 2, n: 5 },
      cluesRemaining: { min: 0, max: 30, n: 4 },
    },
    rolloutsPerCell: 10,
  });
}

describe('equityWager lock guard', () => {
  const table = smallTable(9501);
  // Grace's calibrated skill in the backtest (b=0.90, p=0.89, buzz=1.00).
  const grace = { knowledge: 0.9 * 0.89, buzzerSpeed: 1.0 };
  const pGrace = 0.89;

  it('9501: never wagers past $8,100, and returns the minimum when the table wanted more', () => {
    const unguarded = equityWager(grace, G9501_SCORES, G9501_BOARD.length, pGrace, table);
    const guarded = equityWager(grace, G9501_SCORES, G9501_BOARD.length, pGrace, table, G9501_LOCK);
    expect(guarded).toBeLessThanOrEqual(8100);
    expect(guarded).toBe(unguarded > 8100 ? EQUITY_MIN_WAGER : unguarded);
    // The production table (default dims, 20 rollouts/cell) answers
    // $12,633 here; this coarse seeded table must at least reproduce the
    // "wants to bet big" behaviour for the guard to be exercised.
    expect(unguarded, `coarse table answered $${unguarded} — pick a seed where it wagers past $8,100`)
      .toBeGreaterThan(8100);
    expect(guarded).toBe(EQUITY_MIN_WAGER);
  }, 30000);

  it('at non-lock positions the guarded lookup equals the unguarded one (byte-identical path)', () => {
    const positions: { scores: [number, number, number]; lock: EquityLockContext; p: number }[] = [
      { scores: [17200, 19400, 6400], lock: { remainingClueValues: [2000, 800, 1200, 1200, 400, 1600, 2000, 800, 800, 800, 400, 400, 400], remainingDDs: 0, round: 'DJ' }, p: 0.55 },
      { scores: [10000, 9000, 8000], lock: { remainingClueValues: [400, 800, 1200, 1600, 2000], remainingDDs: 1, round: 'DJ' }, p: 0.7 },
      { scores: [12000, 5000, 4000], lock: { remainingClueValues: [400, 400, 800, 800, 1200, 1200, 1600, 1600, 2000, 2000], remainingDDs: 1, round: 'DJ' }, p: 0.6 },
      { scores: [3, 5000, 4000], lock: { remainingClueValues: [400, 800], remainingDDs: 0, round: 'DJ' }, p: 0.5 },
      { scores: [4000, 2000, 1000], lock: { remainingClueValues: [200, 400, 600], remainingDDs: 0, round: 'J' }, p: 0.8 },
    ];
    for (const { scores, lock, p } of positions) {
      const a = lockAnalysis(scores, 0, lock.remainingClueValues, lock.remainingDDs, lock.round);
      expect(a.lockedAtWager ?? a.leadSafeAtWager, `expected a non-lock fixture: ${scores}`).toBeNull();
      const unguarded = equityWager({ knowledge: 0.5, buzzerSpeed: 0.5 }, scores, lock.remainingClueValues.length, p, table);
      const guarded = equityWager({ knowledge: 0.5, buzzerSpeed: 0.5 }, scores, lock.remainingClueValues.length, p, table, lock);
      expect(guarded).toBe(unguarded);
    }
  }, 30000);

  it('omitting the lock context is the pre-guard lookup even at 9501', () => {
    // Callers that only have a score-state (the components) are untouched.
    const a = equityWager(grace, G9501_SCORES, 7, pGrace, table);
    const b = equityWager(grace, G9501_SCORES, 7, pGrace, table);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(8100);
  });

  it('the engine records lockContext only on your equity DDs, never on the heuristic path', () => {
    const you: Player = { b: 0.7, p: 0.85, buzzerSpeed: 0.6, fjAccuracy: 0.5 };
    const opp: Player = { b: 0.6, p: 0.87, buzzerSpeed: 0.5, fjAccuracy: 0.5 };
    const heuristic: SimConfig = { ...DEFAULT_CONFIG };
    const equity: SimConfig = { ...DEFAULT_CONFIG, ddStrategy: 'equity', opponentDdStrategy: 'aggressive', valueTable: table };
    const rngA = mulberry32(5);
    const rngB = mulberry32(5);
    let yourEquityDDs = 0;
    for (let i = 0; i < 40; i++) {
      const h = simulateGame(you, opp, opp, heuristic, true, rngA);
      for (const e of h.ddEvents!) expect(e.lockContext).toBeUndefined();
      const q = simulateGame(you, opp, opp, equity, true, rngB);
      for (const e of q.ddEvents!) {
        if (e.player === 0) {
          yourEquityDDs++;
          expect(e.lockContext).toBeDefined();
          expect(e.lockContext!.remainingClueValues.length).toBe(e.cluesRemainingAfter);
          expect(e.lockContext!.remainingDDs).toBeGreaterThanOrEqual(0);
          expect(e.lockContext!.remainingDDs).toBeLessThanOrEqual(e.round === 'J' ? 0 : 1);
        } else {
          expect(e.lockContext).toBeUndefined();
        }
      }
    }
    expect(yourEquityDDs).toBeGreaterThan(0);
  }, 30000);
});
