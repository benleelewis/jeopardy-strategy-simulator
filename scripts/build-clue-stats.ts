/**
 * build-clue-stats.ts — Parse the clue-level Jeopardy dataset into clue-stats.json
 *
 * Reads combined_season1-41.tsv (one row per clue, 529,939 rows) and derives
 * empirical Daily Double placement priors and wager-sizing stats, era-normalized
 * (clue values doubled starting with the episode that aired 2001-11-26 — see
 * scripts/lib/era.ts, shared with build-games.ts's filtering philosophy).
 *
 * Mirrors build-games.ts: same data directory, same "skip + count, never
 * silently drop" posture, same output convention (small aggregated JSON under
 * app/public/, generatedAt + source counts embedded for debuggability).
 *
 * Usage: npx tsx scripts/build-clue-stats.ts
 * Output: app/public/clue-stats.json
 */

import { createReadStream, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { classifyClue, isValidAirDate } from './lib/era';

const DATA_DIR = resolve(__dirname, '../data/jeopardy_dataset_seasons_1-41');
const INPUT = resolve(DATA_DIR, 'combined_season1-41.tsv');
const OUTPUT = resolve(__dirname, '../app/public/clue-stats.json');

// Board-completeness threshold: a round is "complete enough" if at least this
// many of its 30 clues are present. Chosen from the actual distribution (see
// PLAN.md E-1 implementation notes): round-1 clue counts per game cluster at
// 30/29/28/... falling off smoothly (4234/2061/1203/... games) down through
// 20 (16 games), then drop off a cliff to a long tail of clearly-corrupted or
// non-standard entries (0, 3, 4, 10, 11, 13, 14, 17, 19 clues — a few dozen
// games total). 20-of-30 (67%) keeps ~99.6% of games (9089 of 9122 distinct
// air_dates) while excluding the tail. A game must clear this bar in BOTH
// round 1 AND round 2 to count as "complete" for DD-stat purposes.
const COMPLETENESS_THRESHOLD = 20;
const FULL_ROUND_CLUES = 30;

// Column indices, verified against the header row.
const COL = {
  round: 0,
  clueValue: 1,
  dailyDoubleValue: 2,
  category: 3,
  comments: 4,
  answer: 5,
  question: 6,
  airDate: 7,
  notes: 8,
} as const;
const EXPECTED_COLS = Object.keys(COL).length;

type RoundKey = 'J' | 'DJ';
const ROUND_KEY: Record<1 | 2, RoundKey> = { 1: 'J', 2: 'DJ' };

interface ParsedRow {
  round: number;
  clueValue: number;
  ddValue: number;
  airDate: string;
  category: string;
}

/** Parses one non-header TSV line. Returns null if structurally malformed. */
function parseRow(line: string): ParsedRow | null {
  const cols = line.split('\t');
  if (cols.length !== EXPECTED_COLS) return null;
  const round = parseInt(cols[COL.round], 10);
  const clueValue = parseInt(cols[COL.clueValue], 10);
  const ddValue = parseInt(cols[COL.dailyDoubleValue], 10);
  if (isNaN(round) || isNaN(clueValue) || isNaN(ddValue)) return null;
  return { round, clueValue, ddValue, airDate: cols[COL.airDate], category: cols[COL.category] };
}

// --- Quantiles ---

/** Linear-interpolation quantile (numpy 'linear' default), q in [0,1]. Assumes sorted input. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function summarize(values: number[]) {
  if (values.length === 0) {
    return { p10: NaN, p25: NaN, p50: NaN, p75: NaN, p90: NaN, mean: NaN, n: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    mean,
    n: values.length,
  };
}

// --- Pass 1: per-game (per air_date) round-1 / round-2 clue counts ---
// Used to build the board-completeness filter (Set of "complete" air_dates).

async function tallyGameCompleteness(): Promise<{
  completeDates: Set<string>;
  distinctAirDates: number;
  perDateJCount: Map<string, number>;
  perDateDJCount: Map<string, number>;
}> {
  const perDateJCount = new Map<string, number>();
  const perDateDJCount = new Map<string, number>();

  const rl = createInterface({ input: createReadStream(INPUT), crlfDelay: Infinity });
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (!line.trim()) continue;
    const row = parseRow(line);
    if (!row) continue;
    if (row.round !== 1 && row.round !== 2) continue;
    if (!isValidAirDate(row.airDate)) continue;
    const map = row.round === 1 ? perDateJCount : perDateDJCount;
    map.set(row.airDate, (map.get(row.airDate) ?? 0) + 1);
  }

  const allDates = new Set<string>([...perDateJCount.keys(), ...perDateDJCount.keys()]);
  const completeDates = new Set<string>();
  for (const date of allDates) {
    const jCount = perDateJCount.get(date) ?? 0;
    const djCount = perDateDJCount.get(date) ?? 0;
    if (jCount >= COMPLETENESS_THRESHOLD && djCount >= COMPLETENESS_THRESHOLD) {
      completeDates.add(date);
    }
  }

  return { completeDates, distinctAirDates: allDates.size, perDateJCount, perDateDJCount };
}

// --- Pass 2: main stats derivation, restricted to complete games ---

interface RoundAccumulator {
  clueCountAtRow: [number, number, number, number, number];
  ddCountAtRow: [number, number, number, number, number];
  ddCountTotal: number; // all DD rows in this round, complete games, regardless of row status
  ddWagerFractions: number[]; // daily_double_value / era-aware round max
  // Post-2001-only diagnostic (row-0 share sanity check)
  postDdCountAtRow: [number, number, number, number, number];
  postDdCountTotal: number;
}

function newAccumulator(): RoundAccumulator {
  return {
    clueCountAtRow: [0, 0, 0, 0, 0],
    ddCountAtRow: [0, 0, 0, 0, 0],
    ddCountTotal: 0,
    ddWagerFractions: [],
    postDdCountAtRow: [0, 0, 0, 0, 0],
    postDdCountTotal: 0,
  };
}

async function main() {
  console.log(`Reading ${INPUT}`);
  console.log('Pass 1/2: tallying per-game round completeness...');
  const { completeDates, distinctAirDates } = await tallyGameCompleteness();
  console.log(`  ${distinctAirDates} distinct air_dates seen`);
  console.log(
    `  ${completeDates.size} games pass completeness filter (>= ${COMPLETENESS_THRESHOLD}/${FULL_ROUND_CLUES} clues in both rounds)`,
  );
  console.log(`  ${distinctAirDates - completeDates.size} games excluded (incomplete boards)`);

  console.log('Pass 2/2: deriving DD stats over complete games...');

  let totalRows = 0;
  let parsedRows = 0;
  let skippedMalformed = 0;
  let round1Rows = 0;
  let round2Rows = 0;
  let fjRows = 0;
  let otherRoundRows = 0;
  let anomalousValueRows = 0;
  let missingAirdateRows = 0;
  const ddCountTotalAllRows = { J: 0, DJ: 0 }; // global DD count, ALL rows (not just complete games)

  const acc: Record<RoundKey, RoundAccumulator> = { J: newAccumulator(), DJ: newAccumulator() };

  // Tiebreaker-clue signal check (PLAN.md E-1: tiebreaker clues aren't
  // distinguishable via a dedicated column in this schema — verify whether a
  // duplicate-category-per-(air_date, round) pattern reveals them instead of
  // just asserting "handled"). Tracks category name repeats within the same
  // air_date + round.
  const categoryCountByGameRound = new Map<string, Map<string, number>>();

  const rl = createInterface({ input: createReadStream(INPUT), crlfDelay: Infinity });
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (!line.trim()) continue;
    totalRows++;
    const row = parseRow(line);
    if (!row) {
      skippedMalformed++;
      continue;
    }
    parsedRows++;

    if (row.round === 3) {
      fjRows++;
      continue; // FJ: one row/game, clue_value 0, no row ladder — excluded by construction
    }
    if (row.round !== 1 && row.round !== 2) {
      otherRoundRows++;
      continue;
    }
    if (row.round === 1) round1Rows++;
    else round2Rows++;

    if (isValidAirDate(row.airDate)) {
      const gameRoundKey = `${row.airDate}|${row.round}`;
      let cats = categoryCountByGameRound.get(gameRoundKey);
      if (!cats) {
        cats = new Map();
        categoryCountByGameRound.set(gameRoundKey, cats);
      }
      const cat = row.category.trim();
      if (cat) cats.set(cat, (cats.get(cat) ?? 0) + 1);
    }

    const isDD = row.ddValue > 0;
    const roundKey = ROUND_KEY[row.round as 1 | 2];
    if (isDD) ddCountTotalAllRows[roundKey]++;

    const classification = classifyClue(row.airDate, row.round, row.clueValue);
    if (classification.status === 'missing-airdate') {
      missingAirdateRows++;
      continue; // can't group into a game or resolve era at all
    }
    if (classification.status === 'anomalous-value') {
      anomalousValueRows++;
      // era + roundMax still known: still usable for wager-vs-round-max,
      // but NOT for row-indexed ddRowWeights (no valid row).
      if (completeDates.has(row.airDate) && isDD) {
        acc[roundKey].ddWagerFractions.push(row.ddValue / classification.roundMax);
      }
      continue;
    }

    // status === 'ok': valid row index, complete era resolution
    if (!completeDates.has(row.airDate)) continue; // board-completeness filter

    const a = acc[roundKey];
    a.clueCountAtRow[classification.row]++;
    if (isDD) {
      a.ddCountAtRow[classification.row]++;
      a.ddCountTotal++;
      a.ddWagerFractions.push(row.ddValue / classification.roundMax);
      if (classification.era === 'post') {
        a.postDdCountAtRow[classification.row]++;
        a.postDdCountTotal++;
      }
    }
  }

  // --- Derive ddRowWeights: P(row | DD occurred, round), sums to 1 per round ---
  const ddRowWeights: Record<RoundKey, number[]> = { J: [], DJ: [] };
  for (const key of ['J', 'DJ'] as RoundKey[]) {
    const a = acc[key];
    ddRowWeights[key] =
      a.ddCountTotal > 0
        ? a.ddCountAtRow.map(c => c / a.ddCountTotal)
        : [0, 0, 0, 0, 0];
  }

  // --- Derive ddWagerVsRoundMax distribution summary, per round ---
  const ddWagerVsRoundMax: Record<RoundKey, ReturnType<typeof summarize>> = {
    J: summarize(acc.J.ddWagerFractions),
    DJ: summarize(acc.DJ.ddWagerFractions),
  };

  // --- Counts ---
  const counts = {
    totalRows,
    parsedRows,
    skippedMalformed,
    round1Rows,
    round2Rows,
    fjRows,
    otherRoundRows,
    anomalousValueRows,
    missingAirdateRows,
    distinctAirDates,
    completeGames: completeDates.size,
    excludedIncompleteGames: distinctAirDates - completeDates.size,
    completenessThreshold: COMPLETENESS_THRESHOLD,
    ddCountAllRows: ddCountTotalAllRows, // every DD row in the file, regardless of completeness/era
    ddCountUsedInStats: { J: acc.J.ddCountTotal, DJ: acc.DJ.ddCountTotal }, // complete games only
  };

  // ============================= Acceptance checks =============================
  console.log('\n=== Acceptance checks ===');

  const ddPerGame =
    (counts.ddCountUsedInStats.J + counts.ddCountUsedInStats.DJ) / completeDates.size;
  console.log(
    `DD count per complete game: ${ddPerGame.toFixed(3)} ` +
      `(J: ${(counts.ddCountUsedInStats.J / completeDates.size).toFixed(3)}, ` +
      `DJ: ${(counts.ddCountUsedInStats.DJ / completeDates.size).toFixed(3)}) — expect ~3 total (~1 J + ~2 DJ)`,
  );
  if (ddPerGame < 2.5 || ddPerGame > 3.5) {
    console.warn(
      `  WARNING: DD-per-game ratio (${ddPerGame.toFixed(3)}) diverges notably from the expected ~3 — investigate before trusting ddRowWeights.`,
    );
  }

  for (const key of ['J', 'DJ'] as RoundKey[]) {
    const bottom3Share = ddRowWeights[key].slice(2).reduce((a, b) => a + b, 0);
    console.log(
      `${key} bottom-3-rows (idx 2-4) share of DDs: ${(bottom3Share * 100).toFixed(1)}% — should be heavily favored (folklore: high)`,
    );
    if (bottom3Share < 0.6) {
      console.warn(
        `  WARNING: ${key} bottom-3-rows share (${(bottom3Share * 100).toFixed(1)}%) is lower than folklore expects (>60%) — surfaced, not silently shipped.`,
      );
    }
  }

  for (const key of ['J', 'DJ'] as RoundKey[]) {
    const a = acc[key];
    const postRow0Share = a.postDdCountTotal > 0 ? a.postDdCountAtRow[0] / a.postDdCountTotal : NaN;
    console.log(
      `${key} row-0 (top row) DD share, post-2001 only: ${(postRow0Share * 100).toFixed(2)}% ` +
        `(n=${a.postDdCountTotal} post-2001 DDs) — expect <= ~2%`,
    );
    if (!isNaN(postRow0Share) && postRow0Share > 0.05) {
      console.warn(
        `  WARNING: ${key} post-2001 row-0 DD share (${(postRow0Share * 100).toFixed(2)}%) is wildly divergent from the ~2% folklore ceiling — do not silently trust ddRowWeights[0] for ${key}.`,
      );
    }
  }

  if (counts.ddCountUsedInStats.J === 0 || counts.ddCountUsedInStats.DJ === 0) {
    throw new Error(
      'Aborting: zero DD rows parsed for J or DJ round after filtering — refusing to emit empty priors.',
    );
  }

  // ============================= Report =============================
  console.log('\n=== Summary ===');
  console.log(counts);
  console.log('\nddRowWeights.J  =', ddRowWeights.J.map(v => v.toFixed(4)));
  console.log('ddRowWeights.DJ =', ddRowWeights.DJ.map(v => v.toFixed(4)));
  console.log('\nddWagerVsRoundMax.J  =', ddWagerVsRoundMax.J);
  console.log('ddWagerVsRoundMax.DJ =', ddWagerVsRoundMax.DJ);

  // Tiebreaker-clue signal check (PLAN.md E-1: tiebreaker clues aren't
  // identified by a dedicated column in this schema; verify whether a
  // duplicate-category-per-(air_date, round) pattern reveals them, and
  // document the actual answer rather than claiming the edge case is
  // "handled").
  let gameRoundsWithDuplicateCategory = 0;
  for (const cats of categoryCountByGameRound.values()) {
    for (const count of cats.values()) {
      if (count > 1) {
        gameRoundsWithDuplicateCategory++;
        break;
      }
    }
  }
  console.log(
    `\nTiebreaker-clue signal check: ${gameRoundsWithDuplicateCategory} (air_date, round) ` +
      `combinations have a repeated category name, out of ${categoryCountByGameRound.size} checked. ` +
      (gameRoundsWithDuplicateCategory === 0
        ? 'No duplicate-category signal exists in this schema — tiebreaker clues are NOT ' +
          'distinguishable from this data (documented, not "handled").'
        : 'A nonzero duplicate-category signal exists but this script does not further ' +
          'disambiguate it (out of scope for ddRowWeights/ddWagerVsRoundMax) — documented for ' +
          'follow-up, not claimed as a solved tiebreaker detector.'),
  );

  // --- Write output ---
  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      file: 'combined_season1-41.tsv',
      ...counts,
    },
    ddRowWeights,
    ddWagerVsRoundMax,
  };

  const json = JSON.stringify(output, null, 2);
  writeFileSync(OUTPUT, json);
  console.log(`\nWrote ${OUTPUT} (${Math.round(json.length / 1024)}KB)`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
