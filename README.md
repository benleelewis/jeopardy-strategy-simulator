# Jeopardy strategy simulator

[![CI](https://github.com/benleelewis/jeopardy-strategy-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/benleelewis/jeopardy-strategy-simulator/actions/workflows/ci.yml)

This project answers one question. If you went on Jeopardy with a given level of
knowledge and a given buzzer speed, how often would you win?

I was a contestant on the show. Afterwards I wrote a paper on Daily Double
wagering, and this is that work rebuilt as something you can use. It simulates
games, and it does so against opponent profiles built from 8,665 real games.

Live app: https://jeopardy-strategy-simulator.vercel.app

## What you can do with it

**All games.** This is the view the app opens on. All 8,665 regular season games
from September 1984 to July 2025 are drawn as one colored square each, arranged
by season and air date. The color is how often you would win that specific game,
against the two people who were actually there. You can click a season to open
it as a calendar, and click a game to see the scores, the Daily Doubles with the
wager the equity model would have made, a "What if" box on each of your Daily
Doubles that reruns the game from that point with a different wager, and a
"Watch this game" replay that plays the simulated game back clue by clue. A second color mode, "Gain from
optimal play", shows how much each game would improve with equity wagering and
Daily Double seeking. A Share button turns the headline into an image.

**Explorer.** This is a map of win rate over two skills that you choose. You
drag a marker to your own position and read your win rate off the map. The
markers for Ken Jennings, James Holzhauer, Brad Rutter, Amy Schneider, and
Watson are placed from their published statistics, so you can see where you sit
relative to them. Below the map, "What to work on" ranks every setting by how
much your win rate would change if you moved it one realistic step, with the
noise of the estimate shown next to each number. "How your games end" shows
the spread of your final scores and win margins at that position, and how
often the game is a runaway, a lock against you, or decided by Final Jeopardy.
A "Show DD impact" toggle recolors the map by how much your Daily Double
strategy is worth at each point.

**Your game.** If you have been on the show, enter what you scored and the app
works out the knowledge and buzzer speed those numbers imply. You can also type
a J-Archive game ID, pick yourself from the three contestants, and see what you
wagered on each Daily Double next to what the equity model would have wagered.
"Backtest this game" then replays your Daily Doubles under four strategies
(your actual wager, the equity wager, all in, and the minimum) and reports your
chance of winning under each, with the noise of the estimate. The same analysis
runs from the command line with `npx tsx scripts/backtest.ts --game <id>`.
If you have not been on the show, there are presets for an average player and a
strong player.

The Explorer works on a phone, and the All Games grid has a text alternative
and keyboard controls for screen readers.

## The data pipeline

Two scripts turn the raw files into small JSON files that the app loads. The
raw data is a set of tab separated files covering seasons 1 to 41, and it is not
checked into this repository because it is 77 MB when extracted.

| Script | Reads | Writes | What it does |
| --- | --- | --- | --- |
| `scripts/build-games.ts` | `scoring_season1-41.tsv` | `app/public/games.json` | Filters out kids, teen, and tournament matches, which leaves 8,665 games. Then it infers a knowledge and buzzer speed profile for each of the two opponents in each game. |
| `scripts/build-clue-stats.ts` | `combined_season1-41.tsv`, 529,939 rows | `app/public/clue-stats.json` | Streams the clue level file and derives where Daily Doubles actually appear on the board, and how much people actually wager on them. |

Three things in these scripts are worth pointing at.

**Nothing is dropped silently.** Every row that is skipped is counted, and the
counts are written into the output file. You can open `clue-stats.json` and see
that all 529,939 rows parsed, that 0 were malformed, and that 56 games were
excluded for having incomplete boards. If a future dataset update breaks the
parser, the count moves and you can see it.

**The output files record where they came from.** Each one carries the time it
was generated, the input file name, and the row counts. When a number in the app
looks wrong, you can tell which build produced it.

**Clue values are normalized across eras.** Jeopardy doubled all of its clue
values starting with the episode that aired on 26 November 2001. A wager of
$1,000 means something different before and after that date, so
`scripts/lib/era.ts` classifies each episode and both build scripts use it. The
rule is written in one place because two scripts need it.

There are two more scripts for looking at a single real position.
`scripts/lib/jarchive.ts` reads one game page from J-Archive and replays it clue
by clue to reconstruct the running score, which J-Archive does not publish. The
replay is checked against the score checkpoints that J-Archive does publish, so
a parsing mistake shows up as a mismatch rather than as a wrong answer that
looks fine. `scripts/dd-advisor.ts` then takes a Daily Double from that game and
sweeps every possible wager to find the best one.

Fetching is limited to one game page at a time and the result is cached on disk,
so re-running an analysis makes no further requests.

## How the numbers are checked

The simulator reproduces the published results in Gerald Tesauro's 2012 paper on
Watson's Jeopardy strategy. Set up with the paper's configuration, it returns
win rates of 36.4%, 43.2%, and 55.2% at three wager sizes, against the paper's
36%, 45%, and 55%. The largest error is 1.8 percentage points. This runs as a
test, so a change to the engine that breaks the agreement fails the build.

There are 276 tests in total. They cover the boundary cases, e.g., a player who
answers everything correctly wins more than 90% of the time. They also cover
monotonicity, which means that raising your knowledge or your buzzer speed never
lowers your win rate. A set of regression locks records the exact scores of
seeded games, so any change to the engine that alters the default behavior
fails the build even if every other test passes. Run them with `npm test`.

## Modeling choices worth knowing about

**Daily Double seeking.** The engine can play Tesauro's square selection rule,
which picks the square that maximises the chance of finding a Daily Double plus
a small weight on keeping control of the board. It is off by default and there
is a checkbox for it. With it on, a strong player finds 2.0 Daily Doubles per
game instead of 1.3.

**Daily Double accuracy.** By default the engine applies the same
difficulty-by-row scaling to Daily Doubles that it applies to every other clue,
so a bottom-row Daily Double is harder than a top-row one. Tesauro's paper
models Daily Double accuracy as one flat number instead. The difference matters
for how much seeking is worth: with the flat model a strong player gains about
10 percentage points of win rate from seeking, and with row scaling about 1
point, because a hard Daily Double at a large wager is close to a coin flip.
There is a checkbox for the flat model under the Explorer's controls, and the
default is the row-scaled one.

**Locks.** The equity table is coarse, and on a near-lock position it can
recommend a large wager where the right answer is the minimum. On one real
game (J-Archive 9501) the table said $12,633 from a $19,200 to $7,800 lead with
seven clues left; a direct rollout of the exact position said the minimum
wins 99.9% and $12,633 wins 94.8%. So before the table lookup the engine now
works out the most an opponent could still reach (every remaining clue, every
remaining Daily Double doubled, then Final Jeopardy doubled) and caps the
wager at the largest amount that keeps a guaranteed lead. Positions with no
such guarantee are unchanged.

## Running it locally

```
cd app
npm install
npm run dev
```

The app runs without the raw dataset, because the generated JSON files are
checked in. To rebuild those files, download the dataset linked below, extract
it into `data/`, and run:

```
npx tsx scripts/build-games.ts
npx tsx scripts/build-clue-stats.ts
```

### Local dev: J-Archive import

"Your game" can load a real game from J-Archive by ID (`app/api/jarchive.ts`),
but that route is a Vercel serverless function — `npm run dev` (plain Vite)
doesn't serve `/api` on its own. `app/vite.config.ts` proxies `/api` to
`http://localhost:3000`, so run the Vercel dev server alongside Vite:

```
npx vercel dev --listen 3000
npm run dev
```

Without `vercel dev` running, the Load button detects that it got Vite's HTML
shell back instead of JSON and shows a message pointing at the deployed site,
rather than failing silently — the import feature itself works fine on the
deployed app without any of this.

## Repository layout

- `app/src/sim/` holds the simulation engine. It has no dependencies and every
  function in it is pure, so it can run in a web worker or in a test.
- `app/src/components/` holds the React and D3 views.
- `scripts/` holds the data pipeline and the offline analysis tools.
- `PLAN.md` and `TASKS.md` record what was built and why.
- `BRAINSTORM.md` records the research the design came from.
- `archive/` holds the earlier prototypes and handoff notes. Nothing in the app
  or the scripts uses them.

## How this was built

I wrote this with Claude Code. The planning documents in `PLAN.md` and
`TASKS.md` are the actual working record, including the reviews that changed the
plan and the items that were deferred and why. `TODOS.md` lists the work that is
still open.

## References

These two papers are the source of the opponent models and the wagering theory.
They are not included in this repository. You can read them at the links below.

- Tesauro et al., "Analysis of Watson's Strategies for Playing Jeopardy!",
  Journal of Artificial Intelligence Research, 2012.
  https://www.jair.org/index.php/jair/article/view/10798
- Ferrucci et al., "Building Watson: An Overview of the DeepQA Project", AI
  Magazine, 2010. https://ojs.aaai.org/aimagazine/index.php/aimagazine/article/view/2303
- Jeopardy dataset for seasons 1 to 41.
  https://gist.github.com/Miopas/19d6d44b6c21b6b2ba868b13c30fb892
