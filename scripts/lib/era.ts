/**
 * era.ts — Jeopardy clue-value era normalization.
 *
 * Clue values doubled starting with the episode that aired 2001-11-26
 * (round-1 "Jeopardy!" ladder went from $100-500 to $200-1000; round-2
 * "Double Jeopardy!" ladder went from $200-1000 to $400-2000). This module
 * maps (air_date, round, clue_value) to a row index (0 = top/cheapest row,
 * 4 = bottom/most-expensive row) using the correct era's ladder, and
 * flags rows that don't fit (anomalous values) or can't be era-resolved
 * (missing/unparseable air_date).
 *
 * Shared by scripts/build-games.ts (implicitly, via the same TSV shape)
 * and scripts/build-clue-stats.ts (explicitly).
 */

export type EraLabel = 'pre' | 'post';

export interface EraLadder {
  /** Round 1 ("Jeopardy!") ascending clue-value ladder, top row first. */
  J: readonly number[];
  /** Round 2 ("Double Jeopardy!") ascending clue-value ladder, top row first. */
  DJ: readonly number[];
}

/** Ladder in effect for games airing before 2001-11-26. */
export const PRE_DOUBLING: EraLadder = {
  J: [100, 200, 300, 400, 500],
  DJ: [200, 400, 600, 800, 1000],
};

/** Ladder in effect for games airing on/after 2001-11-26. */
export const POST_DOUBLING: EraLadder = {
  J: [200, 400, 600, 800, 1000],
  DJ: [400, 800, 1200, 1600, 2000],
};

/**
 * First air_date the doubled values were used (inclusive). ISO date strings
 * compare correctly lexically, so `airDate >= DOUBLING_DATE` is a valid
 * era test without parsing into a Date object.
 */
export const DOUBLING_DATE = '2001-11-26';

const AIR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidAirDate(airDate: string | undefined | null): airDate is string {
  return typeof airDate === 'string' && AIR_DATE_RE.test(airDate);
}

/** Returns the era for a valid air_date, or null if the date can't be parsed. */
export function getEra(airDate: string | undefined | null): EraLabel | null {
  if (!isValidAirDate(airDate)) return null;
  return airDate >= DOUBLING_DATE ? 'post' : 'pre';
}

/** Returns the ladder in effect for a valid air_date, or null if unresolvable. */
export function getLadder(airDate: string | undefined | null): EraLadder | null {
  const era = getEra(airDate);
  if (era === null) return null;
  return era === 'post' ? POST_DOUBLING : PRE_DOUBLING;
}

export type RowClassification =
  | { status: 'ok'; era: EraLabel; row: number; roundMax: number }
  | { status: 'anomalous-value'; era: EraLabel; roundMax: number }
  | { status: 'missing-airdate' }
  | { status: 'not-row-round' };

/**
 * Classifies a single clue row for era-normalized row-index purposes.
 *
 * roundNum: 1 = Jeopardy! round, 2 = Double Jeopardy! round. Any other
 * value (e.g. 3 = Final Jeopardy!) returns 'not-row-round' — Final
 * Jeopardy has one clue per game and no row ladder, so it's out of scope
 * for row-indexed / DD stats by construction.
 */
export function classifyClue(
  airDate: string | undefined | null,
  roundNum: number,
  clueValue: number,
): RowClassification {
  if (roundNum !== 1 && roundNum !== 2) {
    return { status: 'not-row-round' };
  }
  const era = getEra(airDate);
  if (era === null) {
    return { status: 'missing-airdate' };
  }
  const ladder = era === 'post' ? POST_DOUBLING : PRE_DOUBLING;
  const values = roundNum === 1 ? ladder.J : ladder.DJ;
  const roundMax = values[values.length - 1];
  const row = values.indexOf(clueValue);
  if (row === -1) {
    return { status: 'anomalous-value', era, roundMax };
  }
  return { status: 'ok', era, row, roundMax };
}
