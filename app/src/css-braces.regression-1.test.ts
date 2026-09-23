// Regression: ISSUE-007 — two merges dropped closing braces in App.css, so
// every later rule was parsed as nested inside .visually-hidden:focus-within
// and silently stopped applying (unstyled Share button, broken mobile layout).
// Found by /qa on 2026-09-23
// Report: .gstack/qa-reports/qa-report-jeopardy-strategy-simulator-vercel-app-2026-09-23.md
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Read from disk: Vitest hands CSS imports back empty, even with ?raw.
const css = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

/** Brace depth after each character, ignoring comments and strings. */
function braceDepths(css: string): { final: number; min: number } {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\.|(?!\1).)*\1/g, '');
  let depth = 0;
  let min = 0;
  for (const ch of stripped) {
    if (ch === '{') depth++;
    if (ch === '}') min = Math.min(min, --depth);
  }
  return { final: depth, min };
}

describe('stylesheets close every rule they open', () => {
  it.each(['App.css', 'index.css'])('%s', name => {
    expect(braceDepths(css(name))).toEqual({ final: 0, min: 0 });
  });
});
