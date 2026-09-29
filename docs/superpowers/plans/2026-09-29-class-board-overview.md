# Class board: build plan at a glance

A shared board for one class of up to 75 people:
- 80 tiles, 8 rows by 10 columns.
- Students post a link or an HTML file (for example a Claude artifact), with their name above it.
- Tiles run live when the site allows embedding, and show a screenshot otherwise.
- Everyone's personalized cursor is visible in real time.
- Zooming far into a tile opens it full page, with a Back button.
- It runs free: the site is on GitHub Pages, and the live and stored parts run on a Cloudflare
  Worker on the free plan.

## How it gets built: 5 stages, about 1–2 hours

The plan already contains the complete code and tests for all 152 files. So instead of 41
agents retyping code across 7 waves, a script writes everything in one step, the tests run once,
and agents are sent only to what fails.

| Stage | What happens | Who does it | Model / effort | Time |
|---|---|---|---|---|
| 1. Write | A script writes all 152 files; packages and Chromium get installed | Script | none | ~10 min |
| 2. Check | Type check and every unit test, across all four packages | Script | none | ~3 min |
| 3. Fix | One agent per failing area, all in parallel; up to 3 rounds | Agents | Sonnet low to Opus medium, by area | 15–45 min |
| 4. End-to-end | Browser tests (two users, posting, uploads, focus mode, teacher lock), then a manual check with a screenshot | 1 agent + me | Opus / medium | 20–40 min |
| 5. Review | One final pass over the whole repo against the spec | 1 agent | Opus / high | ~15 min |

Fix agents get the model and effort their area needs. An area that's still failing after a round
moves up one step. Fable is never used.

| Area | Model / effort |
|---|---|
| Shared helpers | Sonnet / low |
| Small server modules, web core, dialogs and cursors | Sonnet / medium |
| Server core, pan/zoom/live tiles/focus mode/page wiring, end-to-end tests | Opus / medium |

## What changed from the first version of the plan

| | Before | Now |
|---|---|---|
| Rounds of work | 7 waves, one after another | 5 stages |
| Agents | 41 task agents, plus a fix-up agent at each wave | Only for failing areas (often 3–6), plus e2e and review |
| Writing code | Each agent retyped its code from the plan | A script writes it exactly, in about a minute |
| Tests | Each run twice (fail first, then pass) | Each run once, against the finished code |
| Estimated time | 4–6 hours | 1–2 hours |

## What you'll need to do (only at the end)

1. Create a free Cloudflare account, then run `npx wrangler login` and set the teacher passcode.
2. Deploy the Worker (one command).
3. Create the GitHub repo `Jacobl-h/class-board` and turn on Pages. I'll ask before creating
   it or pushing anything.
4. Before class, open the board once on the school network to check it isn't blocked.

## Decisions worth knowing

- Tiles only run live when they're on screen and zoomed in enough (at most 12 at once), so 80
  embedded pages don't overload a laptop.
- Uploaded HTML runs in a strict sandbox. It can't touch the board or anyone's data.
- If no teacher passcode is set, nobody can unlock teacher mode.
- Focus mode is full page within the site (not the browser's full screen), and it never opens
  an empty tile.
- Names above tiles grow as you zoom out, so they stay readable on the overview.
- Cursors slow down at 80% of the free daily message allowance and pause at 90%, so posting
  keeps working all day.

## Where the details are

- `2026-09-29-class-board.md`: the master plan. §1 is how to run the build; §3–§6 are the fixed
  interfaces between parts; §11 lists every decision.
- `2026-09-29-class-board/01…08-*.md`: the complete code and tests, by part.
- `2026-09-29-class-board/materialize.mjs`: the script that writes the code.
- `../specs/2026-09-29-class-board-design.md`: the approved design.
