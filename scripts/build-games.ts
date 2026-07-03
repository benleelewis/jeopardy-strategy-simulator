/**
 * build-games.ts — Parse Jeopardy dataset TSVs into games.json
 *
 * Reads scoring_season1-41.tsv, filters out kids/teen/extra matches,
 * infers opponent skill profiles, and outputs a compact JSON file
 * for the contribution graph visualization.
 *
 * Usage: npx tsx scripts/build-games.ts
 * Output: app/public/games.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(__dirname, '../data/jeopardy_dataset_seasons_1-41');
const OUTPUT = resolve(__dirname, '../app/public/games.json');

// --- Types ---

interface ScoringRow {
  season: number;
  airDate: string;
  names: [string, string, string];
  single: [number, number, number];
  double: [number, number, number];
  final: [number, number, number];
  coryat: [number, number, number];
  correct: [number, number, number];
  wrong: [number, number, number];
}

export interface GameData {
  s: number;       // season
  d: string;       // airDate (YYYY-MM-DD)
  o: [OpponentData, OpponentData]; // two opponents
}

interface OpponentData {
  n: string;       // name
  k: number;       // knowledge (precision)
  b: number;       // buzzer (activity rate)
  fj: number;      // FJ accuracy estimate (0 or 1)
  c: number;       // Coryat score (raw dollars)
}

// --- Parse TSV ---

function parseTSV(path: string): string[][] {
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  return lines.map(l => l.split('\t'));
}

function parseScoring(path: string): ScoringRow[] {
  const rows = parseTSV(path);
  const header = rows[0];
  if (!header || !header.includes('season')) {
    throw new Error('Invalid scoring TSV — missing header');
  }

  return rows.slice(1).map(cols => {
    const num = (i: number) => {
      const v = parseFloat(cols[i]);
      return isNaN(v) ? NaN : v;
    };
    return {
      season: num(0),
      airDate: cols[1],
      names: [cols[2], cols[3], cols[4]] as [string, string, string],
      single: [num(5), num(6), num(7)] as [number, number, number],
      double: [num(8), num(9), num(10)] as [number, number, number],
      final: [num(11), num(12), num(13)] as [number, number, number],
      coryat: [num(14), num(15), num(16)] as [number, number, number],
      correct: [num(17), num(18), num(19)] as [number, number, number],
      wrong: [num(20), num(21), num(22)] as [number, number, number],
    };
  });
}

// --- Build exclusion set from kids/teen + extra matches ---

function getExcludedDates(kidsPath: string, extraPath: string): Set<string> {
  const dates = new Set<string>();

  for (const path of [kidsPath, extraPath]) {
    const rows = parseTSV(path);
    // air_date is column index 7 (0-indexed)
    for (let i = 1; i < rows.length; i++) {
      const date = rows[i][7];
      if (date && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        dates.add(date);
      }
    }
  }

  return dates;
}

// --- Infer opponent profile ---

function inferOpponent(
  name: string,
  correct: number,
  wrong: number,
  coryat: number,
  singleScore: number,
  doubleScore: number,
  finalScore: number,
): OpponentData | null {
  // Skip if data is invalid
  if (isNaN(correct) || isNaN(wrong) || isNaN(coryat) || isNaN(singleScore) || isNaN(doubleScore) || isNaN(finalScore)) {
    return null;
  }

  // Knowledge = accuracy when buzzing in (epsilon smoothing for 0/0)
  const knowledge = correct / (correct + wrong + 1);

  // Buzzer = activity rate (total attempts / total clues)
  // 60 clues total (30 J + 30 DJ), minus ~3 DDs = ~57 regular clues
  // But we don't know exact DD count per player, so use 60 as denominator
  const buzzer = Math.min((correct + wrong) / 60, 0.95);

  // FJ accuracy: if final > double, they got FJ right
  // If double <= 0, they didn't play FJ
  const fjAccuracy = doubleScore <= 0 ? 0 : (finalScore > doubleScore ? 1 : 0);

  return {
    n: name.trim(),
    k: Math.round(knowledge * 1000) / 1000,
    b: Math.round(buzzer * 1000) / 1000,
    fj: fjAccuracy,
    c: Math.round(coryat),
  };
}

// --- Main ---

function main() {
  console.log('Parsing scoring data...');
  const scoring = parseScoring(resolve(DATA_DIR, 'scoring_season1-41.tsv'));
  console.log(`  ${scoring.length} total rows`);

  console.log('Building exclusion set...');
  const excluded = getExcludedDates(
    resolve(DATA_DIR, 'kids_teen_matches.tsv'),
    resolve(DATA_DIR, 'extra_matches.tsv'),
  );
  console.log(`  ${excluded.size} excluded air dates`);

  console.log('Processing games...');
  const games: GameData[] = [];
  let skippedExcluded = 0;
  let skippedInvalid = 0;

  for (const row of scoring) {
    // Skip excluded dates
    if (excluded.has(row.airDate)) {
      skippedExcluded++;
      continue;
    }

    // Skip invalid season
    if (isNaN(row.season) || row.season < 1) {
      skippedInvalid++;
      continue;
    }

    // For the sim, "you" replace one contestant. We store the other two as opponents.
    // Convention: store all 3, user replaces one at runtime. But to save space,
    // store only 2 opponents (left + middle; user replaces "right" position).
    // Actually, for max flexibility, store all 3 and let runtime pick.
    // But that triples the size. Let's store the two strongest as opponents.

    // Infer all 3 profiles
    const profiles = [0, 1, 2].map(i =>
      inferOpponent(
        row.names[i],
        row.correct[i],
        row.wrong[i],
        row.coryat[i],
        row.single[i],
        row.double[i],
        row.final[i],
      ),
    );

    // Skip if any profile is invalid
    if (profiles.some(p => p === null)) {
      skippedInvalid++;
      continue;
    }

    // Store two opponents: index 0 = returning champion (left column in TSV),
    // index 1 = challenger (middle column). The third contestant (right column)
    // is the position the user replaces at simulation time.
    // Column 0 is always the champion — important for game fidelity.
    // Columns 1 vs 2 are both new challengers; choice is arbitrary.
    games.push({
      s: row.season,
      d: row.airDate,
      o: [profiles[0]!, profiles[1]!],
    });
  }

  console.log(`  ${games.length} valid games`);
  console.log(`  ${skippedExcluded} excluded (kids/teen/extra)`);
  console.log(`  ${skippedInvalid} skipped (invalid data)`);

  // Season stats
  const seasonCounts = new Map<number, number>();
  for (const g of games) {
    seasonCounts.set(g.s, (seasonCounts.get(g.s) || 0) + 1);
  }
  console.log('\nGames per season:');
  for (const [s, count] of [...seasonCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  S${String(s).padStart(2, '0')}: ${count}`);
  }

  // Write output
  const json = JSON.stringify(games);
  writeFileSync(OUTPUT, json);
  const sizeKB = Math.round(json.length / 1024);
  console.log(`\nWrote ${OUTPUT} (${sizeKB}KB, ${games.length} games)`);
}

main();
