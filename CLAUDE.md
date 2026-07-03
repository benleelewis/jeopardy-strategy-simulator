# Jeopardy Strategy Simulator

## Orientation
- Read `TASKS.md` for current progress and what's been completed vs remaining
- Read `BRAINSTORM.md` for research insights, key numbers from Tesauro 2012, strategies worth testing, and Bret Victor design ideas
- The app lives in `app/` (React + Vite + TypeScript)
- Sim engine: `app/src/sim/sim-engine.ts` — core Monte Carlo simulation
- Tests: `app/src/sim/sim-engine.test.ts` — run with `npm test` from `app/`
- On Windows, npm requires: `export PATH="$PATH:/c/Program Files/nodejs:/c/Users/Ben Lewis/AppData/Roaming/npm"`

## Key Decisions (from CEO review)
- 2-axis model: Knowledge (b×p) × Buzzer Speed → Win Rate
- Opponent models from Tesauro 2012: Average / Champion / Grand Champion
- Static dataset from recent Jeopardy scorecards + single-URL J-Archive fetch (never bulk-scrape)
- Adaptive grid resolution with Gaussian smoothing to reduce Monte Carlo noise
- Deploy to Vercel

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

# gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
- `/office-hours` — Collaborative working session
- `/plan-ceo-review` — CEO-level plan review
- `/plan-eng-review` — Engineering plan review
- `/plan-design-review` — Design plan review
- `/design-consultation` — Design consultation
- `/review` — Code review
- `/ship` — Ship a feature
- `/browse` — Web browsing (use this for all web browsing)
- `/qa` — QA testing
- `/qa-only` — QA only (no code changes)
- `/design-review` — Design review
- `/setup-browser-cookies` — Set up browser cookies
- `/retro` — Retrospective
- `/investigate` — Investigate an issue
- `/document-release` — Document a release
- `/codex` — Codex skill
- `/careful` — Careful mode
- `/freeze` — Freeze the codebase
- `/guard` — Guard mode
- `/unfreeze` — Unfreeze the codebase
- `/gstack-upgrade` — Upgrade gstack
