import { describe, it, expect } from 'vitest';
import {
  backtestGame,
  backtestConfig,
  backtestHeadline,
  calibratePlayers,
  rolloutFromDD,
  rolloutSeed,
  rowSeed,
  rotateToSeat,
  maxLegalWager,
  winCredit,
  MIN_DD_WAGER,
  BACKTEST_ARMS,
} from './backtest';
import { mulberry32 } from './sim-engine';
import type { GameRecord, RecordStep } from '../lib/jarchive';

// ─── Fixture ─────────────────────────────────────────────────────────────

const DJ_BOARD = [400, 800, 1200, 1600, 2000];

function step(partial: Partial<RecordStep> & Pick<RecordStep, 'round' | 'order' | 'before' | 'after'>): RecordStep {
  return {
    boundValue: 800,
    isDD: false,
    ddPlayer: -1,
    wager: null,
    ddCorrect: false,
    deltas: partial.after.map((v, i) => v - partial.before[i]),
    remainingValuesAfter: [],
    remainingDDsAfter: 0,
    ...partial,
  };
}

/**
 * A three-player game where seat 1 ("Grace") hits one DJ Daily Double with
 * 12 clues left, and (optionally) one J-round DD earlier.
 */
function makeRecord(opts: { jDD?: boolean; graceDDs?: number } = {}): GameRecord {
  const steps: RecordStep[] = [];
  // Jeopardy round: a couple of regular clues, optionally a DD for Grace.
  steps.push(step({ round: 'J', order: 1, boundValue: 200, before: [0, 0, 0], after: [200, 0, 0], remainingValuesAfter: Array(29).fill(600), remainingDDsAfter: 1 }));
  if (opts.jDD) {
    steps.push(step({
      round: 'J', order: 2, boundValue: 800, isDD: true, ddPlayer: 1, wager: 1000, ddCorrect: true,
      before: [200, 0, 0], after: [200, 1000, 0], remainingValuesAfter: Array(28).fill(600), remainingDDsAfter: 0,
    }));
    steps.push(step({ round: 'J', order: 3, boundValue: 600, before: [200, 1000, 0], after: [200, 1000, 600], remainingValuesAfter: Array(27).fill(600), remainingDDsAfter: 0 }));
  } else {
    steps.push(step({ round: 'J', order: 2, boundValue: 600, before: [200, 0, 0], after: [200, 600, 0], remainingValuesAfter: Array(28).fill(600), remainingDDsAfter: 1 }));
  }
  const endJ = steps[steps.length - 1].after;
  // Double Jeopardy: some play, then Grace's DD.
  const djBefore = [endJ[0] + 4000, endJ[1] + 6000, endJ[2] + 3000];
  steps.push(step({ round: 'DJ', order: 1, boundValue: 400, before: [...endJ], after: [...djBefore], remainingValuesAfter: Array(29).fill(1200), remainingDDsAfter: 2 }));
  const remaining12 = Array.from({ length: 12 }, (_, i) => DJ_BOARD[i % 5]);
  steps.push(step({
    round: 'DJ', order: 18, boundValue: 1600, isDD: true, ddPlayer: 1, wager: 3000, ddCorrect: false,
    before: [...djBefore], after: [djBefore[0], djBefore[1] - 3000, djBefore[2]],
    remainingValuesAfter: remaining12, remainingDDsAfter: 1,
  }));
  if ((opts.graceDDs ?? 1) >= 2) {
    const b = steps[steps.length - 1].after;
    steps.push(step({
      round: 'DJ', order: 25, boundValue: 2000, isDD: true, ddPlayer: 1, wager: 2000, ddCorrect: true,
      before: [...b], after: [b[0], b[1] + 2000, b[2]],
      remainingValuesAfter: remaining12.slice(0, 5), remainingDDsAfter: 0,
    }));
  }
  const endDJ = steps[steps.length - 1].after;
  return {
    players: ['Sam', 'Grace', 'Joey'],
    cluesPlayed: 57,
    stats: [
      { correct: 14, wrong: 3, coryat: 8600 },
      { correct: 25, wrong: 3, coryat: 20200 },
      { correct: 12, wrong: 1, coryat: 7400 },
    ],
    endOfJ: [...endJ],
    endOfDJ: [...endDJ],
    steps,
  };
}

const FAST = { rolloutsPerArm: 60, seed: 0x1234 };

