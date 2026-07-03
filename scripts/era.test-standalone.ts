/**
 * era.test-standalone.ts — golden-row tests for scripts/lib/era.ts.
 *
 * Not picked up by vitest: vitest's project root is app/ (app/vite.config.ts),
 * and its default include glob only matches *.test.ts under that root — this
 * file lives in scripts/, a sibling directory outside the vite/vitest root, so
 * it is invisible to `npm test` without editing app's vitest config (out of
 * scope for this work item — scripts/ and lib/era.ts are the only files this
 * item may add). Instead this is a plain assertion script, run with the same
 * tool that runs the build scripts:
 *
 *   npx tsx scripts/era.test-standalone.ts
 *
 * Exits non-zero (throws) on first failed assertion.
 */

import assert from 'node:assert/strict';
import { classifyClue, getEra, getLadder, isValidAirDate } from './lib/era';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}

console.log('era.ts golden-row tests');

check('pre-2001 J $300 -> row 2', () => {
  const c = classifyClue('2000-01-01', 1, 300);
  assert.equal(c.status, 'ok');
  assert.equal((c as { row: number }).row, 2);
});

check('post-2001 DJ $1600 -> row 3', () => {
  const c = classifyClue('2005-01-01', 2, 1600);
  assert.equal(c.status, 'ok');
  assert.equal((c as { row: number }).row, 3);
});

check('pre-2001 J $100 -> row 0 (top row)', () => {
  const c = classifyClue('1990-06-15', 1, 100);
  assert.equal(c.status, 'ok');
  assert.equal((c as { row: number }).row, 0);
});

check('post-2001 J $1000 -> row 4 (bottom row)', () => {
  const c = classifyClue('2010-03-01', 1, 1000);
  assert.equal(c.status, 'ok');
  assert.equal((c as { row: number }).row, 4);
});

check('anomalous value (pre-2001 J $350, off-ladder) -> excluded', () => {
  const c = classifyClue('2000-01-01', 1, 350);
  assert.equal(c.status, 'anomalous-value');
});

check('anomalous value (post-2001 DJ $1000, pre-era value used post-era) -> excluded', () => {
  const c = classifyClue('2010-01-01', 2, 1000);
  assert.equal(c.status, 'anomalous-value');
});

check('missing air_date -> excluded, distinct status', () => {
  const c = classifyClue(undefined, 1, 300);
  assert.equal(c.status, 'missing-airdate');
});

check('unparseable air_date -> excluded, distinct status', () => {
  const c = classifyClue('not-a-date', 1, 300);
  assert.equal(c.status, 'missing-airdate');
});

check('empty-string air_date -> excluded, distinct status', () => {
  const c = classifyClue('', 2, 400);
  assert.equal(c.status, 'missing-airdate');
});

check('round 3 (Final Jeopardy) -> not-row-round regardless of value', () => {
  const c = classifyClue('2010-01-01', 3, 0);
  assert.equal(c.status, 'not-row-round');
});

check('boundary date 2001-11-26 itself uses POST ladder (inclusive)', () => {
  const c = classifyClue('2001-11-26', 1, 200);
  assert.equal(c.status, 'ok');
  assert.equal((c as { row: number }).row, 0);
  assert.equal(getEra('2001-11-26'), 'post');
});

check('day before boundary (2001-11-25) uses PRE ladder', () => {
  const c = classifyClue('2001-11-25', 1, 500);
  assert.equal(c.status, 'ok');
  assert.equal((c as { row: number }).row, 4);
  assert.equal(getEra('2001-11-25'), 'pre');
});

check('roundMax is era-aware for round 1 and round 2', () => {
  assert.equal(getLadder('1990-01-01')!.J[4], 500);
  assert.equal(getLadder('1990-01-01')!.DJ[4], 1000);
  assert.equal(getLadder('2010-01-01')!.J[4], 1000);
  assert.equal(getLadder('2010-01-01')!.DJ[4], 2000);
});

check('anomalous-value classification still carries era-aware roundMax', () => {
  const c = classifyClue('2010-01-01', 2, 1000); // off-ladder for post-era DJ
  assert.equal(c.status, 'anomalous-value');
  assert.equal((c as { roundMax: number }).roundMax, 2000);
});

check('isValidAirDate rejects non-ISO strings', () => {
  assert.equal(isValidAirDate('2001-1-1'), false);
  assert.equal(isValidAirDate('2001-11-26'), true);
  assert.equal(isValidAirDate(null), false);
  assert.equal(isValidAirDate(undefined), false);
});

console.log(`\n${passed} passed, 0 failed`);
