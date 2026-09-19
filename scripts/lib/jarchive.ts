/**
 * jarchive.ts — CLI-only wrapper around the shared J-Archive parser.
 *
 * The pure parsing/replay logic (HTML in, records out — no `fs`/`path`/
 * `fetch`) lives in `app/src/lib/jarchive.ts`, shared with the Vercel
 * serverless route (`app/api/jarchive.ts`). This file keeps only what a Node
 * CLI needs and a serverless function must not have: a disk cache and the
 * actual `fetch` that populates it.
 *
 * Fetch policy (CLAUDE.md): single-URL fetch only, never a bulk scrape.
 * `fetchGameHtml` caches to `data/jarchive-cache/` so re-running an analysis
 * costs zero requests.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

export * from '../../app/src/lib/jarchive';

const CACHE_DIR = resolve(__dirname, '../../data/jarchive-cache');

/**
 * Fetch one game page, caching the raw HTML. Re-running any analysis on a
 * game already seen makes zero network requests.
 */
export async function fetchGameHtml(gameId: number): Promise<string> {
  const cached = resolve(CACHE_DIR, `game-${gameId}.html`);
  if (existsSync(cached)) return readFileSync(cached, 'utf8');

  const url = `https://j-archive.com/showgame.php?game_id=${gameId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'jeopardy-sim/1.0' } });
  if (!res.ok) throw new Error(`J-Archive fetch failed: ${res.status} ${url}`);
  const html = await res.text();

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, html);
  return html;
}
