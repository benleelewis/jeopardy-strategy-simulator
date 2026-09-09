# Where Claude Fable 5 Would Give the Highest Lift

*2026-07-02*

## Why this doc

The app has no LLM in it anywhere and shouldn't — it's a closed-form Monte Carlo
simulator (`app/src/sim/sim-engine.ts`), and the CEO-review decisions in
`CLAUDE.md` lock in a static dataset with no live API calls. So "lift from
Fable" isn't about embedding a model in the product. It's about which
*remaining engineering task* would actually benefit from handing it to
Claude Fable 5 instead of Sonnet — i.e., where the gap between "capable model
that gets it right first-shot after deep reasoning" and "competent model
that needs supervision" actually changes the outcome.

Most of what's left in `TASKS.md` is routine (UI sliders, a fetch route,
JSON plumbing) — no model-capability differential there; Sonnet or even
Haiku is correctly sized for it. Two items are not routine: they require
reading dense math out of an academic paper, making judgment calls where the
paper is underspecified, and self-verifying against known numbers over a
long autonomous run. Those are the candidates below.

## Scoring framework

For each remaining task I asked: (a) is the spec underspecified enough that
a model has to make judgment calls, not just follow instructions, (b) does
correctness require synthesizing across a dense source document rather than
local code context, (c) is there a long autonomous verification loop where
more reasoning depth reduces wasted iterations, (d) can Ben actually check
the output against something he already knows (so delegating to a more
expensive/autonomous model is low-risk). High marks on all four = high lift.

## Ranked candidates

### 1. Watson-style equity DD/FJ wagering — HIGH LIFT

**Current state:** `sim-engine.ts:186-205` (`ddWager`) picks from four fixed
heuristics — 25% of score, 75% of score, all-in, or a flat configured
fraction. `sim-engine.ts:359-394` (Final Jeopardy) uses a simplified
score-position rule (leader covers 2× second place, everyone else bets
everything). Neither implements what `BRAINSTORM.md` identifies as the
single most important strategic layer in the whole system:

> Watson used reinforcement learning with neural net game-state evaluator
> (GSE). Equity(bet) = p_DD × V(S_W + bet) + (1 − p_DD) × V(S_W − bet)

**Why this is the gap that matters:** Tesauro 2012's headline finding —
quoted in your own `BRAINSTORM.md` — is that DD-seeking and DD-wagering
dominate win rate more than any other factor against strong opponents. The
app's heat map currently can't show *that* effect because the wagering layer
underneath it is a placeholder. This is also the exact subject of Ben's own
IYSE 6644 paper (10M-run Monte Carlo, 220-sample confidence×wager grid,
known result table at 55% confidence: $3,200→36%, $5,000→45%, $12,400→55%).

**Why it's a Fable-shaped task, not a Sonnet-shaped one:**
- Tesauro never publishes Watson's actual GSE — it's a trained neural net.
  Reproducing "equity-based wagering" without that net means *designing* a
  substitute value function V(S) — e.g., a Monte-Carlo-rollout value
  estimate seeded by the existing sim engine, or a closed-form approximation
  fit to it. That's a judgment call under real ambiguity, not a lookup.
- Getting it right requires holding both papers' formulas in context at
  once (`tesauro2012.pdf` equity formula + Ben's paper's known-answer table)
  while writing and testing TypeScript that plugs into the existing
  `SimConfig`/`ddWager` interface without breaking the 30 passing tests.
  This is exactly "first-shot implementation of a well-specified system from
  a dense source" — the mode Fable is built for, per Anthropic's own
  migration guidance for long-horizon, ambiguity-heavy coding work.
- **Self-verifiable in one sitting:** the model can run its own
  implementation against Ben's paper's known result table (55%/$5,000→45%
  equity, etc.) and iterate until it matches — a long autonomous
  verify-and-revise loop where Fable's stated strengths (grounded progress
  claims, self-checking harnesses) directly reduce wasted turns.
- **Low risk to delegate to a more expensive model:** Ben already knows the
  correct answer shape from his own paper, so a wrong result is easy to
  catch — the ideal profile for using the most capable (and priciest) model.

