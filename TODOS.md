# TODOS

Deferred work with context. Created 2026-07-03 by /autoplan (CEO review deferrals).

## From /autoplan 2026-07-03 (PLAN.md review)

- [ ] **P2 — All Games optimal-vs-actual delta coloring.** Second color mode on the
  contribution graph: how much better would you do with equity wagering vs your
  actual/heuristic strategy. Deferred: the All Games graph is Ben's 8/10 spine —
  don't touch it until PLAN.md Track E is proven stable. Depends on: E-3, E-4.
- [ ] **P3 — Your Number share card.** Exportable image of "You'd win N% of all
  games" + histogram. Outside current blast radius.
- [ ] **P3 — Strategy-oracle full ranking** (design doc Screen 3). Rank ALL
  dimensions by marginal win-rate return at your position. Depends on: honest axes
  (P-1) + accurate wagering (Track E). The 12-month trajectory item.
- [ ] **P3 — Mobile Explorer layout** (design doc Open Question #5). 3-column layout
  fails on mobile; needs tab/accordion pattern. Fails the "show someone at a bar" test.
- [ ] **P2 — DD seeking / square-selection strategy** (Tesauro p_DD + 0.1×p_RC).
  Requires a real board-control model (E-0's stochastic control is only a de-biasing
  shim). This is Tesauro's #1 win-rate factor — the natural next engine project
  after this plan ships.
- [ ] **P3 — ContributionGraph screen-reader support.** Canvas has no accessible
  text alternative (pre-existing gap, noted during review). Offscreen summary table
  or aria-label with headline stats.
- [ ] **P2 — GameDetail DD event rows.** GameDetail currently has no per-DD view and
  its data model carries no DD score-state; adding DD event rows (wager, outcome,
  score before/after) unlocks the third-person equity tooltip ("Actual wager: $X.
  Equity-optimal: $Y") for historical games. Surfaced by Phase 2 design review of
  PLAN.md E-7. Depends on: E-2/E-3 (V + equity), game data enrichment.
- [ ] **P2 — DD impact difference map overlay** (carried from TASKS.md CEO-review
  list). Show WHERE DD strategy matters most on the K×B space. Natural companion to
  E-3 once equity wagering exists.
- [ ] **P3 — Study planner** (carried from TASKS.md). "Study X hours → knowledge
  moves Y%" — needs data calibration (E-1) first.
