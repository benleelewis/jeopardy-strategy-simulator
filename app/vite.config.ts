/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
