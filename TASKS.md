# Jeopardy Strategy Simulator — Task Tracker

*Updated 2026-07-04 — PLAN.md (approved via /autoplan) implemented; see Phase D below*

## Phase D: Equity Wagering + Calibration + Honest Axes (PLAN.md — IMPLEMENTED 2026-07-04)
- [x] P-0: baseline commit (app/ into git for the first time), dataset gitignored
- [x] E-0: seeded RNG, simulateFromState, per-player DD strategy, board control (tests 30→46)
- [x] E-1: clue-stats pipeline — empirical DD priors from 9,064 games (row 3 is the DD mode, not bottom row)
- [x] E-2: skill-aware V(S) rollout table (47KB, ~4s build, ratio-parameterized)
- [x] E-3: 'equity' DD strategy ($5 floor, type-excluded from ddWager switch)
- [x] E-4: dual-config validation — **paper replication PASSES: 36.4/43.2/55.2 vs 36/45/55** (you = 2nd-place player, per notebook)
- [x] E-5: closed-form + equity FJ (equity from 2nd place beats all-in by +11.4pp)
- [x] E-6: empirical priors wired with visible fallback; difficulty curves documented (no contradiction demonstrable)
- [x] E-7: DD Strategy radiogroup, V-table worker lifecycle, knob pinning, equity mini-chart + confidence slider, DD heat strip, All Games 10→25 sims/game, first UI tests (tests 69→88)
- [x] P-1: axis preset pills A/B/C with format()/unit + buzz-race calibration curve
- [x] P-2: dash-pattern contour confidence + refined pass 300→450 games/cell
- [x] P-3: journey bridge (marker pulse + link to All Games)
- [x] P-4: YourNumber above GamesControls
- [x] Deploy to Vercel — live at https://jeopardy-strategy-simulator.vercel.app
- [ ] **C1 checkpoint**: Ben re-rates the Explorer on the deployed app (target ≥7/10)
- [ ] Polish: heat map title overlaps top axis label (smoke-test finding)

## Phase 0: Setup
- [x] Read all PDFs and handoff documents
- [x] Summarize research insights (BRAINSTORM.md)
- [x] Recover prototypes (jeopardy-simulator-v2.html, jeopardy_simulator.tsx)
- [x] CEO review — scope expansion, approach decisions locked in
- [x] Initialize git repo
- [x] Scaffold React + Vite + TypeScript project
- [x] Set up Vitest
- [ ] Deploy to Vercel (empty shell)

