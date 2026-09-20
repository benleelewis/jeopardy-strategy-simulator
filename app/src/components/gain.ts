/**
 * Shared helpers for the All Games "Gain from optimal play" colour mode
 * (TODOS "P2 — All Games optimal-vs-actual delta coloring"). Plain module
 * (no components) so ContributionGraph and GainHeader can both import it
 * without tripping the fast-refresh only-export-components rule.
 */

/** All Games colour mode. 'winRate' is today's graph; 'gain' colours each
 *  game by winRate(optimal strategy) - winRate(current settings), paired seeds. */
export type ColorMode = 'winRate' | 'gain';

/** Gain-mode data: the two paired arms per game (parallel to `games`).
 *  The cell value is `optimal[i] - actual[i]`; the headline uses both means. */
export interface GainData {
  /** Win rate with the settings as currently set. */
  actual: number[];
  /** Win rate with ddStrategy 'equity' + squareSelection 'ddSeek'. */
  optimal: number[];
}

/** Diverging buckets for gain mode, in win-rate fraction. With 25 sims/game
 *  the per-game gain moves in 0.04 steps, so the edges sit between steps
 *  (0.10 between 0.08 and 0.12; 0.22 between 0.20 and 0.24) — float noise
 *  in `optimal - actual` can never flip a bucket. */
export const GAIN_NEUTRAL = 0.10;
export const GAIN_STRONG = 0.22;

/** "+9pp" / "−3pp" / "0pp" — a gain in win-rate fraction as signed points. */
export function formatGain(g: number): string {
  const pp = Math.round(g * 100);
  if (pp > 0) return `+${pp}pp`;
  if (pp < 0) return `−${Math.abs(pp)}pp`;
  return '0pp';
}

/** Mean of each arm — the two numbers in the headline. */
export function gainMeans(gain: GainData | null): { from: number; to: number; total: number } | null {
  if (!gain || gain.actual.length === 0) return null;
  let sumActual = 0;
  let sumOptimal = 0;
  for (let i = 0; i < gain.actual.length; i++) {
    sumActual += gain.actual[i];
    sumOptimal += gain.optimal[i];
  }
  const total = gain.actual.length;
  return { from: sumActual / total, to: sumOptimal / total, total };
}

const NEUTRAL_PP = Math.round(GAIN_NEUTRAL * 100);
// The strong edge sits just above the nominal 20pp step (see GAIN_STRONG),
// so the legend speaks in the round number the buckets actually separate.
const STRONG_PP = Math.round((GAIN_STRONG - 0.02) * 100);

/** Diverging legend swatches: blue = worse, neutral = about the same, gold = better. */
export const GAIN_LEGEND = [
  { cssVar: '--cg-2', fallback: '#0a1566', label: `worse by ${STRONG_PP}pp+` },
  { cssVar: '--cg-3', fallback: '#1a3ba8', label: `worse by ${NEUTRAL_PP}–${STRONG_PP}pp` },
  { cssVar: '--cg-neutral', fallback: '#9aa0ad', label: `within ±${NEUTRAL_PP}pp` },
  { cssVar: '--cg-4', fallback: '#c5a028', label: `better by ${NEUTRAL_PP}–${STRONG_PP}pp` },
  { cssVar: '--cg-5', fallback: '#f5d442', label: `better by ${STRONG_PP}pp+` },
];