// ─── Tests ───────────────────────────────────────────────────────────────

describe('calibratePlayers', () => {
  it('fits precision from correct/wrong, b from the Coryat, buzzer speed from share of clues won', () => {
    const players = calibratePlayers(makeRecord());
    expect(players.map(p => p.name)).toEqual(['Sam', 'Grace', 'Joey']);
    // Precision = correct / (correct + wrong), passed through calibrateOpponent unchanged.
    expect(players[1].p).toBeCloseTo(25 / 28, 6);
    expect(players[0].p).toBeCloseTo(14 / 17, 6);
    // Grace won the most clues, so she is the buzzer-speed reference (1.0);
    // the others are their share relative to hers.
    expect(players[1].buzzerSpeed).toBe(1);
    expect(players[0].buzzerSpeed).toBeCloseTo(14 / 25, 6);
    expect(players[2].buzzerSpeed).toBeCloseTo(12 / 25, 6);
    // Coryat drives b: Grace's $20,200 Coryat beats Sam's $8,600.
    expect(players[1].b).toBeGreaterThan(players[0].b);
    for (const p of players) {
      expect(p.b).toBeGreaterThan(0);
      expect(p.b).toBeLessThanOrEqual(0.95);
      expect(p.fjAccuracy).toBeCloseTo(Math.max(0.2, Math.min(0.8, 0.3 + 0.4 * p.p)), 6);
    }
  });
});

describe('helpers', () => {
  it('maxLegalWager is the greater of score and the round top value', () => {
    expect(maxLegalWager(600, 'DJ')).toBe(2000);
    expect(maxLegalWager(600, 'J')).toBe(1000);
    expect(maxLegalWager(12000, 'DJ')).toBe(12000);
    expect(maxLegalWager(-500, 'DJ')).toBe(2000);
  });

  it('winCredit splits ties', () => {
    expect(winCredit([10, 5, 5])).toBe(1);
    expect(winCredit([10, 10, 5])).toBe(0.5);
    expect(winCredit([5, 10, 5])).toBe(0);
  });

  it('rotateToSeat puts the seat first and keeps the rest in podium order', () => {
    expect(rotateToSeat(['a', 'b', 'c'], 1)).toEqual(['b', 'a', 'c']);
    expect(rotateToSeat(['a', 'b', 'c'], 2)).toEqual(['c', 'a', 'b']);
  });
});