**Scope for a Fable 5 handoff:** replace `ddWager()` and the FJ wager block
with an equity-based calculator; add a rollout-based or fitted `V(score)`
game-state value function; validate against Ben's paper's table as an
automated test case; keep the existing heuristic strategies (`conservative`/
`aggressive`/`truedd`) as selectable presets so the UI's DD strategy
selector still works unchanged.

### 2. Real-data calibration from the 529K-row clue-level dataset — HIGH LIFT

**Current state:** `TASKS.md` line 63 explicitly defers this
("Parse combined TSV → DD placements per game — deferred, scoring data
sufficient for V1"). Today's opponent calibration
(`app/src/sim/calibrate.ts`) is a Coryat-based heuristic derived from
game-level *scoring* rows only. The clue-level file
(`combined_season1-41.tsv`, 529,939 rows, already sitting in the repo root
inside `jeopardy_dataset_seasons_1-41.zip`) has never been parsed at all —
it's the source that would give real empirical DD-location probabilities by
board position and real buzz/precision distributions conditioned on clue
difficulty, both called out as "what's missing" in `BRAINSTORM.md`.

**Why it's a Fable-shaped task:** this is open-ended data engineering over
a large, undocumented, messy real-world file — schema has to be discovered
empirically, edge cases (ties, no-buzz clues, missing DDs) have to be
handled by judgment, and the payoff (does the fitted DD-location prior match
the "bottom 3 rows heavily favored" folklore in `BRAINSTORM.md`? does fitted
precision-by-difficulty match the Coryat difficulty-scaling formula already
in the tsx prototype?) requires synthesizing across the existing codebase,
the dataset, and the research notes simultaneously over what's realistically
a many-minutes autonomous run — build, inspect, refit, re-check.

**Dependency note:** this pairs naturally with #1 — a real empirical p_DD(i)
by board position is exactly the input the equity wagering model needs
instead of a hardcoded prior.

### 3. J-Archive single-URL fetch + parser (`TASKS.md` Phase 1F) — LOW LIFT

Well-specified: one URL, one HTML shape, try/catch → manual-entry fallback,
behind a Vercel API route (to dodge CORS, per the CEO-review decision to
never bulk-scrape). No research synthesis, no ambiguous judgment calls.
Sonnet is correctly sized for this; running it on Fable would mostly buy
longer turns for no accuracy gain.

### 4. Ben's game backtest / episode #8276 replay (`TASKS.md` Phase 3) — MEDIUM, BUT BLOCKED

Genuinely interesting (bridges the abstract heat map to a concrete personal
result) but its value is capped by #1 — without real equity-based DD
wagering, a "what if you'd bet optimally" backtest is just re-running the
same placeholder heuristic. Sequence this after #1, not before.

### 5. Everything else remaining in `TASKS.md` — NO LIFT

Sim-count slider, DD impact overlay rendering, Phase 2 view routing/linked
views, Phase 3 community features — all either pure UI work or straightforward
extensions of patterns already established in the codebase (the axis/
dimension system in `dimensions.ts` already generalizes cleanly). Default to
Sonnet; there's no capability gap to buy back here.

## Recommendation

Hand off **#1 (equity-based DD/FJ wagering)** first — it's the highest-value,
most self-verifiable, most ambiguity-heavy piece of remaining work, and it's
the one place in the whole project where "most capable model available"
actually changes whether the output is *correct* rather than just *present*.
Sequence **#2 (clue-level data calibration)** right after, ideally with the
same session/context so the fitted DD-location priors and difficulty curves
feed directly into #1's equity model rather than being bolted on later.

To actually run this: spawn a Fable-5-backed agent (`Agent` tool,
`model: "fable"`) scoped to `app/src/sim/`, with both PDFs
(`tesauro2012.pdf`, `ferrucci2012.pdf`) and `BRAINSTORM.md` /
`app/src/sim/sim-engine.test.ts` as required reading, and Ben's paper's
result table as the acceptance test.
