import type { DDEvent } from '../sim/sim-engine';

/**
 * Pure animation-script builder for GameReplay.tsx's "Watch this game"
 * feature (Phase 1D). Split out of GameReplay.tsx so the component file only
 * exports the component (react-refresh/only-export-components) — this file
 * has no JSX and no React import.
 */

export type RoundLabel = 'Jeopardy' | 'Double Jeopardy' | 'Final Jeopardy';

export interface Frame {
  scores: [number, number, number];
  round: RoundLabel;
  clueNumber?: number;
  totalClues?: number;
  /** Inferred board controller entering this clue (see buildFrames doc). */
  controller?: number;
  ddFlash?: { player: number; wager: number; correct: boolean };
  fjWagers?: [number, number, number];
  fjReveal?: { player: number; correct: boolean; wager: number };
  winnerReveal?: number;
  caption?: string;
  /** Playback duration at 1x speed. */
  durationMs: number;
}

const CLUE_MS = 180; // 60 clues * 180ms = 10.8s of J/DJ play
const DD_LINGER_MS = 550; // extra dwell time on a Daily Double reveal
const FJ_INTRO_MS = 1400;
const FJ_REVEAL_MS = 900;
const FJ_WINNER_MS = 1700;

/**
 * Turn one simulated game's `history` (60 clue-by-clue score snapshots, plus
 * an optional 61st Final Jeopardy snapshot — see sim-engine.ts's
 * `simulateGame` doc) into a script of animation frames.
 *
 * The engine doesn't record a persistent "who controls the board" beyond
 * Daily Doubles (regular clues are drawn in board order regardless of who
 * picks), so `controller` here is inferred: whoever's score just moved is
 * assumed to have picked the next clue, which matches how the real show
 * works. FJ wagers/correctness are similarly derived from the score delta
 * across the DJ→FJ boundary rather than threaded through the engine, so
 * sim-engine.ts (frozen for this task) never needs a new field.
 */
export function buildFrames(
  history: [number, number, number][],
  ddEvents: DDEvent[],
  names: [string, string, string],
): Frame[] {
  const frames: Frame[] = [];
  const clueSteps = Math.min(60, history.length);
  let controller = 0;

  for (let i = 0; i < clueSteps; i++) {
    const round: RoundLabel = i < 30 ? 'Jeopardy' : 'Double Jeopardy';
    const roundKey: 'J' | 'DJ' = i < 30 ? 'J' : 'DJ';
    const clueIndexInRound = i % 30;
    const dd = ddEvents.find(e => e.round === roundKey && e.clueIndex === clueIndexInRound);

    const scores = history[i];
    const prevScores: [number, number, number] = i === 0 ? [0, 0, 0] : history[i - 1];

    const frame: Frame = {
      scores,
      round,
      clueNumber: clueIndexInRound + 1,
      totalClues: 30,
      controller,
      durationMs: CLUE_MS,
    };

    if (dd) {
      frame.ddFlash = { player: dd.player, wager: dd.wager, correct: dd.correct };
      frame.caption = `Daily Double: ${names[dd.player]} wagered $${dd.wager.toLocaleString()}, ${dd.correct ? 'correct' : 'wrong'}`;
      frame.durationMs = CLUE_MS + DD_LINGER_MS;
    }
    frames.push(frame);

    // Whoever's score just changed is inferred to control the next pick.
    for (let p = 0; p < 3; p++) {
      if (scores[p] !== prevScores[p]) {
        controller = p;
        break;
      }
    }
  }

  if (history.length > clueSteps) {
    const preFJ: [number, number, number] = history[clueSteps - 1] ?? [0, 0, 0];
    const finalScores = history[history.length - 1];
    const wagers: [number, number, number] = [0, 0, 0];
    const corrects: [boolean, boolean, boolean] = [false, false, false];
    for (let p = 0; p < 3; p++) {
      const delta = finalScores[p] - preFJ[p];
      wagers[p] = Math.abs(delta);
      corrects[p] = delta >= 0;
    }

    frames.push({
      scores: preFJ,
      round: 'Final Jeopardy',
      caption: 'Final Jeopardy — wagers are locked in.',
      fjWagers: wagers,
      durationMs: FJ_INTRO_MS,
    });

    // Reveal the trailing player first, champion last — the show's order.
    const order = [0, 1, 2].sort((a, b) => preFJ[a] - preFJ[b]);
    let running: [number, number, number] = [...preFJ];
    for (const p of order) {
      running = [...running] as [number, number, number];
      running[p] = finalScores[p];
      frames.push({
        scores: running,
        round: 'Final Jeopardy',
        fjReveal: { player: p, correct: corrects[p], wager: wagers[p] },
        caption: wagers[p] === 0
          ? `${names[p]} didn't wager.`
          : `${names[p]}: ${corrects[p] ? 'correct' : 'wrong'} — wagered $${wagers[p].toLocaleString()}`,
        durationMs: FJ_REVEAL_MS,
      });
    }

    const maxScore = Math.max(...finalScores);
    const winner = finalScores.indexOf(maxScore);
    frames.push({
      scores: finalScores,
      round: 'Final Jeopardy',
      winnerReveal: winner,
      caption: `${names[winner]} wins with $${finalScores[winner].toLocaleString()}!`,
      durationMs: FJ_WINNER_MS,
    });
  }

  return frames;
}