## Phase 1A: Simulation Engine (sim-engine.ts)
- [x] Port v2 simulation logic to TypeScript (pure functions, zero deps)
- [x] DRY: single `simulateRound(clueValues, players, scores)` function
- [x] Add NaN guard (skip clue when totalWeight=0)
- [x] Add wrong answer penalties (buzz + wrong = lose points + rebound)
- [x] Add difficulty scaling by clue value (from tsx model)
- [x] Add correlated buzz/accuracy (ρ_b=0.2, ρ_p=0.2)
- [x] Upgrade opponent model to Tesauro parameters (Average/Champion/Grand Champion)
- [x] Add Daily Doubles (1 J-round, 2 DJ-round, bottom-row placement bias)
- [x] Add DD wagering logic (conservative/aggressive/true DD)
- [x] Add Final Jeopardy (score-position wagering, correlated accuracy)
- [x] Write Vitest unit tests (boundary values, monotonicity, Ben's game scenario)
- [x] Set up Web Worker (sim-worker.ts) with progress updates

## Phase 1B: Heat Map Visualization
- [x] Set up D3 inside React (useRef + useEffect pattern)
- [x] Port heat map rendering from v2 (Voronoi → contour)
- [x] Add iso-win contour lines (33%, 50%, 67% win rate)
- [x] Add famous player markers (Jennings, Holzhauer, Rutter, Amy, Watson, Average)
- [x] Add draggable "YOU" marker with touch support (CSS touch-action: none)
- [x] Debounce/throttle rapid drag events (rAF throttle — SVG updates immediately, React state throttled to 60fps)
- [x] Marginal return display + bottleneck indicator
- [x] Adaptive resolution: 20×20 fast → 50×50 refined in background
- [x] Worker crash handler → fallback to main-thread reduced-resolution

## Phase 1C: Controls Panel
- [x] Opponent field strength slider (Average → Champion → Grand Champion)
- [x] DD strategy selector (off / conservative / aggressive)
- [x] FJ toggle (on/off)
- [ ] Simulation count slider (speed vs accuracy)
- [x] Theme toggle (clean / Jeopardy blue-gold via CSS variables)
- [x] Cancel in-flight Worker when settings change

## Phase A: N-Dimensional Strategy Space (COMPLETE)
- [x] DimensionConfig interface + DIMENSIONS registry (dimensions.ts)
- [x] Extract gaussianBlur2D to math-utils.ts (DRY)
- [x] Continuous ddWagerFraction parameter on SimConfig
- [x] Piecewise linear opponent interpolation (interpolateOpponent)
- [x] buildSimParams() for axis-agnostic parameter sweeps
- [x] Refactor sim-worker.ts for arbitrary axis dimensions
- [x] Clickable axis labels with popover selector (Bret Victor direct manipulation)
- [x] Auto-hide pinned controls when dimension promoted to axis
- [x] Famous player positions for all 4 axes (estimated + uncertainty rings)
- [x] Dynamic StatsPanel labels from current axes
- [x] 30 tests passing (14 new for dimensions/axes)

## Phase B: Real Data Pipeline + Contribution Graph (COMPLETE — pending visual check)
- [x] Parse scoring TSV → opponent profiles per game (scripts/build-games.ts)
- [ ] Parse combined TSV → DD placements per game (deferred — scoring data sufficient for V1)
- [x] Filter: exclude kids/teen, extra matches, incomplete data (8,665 games after filtering)
- [x] Output games.json to app/public/ (1078KB, 192KB gzipped)
- [x] Extend sim-worker.ts with simAllGames message type
- [x] Canvas-based ContributionGraph component (8K+ squares)
- [x] GameDetail panel (click a square → opponent info, win rate)
- [x] Tab navigation: [Explorer] [All Games]
- [x] Link views: position state shared, worker triggers on position change
- [x] Progressive rendering: 1 sim/game fast → 5 sims/game refined (auto-triggers refined pass after fast completes)
- [x] "Your Number" headline stat + histogram + streak + breakdown (YourNumber.tsx)
- [x] Marginal Returns panel — bottleneck dimension identification (MarginalReturns.tsx)
- [ ] Verify all new features end-to-end in browser (visual check)
- [x] Performance tuning: rAF drag throttle, 300ms debounce on all-games sim, persistent worker, lazy tab sim

## Phase C: Your Game + Marginal Returns (COMPLETE)
- [x] GameAnalyzer component — manual entry form with presets (Ben's Game, Average, Strong)
- [x] Live knowledge/buzzer estimate preview from correct/wrong counts
- [x] DD and FJ wager entry (advanced section)
- [x] Estimate → position mapping, auto-navigate to Explorer tab
- [x] "Your Number" headline stat on All Games tab (win rate, streak, histogram)
- [x] Marginal Returns panel on Explorer side panel (bottleneck dimension identification)
- [x] 3-tab navigation: [Your Game] [Explorer] [All Games]
- [x] "Skip to Explorer" link for users who want to jump straight in

## Phase 1D: Animated Game Replay (FUTURE)
- [ ] Game state tracker (clue-by-clue score evolution)
- [ ] 15-second animation with D3 transitions
- [ ] DD flash + FJ dramatic resolution
- [ ] Cancel/restart controls (track animation ID)
- [ ] "Watch a Game" button in main UI

## Phase 1E: Game Outcome Histogram (SUPERSEDED by Your Number)
- [x] Run sims from current position → histogram in YourNumber component
- [ ] Score distribution with D3 (future enhancement)
- [ ] Win margin histogram
- [ ] Variance visualization (tight vs wide distributions)

## Phase 1F: Personal Game Analyzer (PARTIALLY COMPLETE)
- [x] Manual entry form (correct/wrong counts, Coryat, DD/FJ wagers)
- [x] Input validation (reasonable ranges)
- [ ] J-Archive single-URL fetch (with CORS fallback) — needs Vercel API route
- [ ] J-Archive HTML parser (try/catch → "couldn't parse" + manual entry)
- [x] Show game position on heat map (estimate → Explorer position)
- [ ] DD wager analysis ("You bet $5000. Optimal was $12,400.")
- [ ] What-if replay with different wagers

## Phase 1G: Data
- [ ] Curate static dataset from recent Jeopardy scorecards (JSON)
- [ ] Calibrate opponent models against real buzz-in % data
- [ ] Ship static JSON with the app (no live fetching for baseline data)

## Phase 2: Ladder of Abstraction (Future)
- [ ] View routing (Heat Map | Game Replay | Histogram | Analyzer)
- [ ] Strategy comparison — side-by-side heat maps
- [ ] Full parameter space — grid of heat maps for different opponent fields
- [ ] Linked views (selecting position in one updates all others)

## Phase 3: Real Data & Community (Future)
- [ ] Full J-Archive dataset integration (curated, static)
- [ ] Backtest Ben's game (ep #8276) with different strategies
- [ ] Community features (sharing, leaderboards)
- [ ] Advanced 3-factor axis model toggle

## TODOS (from CEO review)
- [ ] **P2**: DD impact difference map overlay — show WHERE DD strategy matters most on the K×B space
- [x] **P2**: Shareable URL — encode position + settings in URL hash for bookmarking/sharing (implemented in App.tsx with replaceState)
- [ ] **P3**: Study planner — "If you study X hours, knowledge moves Y%" (needs data calibration first)

## Strategies to Test (see BRAINSTORM.md)
1. DD hunting impact (Holzhauer style vs top-down)
2. Aggressive vs conservative DD wagering across K×B space
3. Opponent field strength sensitivity
4. FJ "lock game" threshold effects
5. Spiked vs uniform category knowledge
6. Wrong answer penalty impact on heat map shape
7. Ben's game replay with optimal strategy
8. Multi-game tournament dynamics
