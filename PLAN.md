<!-- /autoplan restore point: ~/.gstack/projects/Jeopardy/master-autoplan-restore-20260703-095649.md -->
# Plan: Make the Explorer Answer the Question — Accurate Wagering, Real Calibration, Honest Axes

**STATUS: APPROVED** — /autoplan final gate, 2026-07-03. Taste decisions: C1 runs
parallel and informs (does not gate) Track E; YourNumber moves above GamesControls
(P-4); default tab stays Your Game.

*v4 — drafted and revised 2026-07-03 through /autoplan (CEO + Design + Eng review,
premises accepted at gate D2, approved at gate D6).
Two tracks: Product (ship + axes + de-fuzz) and Engine (equity wagering + calibration).*

## Product direction (Ben, 2026-07-03)

> "I'm favoring usability and cool interaction design over complexity. The all-games
> yellow/blue graph is 8/10 — thematic, multiple levels of abstraction, genuinely
> interesting. The first-page graph (player skill plotted against another) is
> probably a 5/10 — it's fuzzy and doesn't answer what I want it to answer.
> Partially because computations aren't accurate and also because axes don't
> reflect exactly what I want."

Implications this plan adopts:
1. **The All Games contribution graph is the product's spine.** Don't destabilize it.
2. **The Explorer must earn its place** — accuracy (Engine track) and axis semantics
   (Product track) are both named failures; their relative weight is unknown, so a
   re-rating checkpoint sits between them.
3. **Usability and interaction design beat model complexity.** Engine work is justified
   only insofar as it changes what the user sees or can do.

## Accepted premises (gate passed 2026-07-03)

P1 All-Games graph is the spine. P2 Explorer fails on accuracy AND axis semantics,
proportions unknown → checkpoint C1. P3 Equity wagering is right IF board control gets
a minimal stochastic model. P4 Clue-level priors are real; wager-vs-score is
unsupportable from the data and is cut. P5 Ben's paper validates only a
paper-replication config; production config gets separate invariants. P6 No LLM,
static data, closed-form sim.

## Problem

