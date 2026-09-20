/**
 * backtest.ts — "Backtest this game" from the command line.
 *
 * Same module the app's button runs (app/src/sim/backtest.ts), so the numbers
 * printed here can be checked against the browser's table.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts --game 9501
 *   npx tsx scripts/backtest.ts --game 9501 --seat 1 --sims 3000 --seed 7
 *   npx tsx scripts/backtest.ts --game 9501 --who Grace --p 0.8
 *
 * Options:
 *   --game <id>     J-Archive game_id (cached in data/jarchive-cache/)
 *   --seat <0..2>   Podium seat to analyse (default: every contestant who hit a DD)
 *   --who <name>    Same, by nickname
 *   --sims <n>      Rollouts per arm (default 1500)
 *   --seed <n>      RNG base seed (default: the module's)
 *   --p <0..1>      Override P(right) on the analysed player's DDs
 *   --table         Build the app's V(S) table first (~seconds) and use it
 *                   for Double-Jeopardy equity wagers, as the browser does
 *                   when Optimal (equity) has been built
 */

import { fetchGameHtml, parseGame, replay, gameRecord } from './lib/jarchive';
import {
  backtestGame, backtestHeadline, ARM_LABELS, BACKTEST_ARMS, BACKTEST_ROLLOUTS_PER_ARM,
  type BacktestResult, type ArmEstimate,
} from '../app/src/sim/backtest';
import { buildValueTable, type ValueTable } from '../app/src/sim/value-function';
import { OPPONENT_PROFILES } from '../app/src/sim/opponent-models';
import { DEFAULT_CONFIG, mulberry32 } from '../app/src/sim/sim-engine';

function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

const A = args();
const usd = (n: number) => (n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function cell(est: ArmEstimate | null, isActual: boolean): string {
  if (!est) return 'skipped'.padEnd(26);
  const delta = isActual
    ? ''
    : ` (${est.deltaVsActual >= 0 ? '+' : '−'}${(Math.abs(est.deltaVsActual) * 100).toFixed(1)} ± ${(est.deltaSe * 100).toFixed(1)})`;
  return `${usd(est.wager).padStart(8)} → ${pct(est.winRate).padStart(6)}${delta}`.padEnd(26);
}

export function printBacktest(result: BacktestResult): void {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`BACKTEST — ${result.you} (seat ${result.seat}), ${result.rolloutsPerArm.toLocaleString()} rollouts per arm, seed ${result.seed}`);
  console.log('='.repeat(78));
  console.log('Calibrated players: ' + result.players.map(p =>
    `${p.name} b=${p.b.toFixed(2)} p=${p.p.toFixed(2)} buzz=${p.buzzerSpeed.toFixed(2)} fj=${p.fjAccuracy.toFixed(2)}`).join(' | '));

  if (result.rows.length === 0) {
    console.log(`\n${backtestHeadline(result)}\n`);
    return;
  }

  console.log('\nPer Daily Double (wager → win chance; delta vs. actual ± paired SE, in points):');
  const header = ['DD'.padEnd(20), ...BACKTEST_ARMS.map(a => ARM_LABELS[a].padEnd(26))].join('  ');
  console.log('  ' + header);
  console.log('  ' + '-'.repeat(header.length));
  for (const row of result.rows) {
    const label = `${row.round} clue ${row.order} (${usd(row.clueValue)})`.padEnd(20);
    const cells = BACKTEST_ARMS.map(a => cell(row.arms[a], a === 'actual'));
    console.log('  ' + [label, ...cells].join('  '));
    console.log(`  ${''.padEnd(20)}  scores before: ${row.allScoresBefore.map(usd).join(' / ')}; ` +
      `${row.cluesRemainingAfter} clues left; you were ${row.actualCorrect ? 'right' : 'wrong'}; ` +
      `equity wager from ${row.equitySource}`);
  }

  if (result.summary) {
    console.log(`\nWhole game, each strategy at every Daily Double you hit (from ${result.summary.fromLabel}):`);
    for (const arm of BACKTEST_ARMS) {
      const est = result.summary.arms[arm];
      if (!est) { console.log(`  ${ARM_LABELS[arm].padEnd(18)} skipped`); continue; }
      const delta = arm === 'actual' ? '' :
        `   (${est.deltaVsActual >= 0 ? '+' : '−'}${(Math.abs(est.deltaVsActual) * 100).toFixed(1)} ± ${(est.deltaSe * 100).toFixed(1)} pts vs. actual)`;
      console.log(`  ${ARM_LABELS[arm].padEnd(18)} ${pct(est.winRate).padStart(6)} ± ${(est.se * 100).toFixed(1)}${delta}`);
    }
  }

  console.log(`\n${backtestHeadline(result)}`);
  console.log('\nNotes:');
  for (const n of result.notes) console.log(`  - ${n}`);
  console.log();
}

async function main(): Promise<void> {
  if (!A.game) throw new Error('Pass --game <id> (see header for usage)');
  const html = await fetchGameHtml(Number(A.game));
  const game = parseGame(html);
  const rep = replay(game);

  console.log(`\n${game.title}`);
  console.log(`Contestants: ${game.players.join(', ')}`);
  if (rep.validation.mismatches.length > 0) {
    console.log('\n!! Score reconstruction disagrees with J-Archive checkpoints:');
    for (const m of rep.validation.mismatches) {
      console.log(`   ${m.label} expected ${m.expected} got ${m.actual}`);
    }
    console.log('   Results below are NOT trustworthy — fix the parser first.\n');
  } else {
    console.log(`Score reconstruction verified against ${rep.validation.checked} J-Archive checkpoints.`);
  }

  const record = gameRecord(game);

  let valueTable: ValueTable | undefined;
  if (A.table) {
    const t0 = Date.now();
    process.stdout.write('Building the V(S) table (average opponents, app defaults)... ');
    valueTable = buildValueTable(OPPONENT_PROFILES.average, DEFAULT_CONFIG, mulberry32(0xF00D));
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  }

  let seats: number[];
  if (A.seat !== undefined) {
    seats = [Number(A.seat)];
  } else if (A.who !== undefined) {
    const idx = game.players.indexOf(String(A.who));
    if (idx < 0) throw new Error(`No contestant named "${A.who}" (have: ${game.players.join(', ')})`);
    seats = [idx];
  } else {
    seats = game.players
      .map((_, i) => i)
      .filter(i => record.steps.some(s => s.isDD && s.ddPlayer === i));
    if (seats.length === 0) seats = [0];
  }

  for (const seat of seats) {
    const t0 = Date.now();
    let lastPct = -1;
    const result = backtestGame(record, {
      seat,
      valueTable,
      rolloutsPerArm: A.sims !== undefined ? Number(A.sims) : BACKTEST_ROLLOUTS_PER_ARM,
      seed: A.seed !== undefined ? Number(A.seed) : undefined,
      pCorrect: A.p !== undefined ? Number(A.p) : undefined,
      onProgress: p => {
        const tenth = Math.floor(p * 10);
        if (tenth > lastPct) { lastPct = tenth; process.stdout.write(tenth === 10 ? '100%\n' : `${tenth * 10}% `); }
      },
    });
    if (!result) throw new Error('cancelled');
    printBacktest(result);
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);
  }
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
