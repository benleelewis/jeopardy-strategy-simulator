# Jeopardy Win % Simulator - Project Handoff

## What This Is

An interactive visualization that implements Roger Craig's insight: "It's not the probability a topic comes up, it's the probability it comes up AND you studied it." 

The tool lets users explore the 2D win-rate landscape of Jeopardy performance by dragging a marker across a heat map of **knowledge % × buzzer skill %**. It shows in real-time how improving either dimension affects your win rate, and critically, which dimension is your bottleneck at any given position.

## Core Insight

Jeopardy performance isn't additive—it's multiplicative. You need BOTH knowledge and buzzer timing:
- **Low knowledge, high buzzer**: Can't win if you don't know answers
- **High knowledge, low buzzer**: Can't win if you can't ring in
- **Sweet spot**: The heat map reveals the interaction effects

The visualization makes this tangible by showing marginal returns: "+10% knowledge → +X% win rate" vs "+10% buzzer → +Y% win rate" at your current position.

## Architecture

### Tech Stack
- **Pure vanilla JS + D3.js** - No framework, single HTML file
- **Monte Carlo simulation** - Runs in-browser
- **D3 Voronoi tessellation** - For smooth heat map interpolation

### File Structure
```
jeopardy-simulator-v2.html  (standalone, ~400 lines)
├── Simulation engine (lines 193-291)
├── Visualization (lines 293-492)
└── Initialization (lines 494-506)
```

## How It Works

### 1. Simulation Engine

```javascript
simulateSingleGame(yourK, yourB, oppK[], oppB[])
```
- Simulates one 3-player Jeopardy game
- 60 clues total (30 J-round, 30 DJ-round)
- For each clue:
  - Sample who knows it (Bernoulli trial with knowledge %)
  - Among those who know, weighted sample who buzzes first (buzzer %)
  - Award points to winner
- Returns boolean: did you win?

```javascript
calculateWinPercentage(yourK, yourB, opponentModel, nSims)
```
- Runs `nSims` games
- Samples 2 opponents from distribution each time
- Returns win rate

```javascript
precomputeGrid(opponentModel, resolution)
```
- Pre-computes win % for a (resolution × resolution) grid
- Currently: 12×12 = 144 points, 100 games each = 14,400 games total
- Takes ~5-10 seconds on load

### 2. Opponent Model

Four archetypes weighted by prevalence:
```javascript
Average:        60% knowledge, 50% buzzer (60% of field)
Genius/Slow:    80% knowledge, 35% buzzer (15% of field)
Fast/Shallow:   45% knowledge, 70% buzzer (15% of field)
Champion:       80% knowledge, 75% buzzer (10% of field)
```

Each sampled opponent adds ±5% noise to archetype values.

### 3. Visualization

- **Heat map**: D3 Voronoi tessellation of pre-computed grid points
- **Color scale**: Red-Yellow-Green (d3.interpolateRdYlGn)
- **Draggable marker**: D3 drag behavior on green "YOU" circle
- **Live updates**: On drag, recalculates win % (500 games) + marginals (200 games each)

## Performance Tuning

Current simulation counts (editable in code):

| Context | Games | Purpose | Line # |
|---------|-------|---------|--------|
| Heat map grid | 100 | Pre-compute on load | ~279 |
| Live position | 500 | On drag update | ~426 |
| Marginal K | 200 | Bottleneck analysis | ~433 |
| Marginal B | 200 | Bottleneck analysis | ~440 |

**Trade-off**: More games = smoother/more accurate, but slower.

For faster initial load, reduce heat map to 50 games.  
For production quality, increase to 1000+ games.

## Known Simplifications

1. **No Daily Doubles** - Game model is pure knowledge × buzzer
2. **No Final Jeopardy** - Only regular clues
3. **No runaway games** - Doesn't model "unreachable" scenarios
4. **Fixed 3 players** - Always you + 2 opponents
5. **Independent clues** - No category clustering or difficulty progression

These are features, not bugs—keeps the viz focused on the core insight.

## Extension Ideas

