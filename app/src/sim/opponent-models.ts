/**
 * Opponent models calibrated from Tesauro 2012 (~3000 J! Archive episodes).
 *
 * b = buzz attempt rate (probability of attempting to buzz on any clue)
 * p = precision (probability of answering correctly given a buzz)
 * fjAccuracy = Final Jeopardy accuracy
 */

export interface OpponentProfile {
  name: string;
  b: number;
  p: number;
  fjAccuracy: number;
}

export const OPPONENT_PROFILES: Record<string, OpponentProfile> = {
  average: { name: 'Average', b: 0.61, p: 0.87, fjAccuracy: 0.50 },
  champion: { name: 'Champion (TOC)', b: 0.80, p: 0.89, fjAccuracy: 0.60 },
  grandChampion: { name: 'Grand Champion', b: 0.855, p: 0.915, fjAccuracy: 0.66 },
};

/** Famous player benchmarks from tsx prototype + Tesauro data */
export interface FamousPlayer {
  name: string;
  accuracy: number;  // precision (p)
  buzzIn: number;    // buzz attempt rate (b)
  knowledge: number; // b * p (composite)
  /** Known or estimated positions for each dimension axis.
   *  Players without a value for a given axis show as estimated (dashed ring). */
  positions: Partial<Record<string, number>>;
  /** Which dimension values are estimated vs known from data */
  estimated?: Set<string>;
}

export const FAMOUS_PLAYERS: FamousPlayer[] = [
  {
    name: 'Ken Jennings',
    accuracy: 0.89, buzzIn: 0.45, knowledge: 0.89 * 0.45,
    positions: { knowledge: 0.89 * 0.45, buzzerSpeed: 0.45, ddAggression: 0.55, opponentStrength: 0.5 },
    estimated: new Set(['ddAggression']),
  },
  {
    name: 'James Holzhauer',
    accuracy: 0.86, buzzIn: 0.50, knowledge: 0.86 * 0.50,
    positions: { knowledge: 0.86 * 0.50, buzzerSpeed: 0.50, ddAggression: 0.95, opponentStrength: 0.5 },
    // DD aggression is known — Holzhauer is famously aggressive
  },
  {
    name: 'Brad Rutter',
    accuracy: 0.87, buzzIn: 0.42, knowledge: 0.87 * 0.42,
    positions: { knowledge: 0.87 * 0.42, buzzerSpeed: 0.42, ddAggression: 0.60, opponentStrength: 0.5 },
    estimated: new Set(['ddAggression']),
  },
  {
    name: 'Amy Schneider',
    accuracy: 0.85, buzzIn: 0.43, knowledge: 0.85 * 0.43,
    positions: { knowledge: 0.85 * 0.43, buzzerSpeed: 0.43, ddAggression: 0.65, opponentStrength: 0.5 },
    estimated: new Set(['ddAggression']),
  },
  {
    name: 'Watson (IBM)',
    accuracy: 0.85, buzzIn: 0.48, knowledge: 0.85 * 0.48,
    positions: { knowledge: 0.85 * 0.48, buzzerSpeed: 0.48, ddAggression: 0.80, opponentStrength: 1.0 },
    // Watson played against grand champions (Jennings + Rutter)
  },
  {
    name: 'Average',
    accuracy: 0.68, buzzIn: 0.28, knowledge: 0.68 * 0.28,
    positions: { knowledge: 0.68 * 0.28, buzzerSpeed: 0.28, ddAggression: 0.25, opponentStrength: 0.0 },
  },
];
