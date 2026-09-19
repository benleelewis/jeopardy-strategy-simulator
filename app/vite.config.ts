/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // `/api/*` (app/api/jarchive.ts) only exists as a Vercel serverless
      // function — `vite dev` doesn't serve it on its own. Run
      // `vercel dev --listen 3000` alongside `npm run dev` to exercise the
      // J-Archive import locally; see README's "Local dev: J-Archive
      // import" section. Without that running, GameAnalyzer's Load button
      // shows a "not available in this dev server" message instead of
      // silently failing (it sniffs for the HTML this proxy target returns
      // when nothing is listening / not configured).
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    // E-7: UI test infra. Default environment stays 'node' — the existing
    // sim-engine.test.ts suite is pure logic (no DOM) and jsdom would only
    // add overhead there. *.test.tsx files (React component interaction
    // tests) opt into jsdom individually via a `// @vitest-environment
    // jsdom` docblock at the top of each file (this vitest version's
    // InlineConfig doesn't expose `environmentMatchGlobs`), so the
    // node-env sim tests are completely untouched.
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // @testing-library/react's auto-cleanup-after-each only self-registers
    // when it detects a global `afterEach` — required so *.test.tsx renders
    // don't leak DOM across tests within a file (every test file still
    // imports describe/it/expect explicitly; this only adds the globals
    // RTL's internal detection needs).
    globals: true,
  },
})