describe('backtestGame', () => {
  it('returns no rows and a plain 0-DD headline when you hit no Daily Double', () => {
    const result = backtestGame(makeRecord(), { seat: 0, ...FAST });
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([]);
    expect(result!.summary).toBeNull();
    expect(backtestHeadline(result!)).toBe('Sam did not hit a Daily Double in this game.');
  });

  it('produces one row per DD you hit with all four arms, a summary, and a headline', () => {
    const result = backtestGame(makeRecord({ graceDDs: 2 }), { seat: 1, ...FAST })!;
    expect(result.you).toBe('Grace');
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.round).toBe('DJ');
      for (const arm of BACKTEST_ARMS) {
        const est = row.arms[arm];
        expect(est).not.toBeNull();
        expect(est!.winRate).toBeGreaterThanOrEqual(0);
        expect(est!.winRate).toBeLessThanOrEqual(1);
        expect(est!.se).toBeGreaterThanOrEqual(0);
      }
      expect(row.arms.actual!.wager).toBe(row.actualWager);
      expect(row.arms.minimum!.wager).toBe(MIN_DD_WAGER);
      expect(row.arms.allIn!.wager).toBe(maxLegalWager(row.scoreBefore, row.round));
      expect(row.arms.actual!.deltaVsActual).toBe(0);
      expect(row.arms.actual!.deltaSe).toBe(0);
      // No table supplied: the equity arm fell back to a direct rollout search.
      expect(row.equitySource).toBe('rollout');
      expect(row.arms.equity!.wager).toBeGreaterThanOrEqual(MIN_DD_WAGER);
      expect(row.arms.equity!.wager).toBeLessThanOrEqual(maxLegalWager(row.scoreBefore, row.round));
    }
    expect(result.rows[0].actualWager).toBe(3000);
    expect(result.rows[1].actualWager).toBe(2000);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.ddCount).toBe(2);
    expect(result.summary!.fromLabel).toBe('the start of Double Jeopardy');
    expect(backtestHeadline(result)).toMatch(/^With equity wagering at your Daily Doubles, your chance of winning this game goes from \d+% to \d+% \(± \d+\)\.$/);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('labels the summary from your first DD when one is in the Jeopardy round', () => {
    const result = backtestGame(makeRecord({ jDD: true }), { seat: 1, ...FAST })!;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].round).toBe('J');
    expect(result.rows[0].equitySource).toBe('rollout');
    expect(result.summary!.fromLabel).toBe('your first Daily Double (Jeopardy round)');
  });

  it('skips the equity arm when asked to and says so', () => {
    const result = backtestGame(makeRecord(), { seat: 1, ...FAST, equityFallback: 'skip' })!;
    expect(result.rows[0].equitySource).toBe('skipped');
    expect(result.rows[0].arms.equity).toBeNull();
    expect(result.summary!.arms.equity).toBeNull();
    expect(backtestHeadline(result)).toMatch(/equity arm was skipped/);
    expect(result.notes.some(n => /skipped/.test(n))).toBe(true);
  });

  it('the actual-wager arm reproduces a direct simulateFromState rollout with the same seeds', () => {
    const record = makeRecord();
    const seat = 1;
    const result = backtestGame(record, { seat, ...FAST })!;
    const row = result.rows[0];
    const players = rotateToSeat(calibratePlayers(record), seat);
    const config = backtestConfig();
    const dd = record.steps[row.stepIndex];
    const pos = {
      round: dd.round,
      scores: rotateToSeat(dd.before, seat),
      remainingClueValues: dd.remainingValuesAfter,
      remainingDDCount: dd.remainingDDsAfter,
    };
    let wins = 0;
    for (let g = 0; g < FAST.rolloutsPerArm; g++) {
      const rng = mulberry32(rolloutSeed(rowSeed(FAST.seed, row.stepIndex), g));
      wins += rolloutFromDD(pos, dd.wager as number, row.pCorrect, players, config, rng);
    }
    expect(row.arms.actual!.winRate).toBeCloseTo(wins / FAST.rolloutsPerArm, 10);
  });

  it('arms are paired: an arm with the same wager as actual matches it exactly', () => {
    // Force the "minimum" comparison to be exact by making the actual wager $5.
    const record = makeRecord();
    const dd = record.steps.find(s => s.isDD && s.round === 'DJ')!;
    dd.wager = MIN_DD_WAGER;
    dd.after = [dd.before[0], dd.before[1] - MIN_DD_WAGER, dd.before[2]];
    dd.deltas = dd.after.map((v, i) => v - dd.before[i]);
    const result = backtestGame(record, { seat: 1, ...FAST })!;
    const row = result.rows[0];
    expect(row.arms.minimum!.winRate).toBe(row.arms.actual!.winRate);
    expect(row.arms.minimum!.deltaVsActual).toBe(0);
    expect(row.arms.minimum!.deltaSe).toBe(0);
    expect(result.summary!.arms.minimum!.winRate).toBe(result.summary!.arms.actual!.winRate);
  });

  it('is deterministic for the same seed and changes with the seed', () => {
    const a = backtestGame(makeRecord(), { seat: 1, ...FAST })!;
    const b = backtestGame(makeRecord(), { seat: 1, ...FAST })!;
    expect(b).toEqual(a);
    const c = backtestGame(makeRecord(), { seat: 1, rolloutsPerArm: 60, seed: 0x9999 })!;
    const same = BACKTEST_ARMS.every(arm => c.rows[0].arms[arm]!.winRate === a.rows[0].arms[arm]!.winRate);
    expect(same).toBe(false);
  });

  it('reports progress up to 1 and honours cancellation', () => {
    const pcts: number[] = [];
    backtestGame(makeRecord(), { seat: 1, ...FAST, onProgress: p => pcts.push(p) });
    expect(pcts.length).toBeGreaterThan(0);
    expect(pcts[pcts.length - 1]).toBe(1);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);

    let calls = 0;
    const cancelled = backtestGame(makeRecord(), { seat: 1, ...FAST, isCancelled: () => ++calls > 3 });
    expect(cancelled).toBeNull();
  });

  it('rejects a bad seat', () => {
    expect(() => backtestGame(makeRecord(), { seat: 3, ...FAST })).toThrow(/seat/);
  });
});
