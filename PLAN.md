<!-- /autoplan restore point: ~/.gstack/projects/Jeopardy/master-autoplan-restore-20260703-095649.md -->
# Plan: Make the Explorer Answer the Question — Accurate Wagering, Real Calibration, Honest Axes

*v2 — revised 2026-07-03 during /autoplan Phase 1 (CEO review, premises accepted by Ben).
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

**P-0 Baseline commit + deploy.** Commit the entire current `app/` + `scripts/` +
`data/` state to git (it is currently untracked — no rollback point exists). Deploy
to Vercel (TASKS.md Phase 0 checkbox). Every later item lands as a diff against a
shipped baseline.

**P-1 Axis semantics prototype (3 candidates, then Ben picks).** Build all three axis
framings behind the existing `dimensions.ts` registry (est. ~1 day CC total, cheap
because the registry already generalizes):
- **A. Interpretable units**: X = precision (% correct when you buzz), Y = buzz-race
  win % vs the field. Every famous player maps from data; fixes the attempt-vs-success
  conflation directly.
- **B. Actionable units**: knowledge × buzzer as today, but recalibrated so the
  marginal-returns panel speaks in "+10 study-hours ≈ +2pp win rate" terms.
- **C. Coryat-anchored**: X = expected Coryat, Y = buzz attempt rate. Anchors to a
  number Jeopardy people already know; directly checkable against real games.
Ben compares all three live (deployed) and picks one. Famous-player positions, StatsPanel
copy, GameAnalyzer estimate→position mapping then update for the winner.

**P-2 De-fuzzing.** Raise refined-pass grid sim counts where the color field is
visibly noisy; render contour confidence (line opacity ∝ local sample size); document
before/after variance. Bounded, measurable, uses the existing adaptive-resolution
pipeline.

**C1 — CHECKPOINT: Ben re-rates the Explorer** after P-1 + P-2 land on the deployed
app. Records the residual complaint: semantics (fixed?), fuzziness (fixed?), or
accuracy (Engine track's job). *Whether C1 hard-gates Track E or just informs it is a
taste decision surfaced at the /autoplan final gate.*

### Track E — Engine (equity wagering + real calibration)

**E-0 Engine plumbing (prerequisite, was unbudgeted in v1).**
- `simulateFromState(state)`: enter a game at an arbitrary board state (scores,
  remaining clue values, remaining DD count, round). Needed by V-table rollouts and
  the validation harness. Boundary: 0 clues remaining → straight to FJ.
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
- Schema (verified): round, clue_value, daily_double_value, category, comments,
  answer, question, air_date, notes. DD rows keep face value; wager in
  daily_double_value.
- Derive: P(DD | row, round) with era normalization (values doubled 2001-11-26);
  DD wager distribution **as fraction of round max only** (wager-vs-score cut —
  no score-at-DD-time exists in the data); board-completeness stats (exclude
  incomplete boards, same philosophy as build-games.ts).
- Edge cases handled explicitly: malformed rows (skip + count), tiebreaker rounds,
  missing air_date (excluded from era-sensitive stats), zero-value rows.
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
- **Cache key (full spec)**: (opponentModel, rhoB, rhoP, opponents' DD strategy,
  fjStrategy, includeFJ) — any of these changing invalidates the table (rebuild with
  progress UI); your skill and scores are table dimensions, never cache keys. Equity
  mode pins the invalidating knobs while active and says so in the UI, so casual
  slider play doesn't trigger surprise 5s rebuilds.
- Invariants tested: V monotone ↑ in your score; V→1 for pre-FJ lock with FJ off;
  V clamped [0,1]; out-of-range queries clamp to table bounds.

**E-3 Equity DD wagering.** New SimConfig strategy **`'equity'`** (UI label
"Optimal (equity)"; named for what it computes, not an overclaim). At a DD:
argmax over bet grid (minWager → all-in, ~$500 steps ≤ 40 evaluations) of
`Equity(bet) = p × V(S₊) + (1−p) × V(S₋)`, p = difficulty-adjusted precision
(same machinery as regular DD resolution). Existing presets untouched; `'equity'`
is additive; default config unchanged (rollback = revert commit).

**E-4 Dual-config validation harness** (`app/src/sim/equity-validation.test.ts`).
- **Paper-replication config** (symmetric players, ρ=0, no difficulty scaling —
  matches the IYSE 6644 model): scores [19400, 6400, 17200], last DD, 13 clues
  remaining, 55% confidence → equity at $3,200/$5,000/$12,400 reproduces
  36%/45%/55% within ±5pp, seeded. Monotonicity: equity non-decreasing across
  that wager range.
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
not the cherry-pick ceremony; all in blast radius, ≤1 day CC each):
- DD strategy selector gains "Optimal (equity)"; first use triggers V-table build with
  the existing worker progress UI; selection reverts gracefully on build failure
  (toast + fallback to previous strategy — never silent wrong numbers).
- **Equity-curve mini-chart**: at any DD (GameDetail / GameAnalyzer), plot equity vs
  wager — the interactive version of Ben's paper's figure.
- **DD wager tooltip** in GameDetail: "You bet $5,000. Optimal: $12,400 (+10pp equity)."
- **Confidence input** on GameAnalyzer DD analysis (the paper's confidence×wager grid,
  personalized).
- **DD-placement heat strip** from E-1 priors ("where DDs actually live"), rendered
  from clue-stats.json.
- All Games recolor: raise refined pass 5 → ~25 sims/game (measured; per-square SE
  improves ~±20pp → ~±10pp — aggregate patterns and Your Number benefit most;
  per-square noise remains and is stated honestly, not claimed away).

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
