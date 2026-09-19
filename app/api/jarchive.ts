/**
 * GET /api/jarchive?game=<id>
 *
 * Vercel serverless function (Node runtime). Fetches exactly one J-Archive
 * `showgame.php` page server-side — avoiding the browser CORS restriction
 * that blocks fetching j-archive.com directly from GameAnalyzer — parses it
 * with the shared parser, and returns the result as JSON.
 *
 * Fetch policy (CLAUDE.md): single-URL fetch only, never a bulk scrape.
 * `game` must be one positive integer; an array (`?game=1&game=2`) or a
 * comma list is rejected the same as any other malformed input — this route
 * never fetches more than one page per request.
 *
 * Response codes:
 *   200 — parsed game JSON, edge-cached for a day (a finished J-Archive game
 *         never changes, and serverless has no disk to cache to the way
 *         scripts/lib/jarchive.ts's CLI wrapper does).
 *   400 — `game` missing / not a single positive integer.
 *   502 — the upstream fetch to j-archive.com failed.
 *   422 — fetched fine, but the replay didn't validate against J-Archive's
 *         own score checkpoints (or nothing recognizable as a 3-player game
 *         was found) — a parsing problem, not a network one.
 *
 * Deliberately typed as a plain `(req, res)` Node handler rather than
 * `VercelRequest`/`VercelResponse` from `@vercel/node`, to avoid adding that
 * as a dependency — Vercel's Node runtime augments the real `req`/`res` with
 * `.query`/`.status()`/`.json()`/`.send()` at runtime regardless of what
 * this file imports for types.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { parseGame, replay, playerStats, type JArchiveGameResponse } from '../src/lib/jarchive';

interface VercelLikeRequest extends IncomingMessage {
  query: Record<string, string | string[] | undefined>;
}

interface VercelLikeResponse extends ServerResponse {
  status(code: number): VercelLikeResponse;
  json(body: unknown): VercelLikeResponse;
  send(body: string): VercelLikeResponse;
}

const jarchiveUrl = (id: number) => `https://j-archive.com/showgame.php?game_id=${id}`;

function sendPlainText(res: VercelLikeResponse, code: number, message: string): void {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(code).send(message);
}

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  const raw = req.query.game;

  // Never accept a list — exactly one scalar id, and it must look like one.
  if (Array.isArray(raw) || raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    sendPlainText(res, 400, 'game must be a single positive integer, e.g. ?game=9501');
    return;
  }
  const gameId = Number(raw);

  let html: string;
  try {
    const upstream = await fetch(jarchiveUrl(gameId), {
      headers: { 'User-Agent': 'jeopardy-sim/1.0' },
    });
    if (!upstream.ok) {
      sendPlainText(res, 502, `Couldn't reach J-Archive for game ${gameId} (HTTP ${upstream.status}).`);
      return;
    }
    html = await upstream.text();
  } catch {
    sendPlainText(res, 502, `Couldn't reach J-Archive for game ${gameId}. Check the game ID and try again.`);
    return;
  }

  const game = parseGame(html);
  const rep = replay(game);

  const parsedOk = game.players.length === 3
    && rep.validation.checked > 0
    && rep.validation.mismatches.length === 0;
  if (!parsedOk) {
    sendPlainText(res, 422, "couldn't parse — try manual entry instead.");
    return;
  }

  const stats = playerStats(game);
  const contestants = game.players.map((name, i) => ({
    name,
    correct: stats[i].correct,
    wrong: stats[i].wrong,
    coryat: stats[i].coryat,
    finalScore: game.fj?.finalScores[i] ?? rep.endOfRound.DJ[i] ?? stats[i].coryat,
  }));

  const dailyDoubles = rep.steps
    .filter(s => s.clue.isDD)
    .map(s => {
      const who = s.clue.right ?? s.clue.wrong[0] ?? null;
      const idx = who !== null ? game.players.indexOf(who) : -1;
      return {
        round: s.clue.round,
        clueValue: s.clue.boundValue,
        who,
        scoreBefore: idx >= 0 ? s.before[idx] : null,
        wager: s.clue.wager ?? 0,
        correct: s.clue.right !== null,
        scoreAfter: idx >= 0 ? s.after[idx] : null,
        allScoresBefore: s.before as [number, number, number],
        cluesRemainingAfter: s.remainingValues.length,
      };
    });

  const body: JArchiveGameResponse = {
    gameId: game.gameId ?? gameId,
    title: game.title,
    players: game.players,
    fullNames: game.fullNames,
    validation: rep.validation,
    contestants,
    dailyDoubles,
  };

  res.setHeader('Cache-Control', 'public, s-maxage=86400');
  res.status(200).json(body);
}
