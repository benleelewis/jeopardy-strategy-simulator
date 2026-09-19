/**
 * Unit tests for the shared J-Archive parser (app/src/lib/jarchive.ts),
 * against the cached game-9501 fixture (data/jarchive-cache/game-9501.html —
 * gitignored; copy it from the main checkout's data/jarchive-cache/ before
 * running these locally, same as `scripts/dd-advisor.ts` needs it cached).
 *
 * Loaded via Vite's `?raw` import (declared by `vite/client`, already in
 * tsconfig.app.json's `types`) rather than `fs.readFileSync`: this file
 * lives under `src/`, whose tsconfig deliberately has no Node type
 * declarations (it's typechecked as browser code), so a plain `fs` import
 * would fail `tsc -b` even though it'd run fine under Vitest.
 *
 * These numbers were captured by actually running the parser against that
 * fixture (`npx tsx scripts/dd-advisor.ts --game 9501 --list`), not guessed.
 */
import { describe, it, expect } from 'vitest';
import { parseGame, replay, playerStats } from './jarchive';
import fixtureHtml from '../../../data/jarchive-cache/game-9501.html?raw';

function loadFixture(): string {
  return fixtureHtml;
}

describe('parseGame + replay (game 9501 fixture)', () => {
  it('extracts the three podium nicknames', () => {
    const game = parseGame(loadFixture());
    expect(game.players).toEqual(['Sam', 'Grace', 'Joey']);
  });

  it('replay self-validates against all published J-Archive checkpoints', () => {
    const game = parseGame(loadFixture());
    const rep = replay(game);
    expect(rep.validation.checked).toBe(3);
    expect(rep.validation.mismatches).toEqual([]);
  });

  it('finds all 3 Daily Doubles, in play order, with correct wagers and takers', () => {
    const game = parseGame(loadFixture());
    const rep = replay(game);
    const dds = rep.steps.filter(s => s.clue.isDD);
    expect(dds).toHaveLength(3);

    expect(dds[0]).toMatchObject({
      clue: { round: 'J', order: 12, wager: 1400, right: 'Grace' },
      before: [1800, 3400, 0],
    });
    expect(dds[1]).toMatchObject({
      clue: { round: 'DJ', order: 7, wager: 2000, right: 'Joey' },
      before: [7000, 11200, 4200],
    });
    expect(dds[2]).toMatchObject({
      clue: { round: 'DJ', order: 23, wager: 10000, right: 'Grace' },
      before: [7800, 19200, 7000],
    });
  });

  it('computes end-of-round and Final Jeopardy scores', () => {
    const game = parseGame(loadFixture());
    const rep = replay(game);
    expect(rep.endOfRound.DJ).toEqual([8600, 30000, 7400]);
    expect(game.fj).toMatchObject({
      correct: [true, true, true],
      finalScores: [14801, 32000, 8700],
    });
  });

  it('playerStats matches J-Archive-derived correct/wrong/Coryat counts', () => {
    const game = parseGame(loadFixture());
    const stats = playerStats(game);
    expect(stats).toEqual([
      { name: 'Sam', correct: 14, wrong: 3, coryat: 8600, ddsFound: 0 },
      { name: 'Grace', correct: 25, wrong: 3, coryat: 20200, ddsFound: 2 },
      { name: 'Joey', correct: 12, wrong: 1, coryat: 7400, ddsFound: 1 },
    ]);
  });
});