### Easy Wins
1. **Add sliders** instead of just dragging (some users prefer this)
2. **Show sample game outcomes** - "Here are 3 games you won/lost and why"
3. **Zoom into regions** - Let users click to see higher-resolution heat map of a quadrant
4. **Export data** - Download CSV of grid points for external analysis

### Medium Effort
5. **Compare to real players** - Add "Ken Jennings", "James Holzhauer" markers from historical data
6. **Adjustable opponent field** - Slider to make field easier/harder
7. **Category breakdown** - "If 20% of clues are opera vs history, how does this change?"
8. **Confidence intervals** - Show error bars on win % estimates

### Ambitious
9. **Add DD strategy layer** - Integrate Ben's GT coursework on optimal DD betting
10. **Pull real J-Archive data** - Use actual clue distributions and contestant stats
11. **Multi-day tournament sim** - Model TOC/GOAT format
12. **Learning curves** - Show optimal study paths: "Study opera for 10 hours → move from here to here"

## Integration with Existing Work

**Ben's GT simulation** (JeopardySimulator__2_.ipynb):
- Focused on DD optimal betting given board state
- Uses `play_game()` function with wager parameter
- Could integrate by:
  1. Adding DD placement to `simulateSingleGame()`
  2. Calling Ben's optimal wager function when DD hit
  3. Adding a toggle: "Simple mode" (current) vs "DD mode"

The architecture supports this—just need to enhance the simulation engine while keeping the viz layer unchanged.

## How to Run

1. Open `jeopardy-simulator-v2.html` in any modern browser
2. Wait 5-10 seconds for heat map to compute
3. Drag the green marker around
4. Watch win % and bottleneck analysis update

No build step, no server, no dependencies beyond D3 CDN.

## Code Quality Notes

**What's good:**
- Clean separation: simulation engine → viz layer
- Self-contained (one file, works offline after first load)
- Readable variable names
- Comments at key decision points

**What could improve:**
- No tests (Monte Carlo makes this tricky but doable)
- Magic numbers (opponent weights, simulation counts) should be constants at top
- Could extract configuration object
- D3 code is imperative—could be more functional

## Testing Strategy

1. **Sanity checks** (run these in console):
```javascript
// Win % should increase with both knowledge and buzzer
console.assert(
  calculateWinPercentage(0.8, 0.8, expandedModel, 1000) >
  calculateWinPercentage(0.5, 0.5, expandedModel, 1000)
);

// Edge cases
console.assert(calculateWinPercentage(0, 0, expandedModel, 100) < 0.05);
console.assert(calculateWinPercentage(1, 1, expandedModel, 100) > 0.95);
```

2. **Visual inspection**:
- Heat map should be smooth (no artifacts)
- Highest win % should be top-right corner
- Opponent markers should sit at reasonable positions
- Dragging should feel responsive (<500ms update)

3. **Cross-browser**:
- Tested in Chrome ✓
- Should test: Firefox, Safari, Edge

## Questions for Product Direction

1. **Audience**: Is this for Jeopardy contestants, data science demos, or general edu?
2. **Accuracy vs Speed**: Current balance okay, or want higher fidelity?
3. **Extensions**: Which of the 11 ideas above are worth pursuing?
4. **Data source**: Stick with synthetic opponents or pull real J-Archive stats?

## Handoff Checklist

- [x] Code is documented
- [x] Performance characteristics explained
- [x] Extension path outlined
- [x] Known limitations called out
- [x] Testing strategy defined
- [ ] User testing with 3-5 people
- [ ] Accessibility audit (keyboard nav, screen readers)
- [ ] Mobile responsive design
- [ ] Analytics/instrumentation

## Contact

Original implementation: Claude (2024-03-21)  
Based on concept by: Ben (data science, Irvine)  
Inspired by: Roger Craig's Jeopardy study methodology  
Related work: Ben's GT ISYE6501 DD betting optimizer

---

**Bottom line**: This is a working MVP that demonstrates the core insight clearly. It's production-ready for a demo/edu context, but needs polish for a public launch (mobile, accessibility, testing). The simulation engine is solid and extensible—the main question is which features to prioritize next.
