# Jeopardy Simulator — Brainstorm & Research Notes

## Core Insight (from all sources)

Jeopardy performance is **multiplicative**, not additive. You need BOTH knowledge and buzzer skill. The heat map makes this visceral — you can *feel* the interaction effects by dragging across the 2D space.

Roger Craig's framing: "It's not the probability a topic comes up, it's the probability it comes up AND you studied it."

## Key Numbers from Tesauro (Watson's Game Strategies, 2012)

### Contestant Performance Profiles (~3000 J! Archive episodes)
| Level | Buzz Attempt Rate | Precision | FJ Accuracy |
|-------|------------------|-----------|-------------|
| Average | 61% | 87% | ~50% |
| Champion (TOC) | 80% | 89% | ~60% |
| Grand Champion | 85.5% | 91.5% | ~66% |

### Regular Question Outcome Model
- Mean buzz attempt rate: b = 0.61
- Buzz correlation between players: ρ_b = 0.2
- Mean precision (accuracy given buzz): p = 0.87
- Right/wrong correlation: ρ_p = 0.2
- The positive right/wrong correlation is surprising — expected negative from "tip-off effect" (seeing a wrong answer helps the rebound), but knowledge correlation dominates

### Key Finding: DD Seeking > Everything Else
Watson's simulation studies showed that **finding Daily Doubles is overwhelmingly the most important factor in win rate** against strong opponents. Retaining board control is second. Category learning only matters after all DDs are found.

### DD Location Probabilities
- Bottom 3 rows heavily favored (well-known from J-Archive)
- Watson used Bayesian inference: prior from historic frequencies, updated as squares revealed
- Square selection: maximize p_DD(i) + 0.1 * p_RC(i) where p_RC = probability of retaining control

### DD Wagering
- Watson used reinforcement learning with neural net game-state evaluator (GSE)
- Equity(bet) = p_DD × V(S_W + bet) + (1 - p_DD) × V(S_W - bet)
- Risk mitigation reduced Watson's bet from $9,300 to $6,700 in one example, costing only 0.2% equity but reducing downside risk by >10%
- At 45% confidence → optimal bet ~$5; at 75% → ~$9,300; at 85% → all-in

### FJ Wagering
- Complex conditional strategy based on score positioning (A/B/C)
- Data segmented by B/A ratio and B/C ratio
- Champion wagering is "much more coherent and logical" than average contestant wagering
- Correlated right/wrong outcomes (ρ ≈ 0.3)

### Endgame Buzz Strategy
- Approximate Dynamic Programming for last 5 questions
- "Desperation buzz" scenarios where you must buzz to avoid lockout
- Sometimes optimal threshold drops to zero (risk-free buzz)

## From Ben's DD Paper (IYSE 6644, 2022)

### Setup
- Ben's actual game: scores [19400, 6400, 17200], last DD with 13 clues remaining
- Wagered $5000, optimal was higher
- 10M Monte Carlo runs, 220 samples (5 confidence levels × 44 bet amounts)

