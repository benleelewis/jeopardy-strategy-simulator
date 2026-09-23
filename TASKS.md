# Jeopardy Strategy Simulator — Task Tracker

*Updated 2026-09-23 — /qa pass on the live site: 7 fixes, report in .gstack/qa-reports/*

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
- [x] Polish: heat map title overlap — real cause was the YOU marker drawn untransformed for a frame on grid rebuild; fixed 2026-09-11

## Phase 0: Setup
- [x] Read all PDFs and handoff documents
- [x] Summarize research insights (BRAINSTORM.md)
- [x] Recover prototypes (jeopardy-simulator-v2.html, jeopardy_simulator.tsx)
- [x] CEO review — scope expansion, approach decisions locked in
- [x] Initialize git repo
- [x] Scaffold React + Vite + TypeScript project
- [x] Set up Vitest
- [x] Deploy to Vercel (empty shell) — superseded, live since 2026-09-08

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
- [x] Simulation count slider (speed vs accuracy) — Fast/Normal/Precise, 2026-09-11
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
- [x] Verify all new features end-to-end in browser (visual check) — /qa 2026-09-23, health 87 → 98
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
- [x] 15-second animation with D3 transitions — GameReplay, 2026-09-19
- [x] DD flash + FJ dramatic resolution — 2026-09-19
- [x] Cancel/restart controls (track animation ID) — play/pause/restart/speed/scrubber, timers cleared on unmount, 2026-09-19
- [x] "Watch a Game" button in main UI — in GameDetail, 2026-09-19

## Phase 1E: Game Outcome Histogram (SUPERSEDED by Your Number)
- [x] Run sims from current position → histogram in YourNumber component
- [x] Score distribution — OutcomeDistribution panel in the Explorer, 2026-09-20
- [x] Win margin histogram — 2026-09-20
- [x] Variance visualization — runaway / lock / decided-by-FJ shares plus 5th/95th percentiles, 2026-09-20

## Phase 1F: Personal Game Analyzer (PARTIALLY COMPLETE)
- [x] Manual entry form (correct/wrong counts, Coryat, DD/FJ wagers)
- [x] Input validation (reasonable ranges)
- [x] J-Archive single-URL fetch — GET /api/jarchive?game=<id>, one page per request, edge-cached a day, 2026-09-19
- [x] J-Archive HTML parser — shared app/src/lib/jarchive.ts, 422 on checkpoint mismatch, manual entry still works, 2026-09-19
- [x] Show game position on heat map (estimate → Explorer position)
- [x] DD wager analysis — "You bet $X. Equity-optimal was $Y." in Your Game after a J-Archive load, 2026-09-19
- [x] What-if replay with different wagers — per-DD paired rollout in GameDetail, 2026-09-20

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
- [x] Backtest any real game with different strategies — "Backtest this game" in Your Game after a J-Archive load, plus `npx tsx scripts/backtest.ts --game <id>`; 2026-09-20. Show #8276 is J-Archive game_id **6862**: equity wagering at Ben's two DJ DDs lifts the win chance from 46% to 73% (± 1), 2026-09-23
- [ ] Community features (sharing, leaderboards)
- [ ] Advanced 3-factor axis model toggle

## QA follow-ups (2026-09-23)
- [ ] All Games grid is 1,650px wide in a 1,232px container at 1280px; a quarter of each season needs horizontal scroll with no visible cue
- [ ] Famous-player labels overlap in the Explorer (Schneider/Rutter, Holzhauer/Watson)
- [ ] Explain why the same position reads 32% on All Games and ~21% in the Explorer (real opponents vs. the opponent slider)

## TODOS (from CEO review)
- [x] **P2**: DD impact difference map overlay — 2026-09-11
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
