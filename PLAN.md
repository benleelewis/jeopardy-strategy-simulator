# Plan: Make the Explorer Answer the Question — Accurate Wagering, Real Calibration, Honest Axes

*Drafted 2026-07-03 from FABLE_LIFT_ANALYSIS.md (#1 + #2), TASKS.md, and Ben's product direction (below). Target: app/src/sim/* + Explorer view*

## Product direction (Ben, 2026-07-03)

> "I'm favoring usability and cool interaction design over complexity. The all-games
> yellow/blue graph is 8/10 — thematic, multiple levels of abstraction, genuinely
> interesting. The first-page graph (player skill plotted against another) is
> probably a 5/10 — it's fuzzy and doesn't answer what I want it to answer.
> Partially because computations aren't accurate and also because axes don't
> reflect exactly what I want."

Implications this plan adopts:
1. **The All Games contribution graph is the product's spine.** Don't destabilize
   it; improvements should feed it (better per-game win-rate accuracy recolors it).
2. **The Explorer heat map must earn its place.** Its two failures are named:
   inaccurate computations (fixed by W1–W6 below) and axes that don't mean what
   Ben wants (fixed by W0 below). Fuzziness is both statistical (Monte Carlo noise)
   and semantic (axes that don't map to actionable questions).
3. **Usability and interaction design beat model complexity.** Engine work below is
   justified only insofar as it makes the visualizations truthful and interesting.
   Any work item that adds complexity without changing what the user sees or can do
   gets cut or deferred.

## Problem

The simulator's wagering layer is a placeholder. `ddWager()` (sim-engine.ts:187-207)
picks from four fixed heuristics (25% / 75% / all-in / flat fraction), and Final
Jeopardy (sim-engine.ts:365-410) uses a one-rule strategy (leader covers 2× second,
everyone else all-in). Tesauro 2012's headline finding — quoted in BRAINSTORM.md — is
that DD wagering and DD seeking dominate win rate against strong opponents more than
any other factor. The heat map cannot show that effect today because the layer
underneath it is fake. Separately, the engine's DD placement prior
(`DD_ROW_WEIGHTS = [0.02, 0.04, 0.15, 0.31, 0.48]`) and difficulty curves are
folklore-calibrated, while a 529,939-row clue-level dataset
(`combined_season1-41.tsv`) sits unparsed in the repo root.

## Goal

1. Replace heuristic DD and FJ wagering with a Watson-style equity calculation:
   `Equity(bet) = p_correct × V(S_win) + (1 − p_correct) × V(S_lose)`, where V is a
   game-state value function estimating P(win | scores, clues remaining).
2. Validate the implementation against the known-answer table from Ben's IYSE 6644
   paper (episode #8276 state: scores [19400, 6400, 17200], last DD, 13 clues
   remaining, 55% confidence): $3,200 → ~36%, $5,000 → ~45%, $12,400 → ~55% equity.
3. Parse the clue-level dataset into empirical priors: DD placement probability by
   row × round × era, real DD wager distributions, and difficulty curves — and feed
   them into the engine in place of hardcoded constants.

## Work Items

### W0 — Explorer axes redesign (design decision, gates the rest of the Explorer work)

The current axes are Knowledge (b×p composite) × Buzzer Speed (relative weight).
Ben's verdict: they don't reflect what he wants to know. Before pouring accuracy
into the wrong frame, decide what question the Explorer answers. Candidate framings
to evaluate (design review should pressure-test; final call is Ben's):

- **A. "How good am I?" axes (interpretable units)**: X = % of clues you'd answer
  correctly if you buzzed (precision), Y = % of buzzer races you win. Every real
  contestant and famous player maps onto these from data; positions stop being
  abstract weights.
- **B. "What should I do?" axes (actionable)**: X = knowledge (study hours move
  you), Y = buzzer skill (practice moves you) — the current frame, but recalibrated
  so units are honest and the marginal-returns panel says "10 more study-hours ≈
  +2% win rate."
- **C. Coryat-anchored axes**: X = expected Coryat score (real, checkable against
  a contestant's actual games), Y = buzz attempt rate. Anchors the whole map to a
  number Jeopardy people already know.

De-fuzzing (statistical): raise refined-pass sim counts and/or grid smoothing where
the color field is visibly noisy; contour lines should read as confident, not
smudged. This is bounded, measurable work (existing adaptive-resolution pipeline).

Deliverable: one chosen axis semantics, famous-player positions recomputed for it,
StatsPanel/marginal-returns copy rewritten in its units, and the estimate→position
mapping in GameAnalyzer updated to match.

### W1 — Game-state value function V(S)

New module `app/src/sim/value-function.ts`.

- **Design**: V(scoreYou, scoreOpp1, scoreOpp2, cluesRemaining) ≈ P(win). Tesauro
  never published Watson's neural-net GSE, so we substitute a **precomputed rollout
  table**: dimensionality-reduce to (yourShare = S_you / totalOnBoard+scores,
  leadRatio, cluesRemaining bucket), populate by Monte Carlo rollout using the
  existing `simulateRound`/`simulateFinalJeopardy` machinery, ~50–100 rollouts per
  cell, Gaussian-smoothed (reuse `gaussianBlur2D` from math-utils.ts).
- **Interpolation**: trilinear between cells at query time. O(1) per lookup — this
  is the hot path inside the Monte Carlo inner loop; a rollout per wager decision
  would be ~1000× too slow for the heat map.
- Table is built lazily per opponent model and cached in the worker (same pattern
  as the persistent games-data cache).

### W2 — Equity-based DD wagering

Extend `ddWager()` with a new strategy `'optimal'`.

- At a DD, evaluate Equity(bet) over a coarse bet grid (min-wager → true DD in
  ~$500 steps, ≤ ~40 evaluations), pick argmax.
- p_correct = player's difficulty-adjusted precision on that clue (existing
  `p × difficultyMultiplier` machinery), consistent with how regular DD resolution
  already computes it.
- Keep existing presets (`conservative`/`aggressive`/`truedd` and the continuous
  `ddWagerFraction`) untouched — UI selector keeps working; `'optimal'` is additive.
- SimConfig gains `ddStrategy: 'optimal'` as a new enum member.

### W3 — Equity-based FJ wagering

Replace the single-rule FJ block with a strategy that evaluates equity over the
wager grid for each player, using FJ accuracy (correlated ρ≈0.3 as today) and the
opponents' plausible wager distributions.

- Keep the classic score-position rule as the default (`fjStrategy: 'standard'`),
  add `'optimal'`. Opponents continue using the standard rule (models real
  contestants; Tesauro: champion wagering is only "more coherent," not equity-perfect).
- Lock-game handling must remain: leader with > 2× second bets for the lock.

### W4 — Known-answer validation harness

New test file `app/src/sim/equity-validation.test.ts`.

- Encode Ben's paper scenario: scores [19400, 6400, 17200], last DD on the board,
  13 clues remaining, DD confidence 55%.
- Assert equity at wagers $3,200 / $5,000 / $12,400 reproduces 36% / 45% / 55%
  within ±5 percentage points (Monte Carlo tolerance; paper used 10M runs, we run
  fewer with a fixed seed).
- Add a seeded RNG utility for deterministic tests (current engine uses raw
  `Math.random()`; inject an optional RNG parameter, default unchanged).
- Assert the paper's qualitative finding: equity is monotonically non-decreasing in
  wager between $3,200 and $12,400 at 55% confidence.
- All 30 existing tests stay green.

### W5 — Clue-level dataset parser

New script `scripts/build-clue-stats.ts` (mirrors existing `scripts/build-games.ts`).

- Input: `combined_season1-41.tsv` (529,939 rows; schema verified: round,
  clue_value, daily_double_value, category, comments, answer, question, air_date,
  notes). DD rows keep face value in clue_value with wager in daily_double_value.
- Derive:
  - **DD placement prior**: P(DD | row, round), where row is inferred from
    clue_value with **era normalization** (values doubled 2001-11-26; pre-doubling
    seasons use $100–500/$200–1000 scales) — verified present in the data.
  - **Real DD wager distribution**: wager as fraction of round max and, joined
    against scoring data where possible, as fraction of contestant score.
  - **Round structure sanity stats**: clues per game per round (detect incomplete
    boards and exclude them, same filter philosophy as build-games.ts).
- Edge cases handled explicitly: missing/zero clue_value rows, tiebreaker rounds
  (round 3+), missing air_date, malformed rows (log + skip, report counts).
- Output: `app/public/clue-stats.json` (small — aggregated priors only, not rows).

### W6 — Feed empirical priors into the engine

- `DD_ROW_WEIGHTS` becomes the fallback default; engine accepts an optional
  `ddRowWeights` on SimConfig, loaded from clue-stats.json at app startup.
- Acceptance check: fitted prior should qualitatively match the folklore
  ("bottom 3 rows heavily favored"); if it diverges wildly, that's a finding to
  surface, not silently ship.
- Difficulty curves: compare fitted DD-row distribution and wager norms against the
  tsx-derived `difficultyMultiplier`; recalibrate constants only if the data clearly
  contradicts them (document either way in BRAINSTORM.md).

### W7 — UI integration (usability-first, per product direction)

- DD strategy selector gains "Optimal (equity)" option; FJ toggle gains strategy
  choice only if trivial — otherwise FJ optimal ships engine-side behind config.
- Loading state: first heat-map pass with `'optimal'` must show the existing
  progress UI while the V-table builds (reuse worker progress messages).
- **All Games graph inherits the accuracy win for free**: per-game win rates
  recompute through the same engine, so the 8/10 view gets more truthful colors
  with zero layout change. Verify recolor performance is unchanged.
- No new views or tabs. Explorer layout changes only as required by W0's axis
  redesign (axis labels, StatsPanel copy, famous-player markers).

## Sequencing

W0 (axis decision) → W5 → W1 → W2 → W4 → W3 → W6 → W7. (W0 first because axis
semantics determine what the calibration must produce and what "accurate" means
on-screen; W5 before W1 so empirical p_DD(row) exists before the equity model
consumes it; W4 gates W3 — validate DD equity before touching FJ.)

## NOT in scope

- DD *seeking* / board-control square-selection strategy (Tesauro's
  p_DD + 0.1×p_RC selection policy) — the engine has no square-selection model at
  all today (board control goes to score leader); adding one is its own project.
- Multi-game/tournament wagering, endgame ADP buzz strategy.
- Category-level knowledge modeling from the clue text.
- J-Archive live fetch (separate task, TASKS.md Phase 1F).
- Any LLM integration (CEO-review decision: closed-form simulator, static data).

## Risks

- **V(S) fidelity**: a coarse rollout table may be too smooth to reproduce the
  paper's numbers. Mitigation: the validation harness (W4) is the gate; if ±5pp
  fails, increase table resolution/rollouts before touching FJ.
- **Perf regression**: equity argmax adds ~40 V-lookups per DD × 3 DDs per game.
  With O(1) lookups this is negligible, but the V-table build itself (~thousands of
  rollouts) must be a one-time-per-model cost, cached, off the drag path.
- **Era normalization errors** in W5 would corrupt the DD prior. Mitigation:
  validate row inference against known constraints (5 rows per round, DD never in
  row 1 more than ~2% of the time post-2001).
- **Test brittleness**: Monte Carlo assertions need seeds + tolerances, not exact
  equality.

## Acceptance

1. `npm test` green: 30 existing + new W4 harness + W5 parser unit tests.
2. Equity table reproduces Ben's paper within ±5pp at all three known points.
3. Heat map with DD strategy "Optimal" visibly differs from "Aggressive" (the
   Tesauro effect becomes showable), with no interaction-latency regression.
4. `clue-stats.json` ships with documented row counts: total parsed, excluded,
   DD count (~3 per game × ~8.6K games ≈ 26K DDs expected).
5. **Explorer answers Ben's question**: axes in units he chose (W0), color field
   reads confident (not fuzzy), marginal-returns panel speaks those units. Target:
   Ben re-rates the Explorer ≥ 7/10.
6. All Games graph unchanged in feel and performance, recolored by the more
   accurate engine.