The simulator's wagering layer is a placeholder. `ddWager()` (sim-engine.ts:187-207)
picks from four fixed heuristics, and Final Jeopardy (sim-engine.ts:365-410) uses a
one-rule strategy. The engine's DD placement prior (`DD_ROW_WEIGHTS`) is folklore
while a 529,939-row clue-level dataset sits unparsed. The Explorer heat map is fuzzy
(Monte Carlo noise) and its axes conflate buzz *attempt* rate with buzz *success*
rate (design doc Open Question #1, 2026-03-21 — never resolved). The app has never
been deployed and `app/` has never been committed to git.

Honest scope statement: this plan can show the **DD-wagering effect**. It cannot show
Tesauro's headline **DD-seeking effect** (square-selection strategy is out of scope);
board control gets a minimal stochastic model only so V(S) isn't biased.

## Work Items

### Track P — Product (ships first, cheap, directly targets the 5/10)

**P-0 Baseline commit + deploy.** FIRST add `.gitignore` rules for `data/`,
`*.zip`, and `app/public/games.json`-scale artifacts as appropriate (eng review:
the 56MB dataset zip at repo root and the 77MB extracted TSV would otherwise enter
git history permanently — cheap to prevent, expensive to rewrite out). THEN commit
the current `app/` + `scripts/` source state (currently untracked — no rollback
point exists), with a documented "how to obtain the dataset" note replacing the
data itself. Deploy to Vercel (TASKS.md Phase 0 checkbox). Every later item lands
as a diff against a shipped baseline.

**P-1 Axis semantics prototype (3 candidates, then Ben picks).** Build all three axis
framings behind the existing `dimensions.ts` registry (est. ~1 day CC total, cheap
because the registry already generalizes):
- **A. Interpretable units**: X = precision (% correct when you buzz), Y = buzz-race
  win % vs the field. Every famous player maps from data; fixes the attempt-vs-success
  conflation directly.
- **B. Actionable units**: knowledge × buzzer as today, but recalibrated so the
  marginal-returns panel speaks in "+10 study-hours ≈ +2pp win rate" terms.
  (Eng note: candidate A's Y-axis, buzz-race win % vs the field, has no closed-form
  inverse to `buzzerSpeed` — it needs a small one-time calibration curve (forward
  Monte Carlo sweep, then interpolate the inverse). Budget A at ~½ day extra; B and
  C are direct transforms.)
- **C. Coryat-anchored**: X = expected Coryat, Y = buzz attempt rate. Anchors to a
  number Jeopardy people already know; directly checkable against real games.
**Comparison mechanism (specified):** three labeled preset pills above the heat map
("A · Interpretable / B · Actionable / C · Coryat"), each a shareable URL-hash state
(App.tsx hash machinery already supports this). **Prerequisite formatting work:**
DimensionConfig gains `format(v): string` and `unit` fields — candidate C's Coryat
axis is dollars (~$0–30K) and candidate A's Y is a percentage; StatsPanel/ControlsPanel
currently hardcode `pct()` everywhere, and a "Coryat: 43%" mislabel during the bake-off
would corrupt the C1 signal for presentation reasons. Ben compares all three live
(deployed) and picks one. Famous-player positions, StatsPanel copy, GameAnalyzer
estimate→position mapping then update for the winner.

**P-2 De-fuzzing.** Raise refined-pass grid sim counts where the color field is
visibly noisy; render contour confidence as **dash pattern** (solid = high sample
count, dashed = low), NOT opacity — faint lines on a win-rate color field read as
"low value here," the wrong message; add one legend line ("dashed contour = fewer
samples"); document before/after variance. Bounded, measurable, uses the existing
adaptive-resolution pipeline.

**P-3 Journey bridge (route the payoff).** After GameAnalyzer submit → land on
Explorer with the YOU marker pulsing once (single CSS animation, not a loop) and a
one-line link: "Next: see how you'd do in 8,600 real games →" (navigates to All
Games). Fixes the current dead end where "Your marker has been placed" renders in
the tab the user just left and nothing routes onward to the spine. Pure addition;
no All Games layout change (a YourNumber-above-controls reorder on that tab is a
taste decision at the final gate — it touches the 8/10 view).

**C1 — CHECKPOINT: Ben re-rates the Explorer** after P-1 + P-2 land on the deployed
app. Records the residual complaint: semantics (fixed?), fuzziness (fixed?), or
accuracy (Engine track's job). **Resolved at final gate (D3): C1 informs, does not
gate — Track E runs in parallel from day one.**

**P-4 All Games hierarchy fix (approved at final gate, D4).** Move YourNumber (the
"You'd win N% of all games" headline + histogram) ABOVE the GamesControls slider
stack on the All Games tab. Pure reorder — payoff first, knobs second; the graph
itself is untouched. Default tab stays Your Game (D5 — narrative entry preserved;
P-3's bridge covers explorers).

### Track E — Engine (equity wagering + real calibration)

**E-0 Engine plumbing (prerequisite, was unbudgeted in v1).** Honest scope (eng
review): this is a **refactor of the round-simulation core**, not a thin wrapper —
`simulateRound` and `simulateFinalJeopardy` are unexported and hard-coded to full
30-clue boards with fresh DD placement (sim-engine.ts:244, :365).
- Refactor `simulateRound` to accept a partial board (remaining clue values,
  remaining DD count) and export it + `simulateFinalJeopardy`; then
  `simulateFromState(state)` composes them. Boundary: 0 clues remaining → straight
  to FJ. Existing full-game behavior must be regression-locked (seeded snapshot
  test before refactor, identical results after).
- **Partial-board DD placement (specified)**: renormalize `DD_ROW_WEIGHTS` over
  only the rows still in play — a uniform draw over leftover slots would silently
  wash out the empirical prior E-1 exists to provide.
- **Per-player DD strategy split**: SimConfig's single global `ddStrategy`
  currently applies to whichever player controls the DD (sim-engine.ts:282) — you
  AND opponents. Split into your strategy vs opponents' strategy (the E-2 cache key
  already assumed this split; it's now a named work item). Equity dispatch happens
  BEFORE `ddWager()` — the `'equity'` value never enters `ddWager`'s switch, and a
  TypeScript exhaustiveness check (`never` guard) makes a fall-through to
  `default: minWager` a compile error instead of a silent min-bet game.
- Seeded RNG: thread an optional `rng: () => number` through **all** `Math.random()`
  call sites in sim-engine.ts (currently 9 — lines 83, 98, 99, 171, 182, 228, 284,
  332, 470; grep before starting, the count moves) (default unchanged). Determinism
  test: same seed → same result.
- Minimal stochastic board control: replace deterministic leader-takes-DD
  (sim-engine.ts:279) with score-weighted random control (configurable; default
  preserves current behavior until validated). Without this, V(S) encodes "trailing
  players never get DDs" and equity numbers inherit the bias.

**E-1 Clue-level dataset parser** (`scripts/build-clue-stats.ts`, mirrors
build-games.ts; shared era logic extracted to `scripts/lib/era.ts`).
- **Prerequisite (was unstated)**: extract `combined_season1-41.tsv` (77MB) from
  the repo-root zip into `data/` — it is not currently on disk; only the scoring
  TSVs are. The extracted file stays gitignored (see P-0).
- Schema (verified): round, clue_value, daily_double_value, category, comments,
  answer, question, air_date, notes. DD rows keep face value; wager in
  daily_double_value.
- Derive: P(DD | row, round) with era normalization (values doubled 2001-11-26);
  DD wager distribution **as fraction of round max only** (wager-vs-score cut —
  no score-at-DD-time exists in the data); board-completeness stats (exclude
  incomplete boards, same philosophy as build-games.ts).
- Edge cases handled explicitly: malformed rows (skip + count), missing air_date
  (excluded from era-sensitive stats), zero-value rows. Round column verified to
  take only {1, 2, 3} with round 3 = FJ (clue_value 0, one per game — excluded
  from DD stats). Tiebreaker clues are NOT distinguishable in this schema; verify
  during implementation whether any signal exists (duplicate category per
  air_date) and document the answer rather than claiming handled.
- Output `app/public/clue-stats.json` (aggregated priors only) with `generatedAt` +
  source row counts embedded for debuggability.
- Acceptance: DD count ≈ 3 × ~8.6K games ≈ 26K; fitted prior sanity vs folklore
  (bottom-3-rows favored; row-1 DDs ≤ ~2% post-2001) — divergence is a surfaced
  finding, not a silent ship.

**E-2 Game-state value function V(S)** (`app/src/sim/value-function.ts`).
- Precomputed rollout table over a 5D coarse state: (your-skill bucket [4×4 over
  knowledge×buzzer], your-share, leader-ratio, **third-player ratio** [lock/crush/
  three-way cases differ sharply — 2D score projection provably loses them],
  clues-remaining bucket). Populated by `simulateFromState` rollouts, smoothed with
  `gaussianBlur2D` per 2D slice, multilinear interpolation at query time (O(1) —
  the hot path).
- Your-skill bucketing is the fix for the v1 critical defect: the heat map sweeps
  YOUR skill, so a table baked for one fixed "you" is wrong everywhere else.
- Budget (must hold, measured): table build ≤ ~5s per opponent model in the worker
  with progress messages, ≤ ~2MB Float32Array; never rebuilt on drag.
- **Where the table lives (specified — two workers exist)**: HeatMap owns its own
  worker instance and App.tsx holds a separate persistent `gameWorkerRef`
  (App.tsx:180). The V-table is built ONCE in the persistent worker, posted back as
  a transferable Float32Array, cached in App state, and handed to any worker that
  needs it on init/config-change — never built twice for a tab switch.
- **Cache key (full spec)**: (opponentModel, rhoB, rhoP, opponents' DD strategy
  incl. ddWagerFraction, fjStrategy, includeFJ) — any of these changing invalidates the table (rebuild with
  progress UI); your skill and scores are table dimensions, never cache keys. Equity
  mode pins the invalidating knobs while active and says so in the UI, so casual
  slider play doesn't trigger surprise 5s rebuilds.
- Invariants tested: V monotone ↑ in your score; V→1 for pre-FJ lock with FJ off;
  V clamped [0,1]; out-of-range queries clamp to table bounds.

**E-3 Equity DD wagering.** New strategy **`'equity'`** for YOUR player only
(opponents keep their configured heuristic — per-player split from E-0; UI label
"Optimal (equity)"). At a DD: argmax over bet grid (**$5 real-rules floor** for the
equity search — the engine's existing `minWager = maxClueValue` simplification at
sim-engine.ts:189 stays for heuristic presets but is documented as a modeling
choice, not carried silently into the "validated" layer; grid $5 → all-in, ~$500
steps ≤ 40 evaluations) of
`Equity(bet) = p × V(S₊) + (1−p) × V(S₋)`, p = difficulty-adjusted precision
(same machinery as regular DD resolution). Existing presets untouched; `'equity'`
is additive; default config unchanged (rollback = revert commit).

**E-4 Dual-config validation harness** (`app/src/sim/equity-validation.test.ts`).
- **Paper-replication config** (symmetric players, ρ=0, no difficulty scaling —
  matches the IYSE 6644 model): scores [19400, 6400, 17200], **you = the
  second-place $17,200 player** (CORRECTED during implementation from
  JeopardySimulator.ipynb `player = 2` — the plan originally said leader; the
  published numbers only reproduce from second place), exact 13-clue board from
  the notebook, win = strict lead at DJ end (no FJ), 55% confidence → equity at
  $3,200/$5,000/$12,400 reproduces 36%/45%/55% within ±5pp, seeded.
  **IMPLEMENTED & PASSING: 36.4% / 43.2% / 55.2% (worst dev 1.8pp).**
  Monotonicity: equity non-decreasing across that wager range.
- **Production-config invariants** (Tesauro opponents, correlations, difficulty
  scaling — where paper numbers do NOT apply): monotonicity in confidence;
  equity-vs-wager curve is near-flat at the optimum (Tesauro's risk-mitigation
  property: −$2,600 from optimum costs ≲0.5pp); lock-preservation (never wager
  into a loss-from-win state late).
- Failure diagnostic prints the full equity curve, not just the assertion.

**E-5 Final Jeopardy: closed-form baseline + equity comparison.** Encode the known
closed-form FJ strategy (lock / crush / two-thirds cases per standard wagering
theory — The Final Wager conventions) as `fjStrategy: 'standard'` replacing the
current one-rule block for correctness; add `'equity'` FJ (grid search over wagers
using V and correlated FJ accuracy ρ≈0.3) and **report the measured gap** between
closed-form and equity as a test output. Opponents keep using 'standard' (models
real contestants). Lock-game handling preserved and tested.

**E-6 Empirical priors into the engine.** `DD_ROW_WEIGHTS` becomes the fallback;
SimConfig accepts `ddRowWeights` loaded from clue-stats.json at startup. Missing/
malformed file → console.warn + fallback (visible, never silent). Difficulty-curve
comparison vs the tsx-derived `difficultyMultiplier`: recalibrate only if data
clearly contradicts; document either way in BRAINSTORM.md.

**E-7 UI integration + 4 of the 5 approved delight items** (the 5th, contour
confidence, ships in P-2; the All Games recolor below came from a review finding,
not the cherry-pick ceremony; all in blast radius, ≤1 day CC each). Per-surface
spec — design review found the v2 bullets named hosts that don't exist:

- **DD Strategy selector (must be BUILT, not "gained")**: App.tsx currently
  hardcodes `ddStrategy: 'aggressive'` (line 141) and ControlsPanel has no strategy
  control at all. Build: a "DD Strategy" section in ControlsPanel — segmented
  control [Conservative | Aggressive | True DD | Optimal (equity)] — state lifted
  to App.tsx, shared by both tabs (single source; GamesControls reflects, doesn't
  duplicate). Selecting Optimal triggers the V-table build with the existing worker
  progress UI; on build failure, **inline status text** next to the control
  ("Optimal unavailable — using Aggressive") — NOT a toast; no toast system exists
  and this app's flat-panel aesthetic doesn't want one. Never silent wrong numbers.
- **Equity-mode knob pinning (the hardest interaction, now specified)**: while
  Optimal is active, cache-key knobs (opponent model, ρ sliders, FJ toggle,
  opponents' DD settings) render at 40% opacity with a lock glyph; clicking one
  shows inline text "Locked while Optimal is active — changing this rebuilds the
  strategy table (~5s)" with an "Unlock & rebuild" action. The FJ checkbox lives in
  a different panel section but is in the same cache key — same treatment.
- **Equity-curve mini-chart** (equity vs wager, the paper's figure interactive):
  host = **GameAnalyzer only** in the "DD & FJ details" advanced section, rendered
  when a DD wager is entered; ~320×160 SVG below the wager field; user's wager
  marked on the curve vs the optimal point. GameDetail does NOT get the chart in
  this plan — it has no per-DD view and no DD score-state in its data model; adding
  DD event rows to GameDetail is a data-model change, deferred to TODOS.
- **DD wager copy, split by host**: GameAnalyzer (first person, real):
  "You bet $5,000. Optimal: $12,400 (+10pp equity)." GameDetail (third person,
  historical, only if/when DD events exist there): "Actual wager: $X.
  Equity-optimal: $Y." The v2 copy wrongly used first person for historical games.
- **Confidence input** (GameAnalyzer): slider 50–95%, default 55% (the paper's
  worked example), placed adjacent to the DD wager field inside the advanced
  section; its output IS the equity-curve mini-chart re-rendering live.
- **DD-placement heat strip**: host = Explorer side panel, below MarginalReturns;
  5 rows × 2 round columns, colored by P(DD|row,round) from clue-stats.json;
  heading "Where DDs actually live (8.6K games)"; hidden entirely when
  clue-stats.json is unavailable (fallback state — no empty skeleton).
- **All Games recolor**: raise refined pass **10 → 25 sims/game** (the v2 text said
  5→25; the code's refined pass is 10 — App.tsx:211 — and fast pass is 2; corrected
  during design review). Per-square SE improves ~±16pp → ~±10pp; cost is 2.5× the
  current refined pass (measured); aggregate patterns and Your Number benefit most;
  per-square noise remains and is stated honestly.

**UI test infrastructure (was absent — eng review)**: the repo has zero UI test
capability (only sim-engine.test.ts; no @testing-library/react, no jsdom). E-7 adds
both: `@testing-library/react` + jsdom environment, with interaction tests for the
plan's hardest surfaces — knob lock/unlock (input actually disabled, explanation
text appears, unlock-and-rebuild fires a rebuild), build-state transitions (heat
map dims during build, never undimmed-stale), and strategy-selector failure
fallback. **Existing input validation gap fixed in passing**: GameAnalyzer's
free-text `ddWager`/`fjWager` fields parse to NaN unguarded (GameAnalyzer.tsx:55)
and the equity mini-chart reads them — same clamp+hint treatment as the new
confidence slider.

**Accessibility for new controls**: strategy segmented control = `role="radiogroup"`
with arrow-key navigation, ≥44px touch targets, labels visible (not placeholder-only);
locked knobs use `aria-disabled` + the inline explanation text (not `display:none`);
equity mini-chart gets an `aria-label` carrying the optimal wager + user's wager as
text. (Canvas ContributionGraph screen-reader gap is pre-existing — in TODOS.md.)

**UI states — equity mode (all surfaces that consume V):**

| Surface | no-table | building | ready | stale (knob unlocked) | failed |
|---|---|---|---|---|---|
| Heat map | previous strategy's colors + normal | previous colors **dimmed 60% + progress bar** (never confidently-wrong undimmed stale colors) | equity colors | dimmed + auto-rebuild | previous strategy + inline status |
| Strategy selector | Optimal selectable | Optimal marked "building… ▓▓░ 60%" + cancel affordance | Optimal active | unchanged | reverts to previous, inline status |
| Equity mini-chart | prompt: "Select Optimal (equity) or enter a DD wager to see the curve" | skeleton line | curve + markers | curve + "rebuilding…" note | hidden + one-line explanation |
| DD tooltip (GameDetail, future) | hidden | hidden | shown | shown | hidden |
| DD heat strip | (independent of V — driven by clue-stats.json: shown when loaded, hidden on fallback) | | | | |

## Sequencing

```
Track P: P-0 → P-1 ┬→ C1 (re-rate) ──────────────┐
                   └ P-2 ┘                        │ informs (or gates — final-gate
Track E: {E-0, E-1 — order-independent, both before E-2} → E-2 → E-3 → E-4 → E-5 → E-6 → E-7
         (E-1's empirical p_DD feeds E-2 rollouts; E-4 gates E-5:
          validate DD equity before touching FJ)
```
Tracks run in parallel; the axis decision does NOT gate engine work (the v1 claim
that it did was wrong — equity math is axis-independent).

## NOT in scope

- DD *seeking* / square-selection strategy (Tesauro's p_DD + 0.1×p_RC policy) — own
  project; this plan only de-biases board control enough to keep V(S) honest.
- Multi-game/tournament wagering; endgame ADP buzz thresholds.
- Category-level knowledge modeling from clue text.
- J-Archive live fetch (TASKS.md Phase 1F, separate).
- Optimal-vs-actual delta mode on the All Games graph (deferred: spine-risk), share
  card for Your Number, full strategy-oracle ranking (deferred to TODOS).
- Mobile 3-column Explorer layout rework (design doc Open Question #5 — separate).
- Any LLM integration (locked decision).

## What already exists (leverage map)

| Sub-problem | Existing code | Reused? |
|---|---|---|
| Game simulation for rollouts | `simulateRound`, `simulateFinalJeopardy` | Yes — E-2 rolls out through them via `simulateFromState` |
| Grid smoothing | `gaussianBlur2D` (math-utils.ts) | Yes — per-slice table smoothing |
| TSV parsing + filtering | `scripts/build-games.ts` | Yes — E-1 mirrors it; era logic extracted shared |
| Axis abstraction | `dimensions.ts` DimensionConfig registry | Yes — P-1 adds candidates, no new architecture |
| Worker caching | persistent worker + loadGames pattern | Yes — V-table cached the same way |
| Opponent calibration | `calibrate.ts` Coryat heuristic | Yes — P-1 candidate C builds on it |
| Progress UI + crash fallback | sim-worker progress + main-thread fallback | Yes — V-table build reuses both |

## Dream state delta

This plan leaves us: truthful wagering layer (equity + closed-form FJ), empirically
calibrated DD priors, honest axes, shipped app. 12-month ideal adds: DD seeking +
board control strategy, what-if replay and #8276 backtest (both unlocked by V(S) —
platform infrastructure), full strategy oracle, mobile layout. V(S) is the bridge.

## Architecture (target state)

```
  scripts/build-clue-stats.ts ──┐          jeopardy_dataset zip (gitignored)
  scripts/build-games.ts ───────┼── scripts/lib/era.ts (shared)
        │                       │
        ▼                       ▼
  app/public/games.json   app/public/clue-stats.json (priors + generatedAt)
        │                       │
        ▼                       ▼ (startup fetch, warn+fallback on 404)
  ┌─────────────────────────── App.tsx ────────────────────────────┐
  │  state: position, config (per-player ddStrategy), V-table cache │
  │  persistent gameWorkerRef ◄── builds V-table ONCE, transfers    │
  └───┬──────────────────┬──────────────────────┬──────────────────┘
      ▼                  ▼                      ▼
  YourGame tab       Explorer tab           All Games tab
  GameAnalyzer       HeatMap (own worker,   ContributionGraph
   ├ confidence       receives V-table)      (25 sims/game refined)
   ├ equity chart     ├ axis pills A/B/C    YourNumber
   └ P-3 bridge ────► ├ dash contours       GamesControls
                      └ DD heat strip
                            ▲
  app/src/sim/: sim-engine.ts (simulateFromState, per-player strategy,
  seeded rng, stochastic board control) ── value-function.ts (5D V(S))
  ── equity dispatch (never inside ddWager's switch)
```

## Test coverage map (new codepaths → tests)

```
CODE PATHS                                          USER FLOWS
[+] sim-engine.ts (E-0 refactor)                    [+] Equity mode
  ├── [TEST] seeded determinism (same seed→same)      ├── [TEST] select Optimal → build → dim → ready
  ├── [TEST] regression-lock: full-game snapshot      ├── [TEST] build failure → inline status + revert
  │          identical pre/post refactor (CRITICAL)   ├── [TEST] knob lock/unlock + rebuild   [→UI]
  ├── [TEST] partial board: 0 clues → FJ              └── [TEST] cancel mid-build             [→UI]
  ├── [TEST] DD renormalization over open rows      [+] GameAnalyzer
  └── [TEST] per-player strategy dispatch             ├── [TEST] NaN/negative wager clamp+hint
      + 'equity' never enters ddWager (compile)       └── [TEST] confidence slider drives chart
[+] value-function.ts (E-2)                         [+] Axis pills (P-1)
  ├── [TEST] V monotone in your score                 └── [TEST] format()/unit per candidate
  ├── [TEST] pre-FJ lock → V=1 (FJ off)                          (no "Coryat: 43%")
  ├── [TEST] clamp out-of-range queries             [+] Journey bridge (P-3)
  └── [TEST] build budget ≤5s measured                └── [TEST] submit → Explorer + pulse + link
[+] equity (E-3/E-4)                                LLM integration: none — no eval suites
  ├── [TEST] paper-replication ±5pp × 3 points
  ├── [TEST] monotonicity $3.2K→$12.4K
  ├── [TEST] production invariants (near-flat
  │          optimum, lock preservation)
  └── [TEST] FJ lock/crush/two-thirds cases (E-5)
[+] build-clue-stats.ts (E-1)
  ├── [TEST] golden rows (era normalization)
  ├── [TEST] zero-DD abort; malformed-row counts
  └── [TEST] prior sanity (row-1 ≤2% post-2001)
COVERAGE TARGET: every branch above has a named test before implementation starts.
2am-Friday test: the seeded full-game regression snapshot (first bullet).
```

## Error & Rescue Registry

| Codepath | What can go wrong | Handling | User sees |
|---|---|---|---|
| build-clue-stats.ts parse | Malformed row | Skip + count, report at end | Build log: "N rows skipped" |
| build-clue-stats.ts parse | Zero DD rows parsed | Abort with error (never emit empty priors) | Build fails loudly |
| build-clue-stats.ts era | Missing air_date | Exclude from era-sensitive stats, count | Build log |
| App startup priors load | clue-stats.json 404/malformed | console.warn + fallback to DD_ROW_WEIGHTS | Nothing broken; devtools warn |
| V-table build | Worker crash / OOM | Existing crash handler → revert to previous strategy preset + toast | "Optimal unavailable — using Aggressive" |
| V-table build | User changes settings mid-build | Cancel in-flight (existing pattern), restart | Progress restarts |
| Equity argmax | score < minWager | Clamp bet grid to [minWager, max(score, minWager)] | Correct min wager |
| V query | Out-of-range state (huge/negative scores) | Clamp to table bounds | Sane equity |
| Equity validation | Tolerance failure | Print full equity curve diagnostic | CI failure with curve |
| GameAnalyzer confidence | Input <0 / >1 / NaN | Clamp + inline hint | Hint text |
| FJ closed-form | Ties at all positions | Explicit tie rules (co-champion = 0.5 win) | Consistent stats |

## Failure Modes Registry

| Codepath | Failure mode | Rescued? | Test? | User sees | Logged |
|---|---|---|---|---|---|
| Priors load | Missing file | Y (fallback) | Y | Nothing (defaults) | console.warn |
| V-table build | Crash | Y (preset fallback) | Y (simulated crash) | Toast | console.error |
| V-table build | Silent bias (board control) | Y (E-0 stochastic model) | Y (invariants) | Truthful map | build report |
| Equity vs paper | Model mismatch | Y (dual-config) | Y (E-4) | — | test output |
| Parser | Era misclassification | Y (rule table + bounds check) | Y (golden rows) | — | build report |
| All Games recolor | Noise swamps signal | Partially (25 sims/game) | Y (SE measured) | Honest per-square noise | documented |

No row is Silent+Unrescued+Untested → no CRITICAL GAP remaining (v1 had two:
V-table skill bias and silent priors fallback; both fixed above).

## Acceptance

1. `npm test` green: 30 existing + E-0 determinism + E-2 invariants + E-4 dual-config
   + E-1 parser tests.
2. Paper-replication config reproduces Ben's table within ±5pp at all three points;
   production config passes its invariant suite.
3. Heat map with "Optimal (equity)" visibly differs from "Aggressive" — labeled as
   the **DD-wagering effect** (not DD-seeking), no interaction-latency regression,
   V-table build ≤ ~5s with progress.
4. clue-stats.json ships with row counts (≈26K DDs expected) and generatedAt stamp.
5. **C1 checkpoint recorded**: Ben re-rates the Explorer after P-1+P-2 on the deployed
   app; target ≥ 7/10, residual complaint captured.
6. All Games graph unchanged in feel; refined pass 25 sims/game measured for perf;
   noise reduction stated with real numbers.
7. App deployed to Vercel with baseline committed before any engine diff (P-0).

## Risks

- **V(S) fidelity**: 5D coarse table may still miss structure. Gate: E-4 invariants +
  paper replication; if ±5pp fails, raise resolution/rollouts *only under the
  paper-replication config* (raising them can't fix model mismatch — that's what the
  dual-config split is for).
- **Perf**: table build budget ≤5s/model, measured; equity lookups O(1); if budget
  fails, shrink state dims before shrinking rollouts (smoothness beats variance here).
- **Era normalization**: validated against known constraints (row-1 DD ≤ ~2% post-2001).
- **Axis decision stalls**: C1 needs Ben's live comparison; deployed prototypes (P-1)
  make it a 10-minute decision, not a design debate.
- **Test brittleness**: every Monte Carlo assertion is seeded + tolerance-based.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | Intake | Plan file = fresh draft from FABLE_LIFT + TASKS | User choice | — | Ben picked option C at D1 | Review FABLE_LIFT directly; TASKS.md |
| 2 | Intake | Fold Ben's product direction into plan as first-class section | Mechanical | P1 | Direction arrived mid-draft; axes gap wasn't covered | Ignore until review |
| 3 | Phase 0 | UI scope YES / DX scope NO | Mechanical | — | Explorer/axes/panels = UI; consumer app, no dev-facing surface | — |
| 4 | Phase 0.5 | Codex unavailable → [subagent-only] voices | Mechanical | — | binary not found | — |
| 5 | Phase 1 | cross_project_learnings = true | Mechanical | P6 | Local-only, solo dev, recommended default | Keep project-scoped |
| 6 | Phase 1 0C-bis | Approach B (two-track revised) over A (as-drafted) / C (minimal) | Mechanical (not close) | P1, P5 | A contained 2 critical defects (V skill-bias, wrong validation target); B completeness 10/10 | A (6/10), C (3/10) |
| 7 | Phase 1 | Adopt voice finding 1: dual-config validation (paper-replication + production invariants) | Mechanical | P1 | Paper's model ≠ production model; single-config gate chases wrong target | Single ±5pp gate |
| 8 | Phase 1 | Adopt voice finding 2: skill-bucketed V-table dims | Mechanical | P1, P5 | Heat map sweeps YOUR skill; fixed-you table wrong everywhere else | Per-cell builds (perf-fatal); skill-agnostic V |
| 9 | Phase 1 | Adopt voice finding 3: stochastic board control (E-0) + honest claim language | Mechanical | P1 | Deterministic leader-control biases V; acceptance 3 overclaimed "Tesauro effect" | Ship biased V with caveat |
| 10 | Phase 1 | Adopt voice finding 4+: All Games refined pass 5→25 sims/game, honest noise statement | Mechanical | P1, P5 | 5 sims/game = ±20pp SE; claimed benefit was invisible | Keep claim as-was |
| 11 | Phase 1 | Adopt voice finding 5: E-0 plumbing item (simulateFromState + seeded RNG) | Mechanical | P1 | Unbudgeted prerequisite for E-2/E-4 | Pretend it's a utility |
| 12 | Phase 1 | Adopt voice finding 6: W0 does NOT gate engine track; prototype all 3 axis candidates | Mechanical | P3, P6 | Dependency was fake; one-shot axis pick was untestable | Sequential W0-first |
| 13 | Phase 1 | Adopt voice finding 7: closed-form FJ baseline + equity gap report; cut wager-vs-score | Mechanical | P4, P5 | FJ theory is solved (lock/crush/two-thirds); data lacks score-at-DD | Pure MC search; keep unsupportable deliverable |
| 14 | Phase 1 | Adopt voice finding 8: third-player ratio as 4th state dim | Mechanical | P1 | Lock/crush/three-way differ at identical 2D projections | 3D projection + hope |
| 15 | Phase 1 | Adopt voice finding 9: P-0 deploy-first + baseline commit | Mechanical | P6 | app/ untracked = no rollback point; ship-first aligns with Ben's direction | Deploy later |
| 16 | Phase 1 | C1 re-rate checkpoint added; whether it HARD-GATES Track E → **TASTE DECISION (final gate)** | Taste | P2 vs P6 | Both voices favor gating; Ben's paper + explicit interest favor unconditional | — |
| 17 | Phase 1 0D | Approve 5 cherry-picks (equity curve chart, DD tooltip, confidence input, contour confidence, DD heat strip) | Mechanical | P2 | All in blast radius, <1d CC each, feed Ben's stated taste | — |
| 18 | Phase 1 0D | Defer 3 (All-Games delta mode, share card, strategy oracle) | Mechanical | P2, P3 | Spine-risk / outside blast radius | Build now |
| 19 | Phase 1 S5 | Enum named `'equity'`, UI label "Optimal (equity)" | Mechanical | P5 | Name what it computes; 'optimal' overclaims in code | `'optimal'` enum |
| 20 | Phase 1 S5 | Shared `scripts/lib/era.ts` between both build scripts | Mechanical | P4 | Era logic would otherwise duplicate | Copy-paste |
| 21 | Phase 2 | Skip interactive mockup-board loop despite DESIGN_READY | Mechanical | P3 | /autoplan = 2 user gates; P-1's live 3-candidate prototypes on the deployed app are the superior comparison mechanism for an existing D3 UI | Static AI mockups + board session |
| 22 | Phase 2 | Per-surface E-7 spec; equity chart = GameAnalyzer only; GameDetail DD events deferred | Mechanical | P5 | GameDetail has no per-DD view or DD score-state — hosting the chart there is a data-model change, not a tooltip | Vague multi-host bullet |
| 23 | Phase 2 | BUILD strategy selector (doesn't exist — App.tsx:141 hardcodes); inline status instead of toast | Mechanical | P5 | No toast primitive exists; flat-panel aesthetic; inline is fewer moving parts | Invent a toast system |
| 24 | Phase 2 | DimensionConfig gains format()/unit; A/B/C preset pills with hash state | Mechanical | P1 | "Coryat: 43%" mislabel would corrupt the C1 bake-off signal | Unspecified comparison UX |
| 25 | Phase 2 | Knob-pinning interaction fully specified (40% opacity + lock glyph + unlock-and-rebuild) | Mechanical | P5 | Hardest interaction in the plan was one clause; three readings = three different apps | Leave to implementer |
| 26 | Phase 2 | UI states table for all V-consuming surfaces; heat map dims during build | Mechanical | P1 | Stale-undimmed = 5s of confidently wrong numbers — the exact sin the plan fixes | Unspecified normal states |
| 27 | Phase 2 | P-3 journey bridge added (marker pulse + All Games link); YourNumber reorder + default-tab choice → **TASTE (final gate)** | Split | P5 / — | Bridge is pure addition; the other two touch the 8/10 spine's tab and the app's entry narrative — Ben's call | — |
| 28 | Phase 2 | Contour confidence = dash pattern, not opacity | Mechanical | P5 | Faint lines on a win-rate color field read as "low value," wrong channel | Opacity ∝ samples |
| 29 | Phase 2 | Corrected All Games baseline: refined pass is 10 sims/game (App.tsx:211), not 5; SE math restated | Mechanical | P1 | Review claim was computed from a wrong baseline | Ship wrong numbers |
| 30 | Phase 2 | Confidence input: slider 50–95%, default 55%, adjacent to DD wager, drives mini-chart | Mechanical | P5 | Most personal item in the plan was least specified | Clamp-rule-only spec |
| 31 | Phase 2 | A11y spec for new controls (radiogroup, 44px, aria-disabled locks, chart aria-label) | Mechanical | P1 | New interactive surfaces without a11y spec won't get it later | "A11y later" |
| 32 | Phase 3 | E-0 rescoped as core refactor (simulateRound unexported + full-board-only); regression-lock snapshot test required | Mechanical | P5 | Leverage map overclaimed "reuse via wrapper" (conf 9, file-verified) | Wrapper fiction |
| 33 | Phase 3 | Per-player DD strategy split named as work; equity dispatch before ddWager + never-guard | Mechanical | P1 | Global ddStrategy applies to any controller (sim-engine.ts:282); enum fall-through = silent min-bets (conf 8) | Silent default |
| 34 | Phase 3 | P-0 gains .gitignore-first rule (data/, *.zip); E-1 gains unzip prerequisite | Mechanical | P6 | 56MB zip + 77MB TSV would enter history permanently; TSV not yet extracted (conf 9, measured) | git add . and pray |
| 35 | Phase 3 | Partial-board DD placement = renormalized DD_ROW_WEIGHTS over open rows | Mechanical | P1 | Uniform draw would wash out the E-1 empirical prior (conf 6) | Unspecified |
| 36 | Phase 3 | E-7 adds UI test infra (@testing-library/react + jsdom) + interaction tests | Mechanical | P1 | Zero UI test capability exists; hardest interactions were untested AND unnamed as untested (conf 8) | Manual-QA-only, unstated |
| 37 | Phase 3 | V-table home: built once in persistent worker, transferred to consumers | Mechanical | P5 | Two independent workers exist (HeatMap's own + gameWorkerRef); double-build would break the 5s budget (conf 6) | Ambiguous "the worker" |
| 38 | Phase 3 | Axis candidate A needs inverse-calibration curve; +½ day budget | Mechanical | P1 | Buzz-race win % has no closed-form inverse to buzzerSpeed (conf 6) | 1-day estimate stands |
| 39 | Phase 3 | Equity bet grid floors at real $5 rule; heuristic presets keep documented simplification | Mechanical | P5 | minWager=maxClueValue would silently carry old inaccuracy into the validated layer (conf 5) | Inherit silently |
| 40 | Phase 3 | Existing ddWager/fjWager free-text inputs get clamp+hint (NaN unguarded, chart consumes them) | Mechanical | P1 | GameAnalyzer.tsx:55 parseInt→NaN with no guard (conf 6) | New-inputs-only validation |
| 41 | Phase 3 | E-1 tiebreaker claim replaced with honest schema statement (round∈{1,2,3}, no tiebreaker signal) | Mechanical | P5 | Claimed edge case is unidentifiable in the data (conf 5, measured) | Claim "handled" |
| 42 | Final gate | C1 informs, does not gate Track E (D3, Ben) | Taste → resolved | — | Ben's paper + stated interest; parallel tracks | Hard gate |
| 43 | Final gate | YourNumber above GamesControls on All Games (P-4) (D4, Ben) | Taste → resolved | — | Headline-before-knobs hierarchy; graph untouched | Leave tab alone |
| 44 | Final gate | Default tab stays Your Game (D5, Ben) | Taste → resolved | — | Narrative ladder preserved; P-3 bridge covers explorers | Lead with All Games / Explorer |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (PLAN via /autoplan) | 10 proposals, 6 accepted, 3 deferred; spec-review 9/10 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — (CLI not installed) | voices ran subagent-only, all 3 phases |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN via /autoplan) | 10 issues (3 P1), 0 critical gaps remaining |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN via /autoplan) | score 4/10 → 8/10, 10 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | SKIPPED | no developer-facing scope |

- **VERDICT:** CEO + ENG + DESIGN CLEARED — ready to implement. Plan APPROVED at
  /autoplan final gate 2026-07-03 (D6); 44 decisions logged, 3 taste calls resolved
  by Ben, 0 user challenges.

NO UNRESOLVED DECISIONS