### Results
| Confidence | Wager | Win Equity |
|-----------|-------|------------|
| 55% | $3,200 (avg) | 36% |
| 55% | $5,000 (Ben's) | 45% |
| 55% | $12,400 (optimal) | 55% |

**No confidence threshold between 35-75% where you should NOT bet more.** Always bet bigger.

### Limitation
- Assumes all players equally likely to buzz in and answer correctly after DD
- No category-specific accuracy
- Single board state, not generalized

## From the Heat Map Prototype (v2)

### Current Opponent Model (simplistic, needs upgrading)
```
Average:      60% knowledge, 50% buzzer (60% of field)
Genius/Slow:  80% knowledge, 35% buzzer (15% of field)
Fast/Shallow: 45% knowledge, 70% buzzer (15% of field)
Champion:     80% knowledge, 75% buzzer (10% of field)
```

### Current Simulation Counts
| Context | Games | Notes |
|---------|-------|-------|
| Heat map grid (12×12) | 100 each | Noisy but fast |
| Live position (on drag) | 500 | Decent accuracy |
| Marginal calculations | 200 each | Could be higher |

### What's Missing
1. Daily Doubles (biggest gap — DD seeking is the #1 factor per Tesauro)
2. Final Jeopardy
3. Wrong answer penalties (current model only awards points, never deducts)
4. Correlated buzz/accuracy between players
5. Difficulty scaling by clue value
6. Category effects

## From the React Scatter Plot (tsx)

### Coryat Calculation Model
- Accounts for difficulty scaling: harder (higher $) questions have lower accuracy
- Jeopardy round: difficultyMultiplier = max(0.3, 1 - value/1000 × 0.3)
- DJ round: difficultyMultiplier = max(0.25, 1 - value/2000 × 0.4)
- 6 questions per value tier per round
- Realistic constraints: weak players (<65% acc) capped at 35% buzz; elite (>85% acc) must buzz ≥25%

### Named Player Benchmarks
| Player | Accuracy | Buzz-in | Est. Coryat |
|--------|----------|---------|-------------|
| Ken Jennings | 89% | 45% | $18,500 |
| James Holzhauer | 86% | 50% | $22,400 |
| Brad Rutter | 87% | 42% | $19,200 |
| Amy Schneider | 85% | 43% | $17,800 |
| Watson (IBM) | 85% | 48% | $20,800 |
| Average Contestant | 68% | 28% | $12,400 |

## Strategies Worth Testing

### 1. DD Hunting Impact
How much does DD-seeking (Holzhauer style, bottom rows first) change win rate vs top-down play? Tesauro says it's the #1 factor. Quantify the delta on the heat map.

### 2. Aggressive vs Conservative DD Wagering
Ben's paper shows always-bet-more is optimal in his scenario. Does this generalize? Test across the full knowledge×buzzer space:
- Conservative: average wager ($3,200)
- Moderate: 50% of score
- Aggressive: 75% of score
- True Daily Double: bet everything
- Optimal: use Watson's equity calculation

### 3. Opponent Field Strength Sensitivity
How does the heat map change when facing average contestants vs champions vs grand champions? The "sweet spot" probably shifts — against weak opponents, moderate knowledge suffices; against strong opponents, you need both dimensions maxed.

### 4. FJ Strategy Interaction
Does playing for a "lock game" (2× second place) via aggressive DD betting change the optimal buzz strategy? If you're ahead going into FJ, you can bet $0 and guarantee a win. This creates a threshold effect.

### 5. Category Knowledge Distribution
Uniform knowledge vs spiked (e.g., 90% in science, 40% in opera). A spiky knowledge profile might have the same "average" as uniform but very different win rates due to variance. This is the Roger Craig insight — study what comes up AND what you don't already know.

### 6. Wrong Answer Penalty Impact
The current heat map doesn't model wrong answers. In reality, buzzing in and getting it wrong loses points AND gives opponents a rebound chance. This should make the heat map more punishing for high-buzz/low-knowledge players.

### 7. Ben's Game Replay
Replay episode #8276 with different DD wagers and see how outcomes change. This bridges the abstract heat map with a concrete, personal result.

### 8. Multi-Game Tournament
How does optimal strategy change in a 2-game match (like Watson vs Jennings/Rutter) vs a single game? Tesauro found that multigame wagering is quite different.

## Bret Victor "Ladder of Abstraction" Design Ideas

The key principle: show the same system at multiple levels of abstraction, and let the user move between them fluidly.

### Proposed Layers (concrete → abstract)
1. **Single clue** — See one buzz-in decision play out
2. **Single game** — Watch scores evolve clue by clue, see where DDs fall
3. **Game distribution** — Run 1000 games, show score/win histograms
4. **2D parameter sweep** — The Knowledge × Buzzer heat map (our Phase 1 focus)
5. **Strategy comparison** — Same position, different DD/FJ strategies, side by side
6. **Full parameter space** — Vary everything: opponents, DDs, categories, tournament format

### The "time" dimension
Victor emphasizes "time as a variable." In our case:
- Within a game: score trajectory over 60 clues (+ DDs, FJ)
- Across games: win rate stabilizing over N games
- Across preparation: "If you study for 100 hours, your knowledge moves from here to here on the map"

## Architecture Notes

### Simulation Performance
- Current: 14,400 games for 12×12 grid (takes ~5-10s)
- Target: 20×20 grid × 1000 games = 400,000 games
- Solution: Web Worker + chunked computation with progress bar
- Alternative: pre-compute at build time, ship as JSON

### Visualization Approach
- D3 Voronoi tessellation works well for the heat map (already implemented)
- Consider canvas rendering for smoother heat map (WebGL stretch goal)
- Contour lines could replace/supplement Voronoi for cleaner look
- D3-contour library exists for this

### Data Pipeline
- **Dataset available:** `jeopardy_dataset_seasons_1-41.zip` (58MB) in repo root
- Contains `scoring_season1-41.tsv` (9,104 game rows) + `combined_season1-41.tsv` (529,939 clue rows)
- Also: `kids_teen_matches.tsv`, `extra_matches.tsv`, per-season TSVs
- Scoring columns: season, air_date, 3 contestant names, single/double/final scores, coryat, correct/wrong counts
- **Opponent inference from scoring data:**
  - `knowledge = correct / (correct + wrong + 1)` (epsilon smoothing)
  - `buzzer = (correct + wrong) / 60` (activity rate across both rounds)
  - `fjAccuracy` = if `final > double` → correct FJ, else incorrect
  - Cumulative fields: single=3300, double=8100 means DJ added 4800
- **FJ edge case:** Contestants with $0 or negative after DJ don't participate in FJ
- Expected ~7,500-8,500 regular-season games after filtering

### GitHub Contribution Graph (new primary viz)
- One square per historical game, colored by YOUR simulated win rate
- Canvas-based (not SVG) for 8K+ square performance
- Rows = seasons (1-41), columns = games within season (~200 per)
- Color scale: gray (0%) → light green (33%) → medium green (50%) → dark green (80%+)
- Click any square → drill into that specific game
- Drag yourself on the heat map → entire graph recolors in real time
- Progressive rendering: 1 sim/game fast pass → 10 sims/game refined background pass

### Personalization Insight
Different skill profiles produce genuinely different contribution graph patterns:
- Knowledge-heavy: dominates weak opponents (early seasons), struggles vs fast buzzers
- Buzzer-heavy: wins close buzzer battles, loses to higher-knowledge opponents
- DD-aggressive: higher variance — more dark green AND more gray squares
- FJ-strong: flips close games, "scattered green" pattern in medium-difficulty stretches

### Performance & Interaction Design Decisions (2026-03-22)
- **Drag throttling**: HeatMap marker drag uses `requestAnimationFrame` throttle — SVG position updates immediately for visual responsiveness, but React state updates are batched to ~60fps. Prevents excessive re-renders during fast drags.
- **Progressive all-games sim**: Two-pass system. Fast pass (1 sim/game, ~2s) gives instant rough coloring. Refined pass (5 sims/game) auto-triggers when fast pass completes and runs in background. If user drags again during refined pass, it cancels and restarts from fast pass.
- **Persistent Web Worker**: Games data (1MB) sent to worker once via `loadGames` message. Subsequent sims reuse stored data — no re-serialization on every drag.
- **Lazy sim trigger**: All-games sim only runs when Games tab is active. Params are marked stale on change; sim triggers on tab switch if stale.
- **URL hash state**: Uses `replaceState` (not `pushState`) to avoid polluting browser history during drag. Only encodes non-default pinned values to keep URLs short.

## External References

- [Jeopardy data gist](https://gist.github.com/Miopas/19d6d44b6c21b6b2ba868b13c30fb892) — Jeopardy dataset reference
