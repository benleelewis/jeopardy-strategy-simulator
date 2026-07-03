/**
 * Coryat-based opponent calibration.
 *
 * Shared between sim-worker (for simulation) and GameDetail (for display).
 * Uses Coryat score to calibrate the overall b×p product, then splits
 * via precision ratio from correct/wrong counts.
 *
 * Model parameters:
 *   b = buzz attempt rate: fraction of clues the player attempts [0,1]
 *   p = precision: probability of being correct given they attempted [0,1]
 *   b×p = effective knowledge: probability of getting any random clue right
 *
 * Raw inference from TSV:
 *   opp.k = correct/(correct+wrong+1)  → precision when buzzing (selection-biased high)
 *   opp.b = (correct+wrong)/60         → activity rate
 *   opp.c = Coryat score               → captures knowledge × clue difficulty
 *
 * Calibration uses Coryat to set the b×p product (overall strength),
 * then uses the precision ratio to split between b and p.
 */

export function calibrateOpponent(opp: { k: number; b: number; fj: number; c: number }): {
  b: number; p: number; fjAccuracy: number;
} {
  // If no Coryat data, fall back to raw k/b
  if (!opp.c || opp.c <= 0) {
    return { b: opp.b, p: opp.k, fjAccuracy: opp.fj };
  }

  // Normalize Coryat to [0,1] — typical range $0-$25,000
  // Average Coryat across dataset is ~$11,000
  const coryatNorm = Math.min(opp.c / 25000, 1);

  // Raw precision from correct/(correct+wrong+1) — this measures accuracy
  // *when buzzing*, which is selection-biased high (players don't buzz when
  // they don't know). Use it as p directly since the sim's p parameter
  // also means "accuracy given buzz attempt."
  const precision = Math.max(opp.k, 0.3);

  // Use Coryat to calibrate buzz rate: b = coryatNorm / p
  // This captures that a high-Coryat player with modest precision must
  // be buzzing on more clues (higher activity).
  const b = Math.min(coryatNorm / precision, 0.95);

  return { b, p: precision, fjAccuracy: opp.fj };
}
