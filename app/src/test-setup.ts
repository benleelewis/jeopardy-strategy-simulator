// E-7 UI test infra: extends vitest's `expect` with jest-dom matchers
// (toBeDisabled, toHaveTextContent, etc.) for *.test.tsx files. Loaded via
// vite.config.ts's `test.setupFiles` — has no effect on the node-env
// *.test.ts sim suite (jest-dom's matchers are DOM-only but registering
// them is a no-op when no DOM assertions are made).
import '@testing-library/jest-dom/vitest';

// jsdom has no real Worker implementation. None of the *.test.tsx suites
// render components that construct one directly (ControlsPanel and
// GameAnalyzer build any V-tables on the main thread; HeatMap/App's real
// `new Worker(...)` usage is out of this test infra's scope), but this
// stub is a safety net per the plan's "mock the worker layer, don't spin
// real workers in jsdom" instruction, in case a future test imports
// something that constructs one.
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage() { /* no-op stub */ }
  terminate() { /* no-op stub */ }
  addEventListener() { /* no-op stub */ }
  removeEventListener() { /* no-op stub */ }
}
if (typeof globalThis.Worker === 'undefined') {
  // @ts-expect-error — intentionally a minimal stub, not a full Worker.
  globalThis.Worker = MockWorker;
}
