# Auto Apply

Finds jobs on Indeed, LinkedIn and Glassdoor, makes a tailored one page resume for each, fills the application in an isolated browser session (Greenhouse, Workday, company sites, board flows), verifies what was entered, and logs the result to your Job Search Board. Code drives the loop. A model is asked only for judgment.

Read `PRD.md` for the goals and `docs/IMPLEMENTATION_NOTES.md` for what is built and what is **not yet verified on real sites**.

## Try the demo (no real sites involved)

```bash
pnpm install
pnpm browsers:install        # downloads Chromium once. Or set CHROMIUM_PATH to an existing Chrome
pnpm demo
```

The demo starts fictional job boards and employer sites on localhost, uses a dummy resume (`demo/profile`), and runs the whole pipeline: intake, tailoring, applying, parking, recovery after a human step, shadow browser runs, and board logging over MCP to an in-process stand-in. Output goes to `demo-output/` (open `demo-output/report.html`).

## Use it for real

```bash
cp .env.example .env                      # PowerShell: Copy-Item .env.example .env
mkdir profile
cp demo/profile/*.md profile/             # then replace with your own content
pnpm cli profile:check                    # lists every problem in your files at once
pnpm cli intake --dry-run --source indeed # check that the board selectors still work
pnpm cli intake                           # queue jobs
pnpm cli run --limit 3                    # tailor and fill 3 jobs. Default policy stops before submit
pnpm cli park                             # what needs you, and why
pnpm cli report --html report.html
```

Start with `submit: review` everywhere (the default) and read the step screenshots in `output/applications/<jobId>/` before trusting any site type. `gate.enforce: true` keeps auto submit off until a site type has 10 verified runs.

Set `OPENROUTER_API_KEY` (and real model ids in `config/default.yaml`) to use a hosted model. Without a key an offline stand-in runs: it tailors resumes and fills forms from your profile and saved answers, but it never answers unknown questions, so those jobs are parked for you.

## Commands

```
config:check            profile:check [dir]      profile:match "<q>"      db:init
intake [--dry-run] [--source indeed|linkedin|glassdoor]
tailor                  run [--limit N]          status                   park
retry <jobId>           login <site> [url]       board:flush
report [--html file]    gate
```

## Profile files (`profile/`)

`resume.md`, `titles.md`, `projects.md` and optional `answers.md`. The format is in `docs/modules/01-profile-inputs.md` and `demo/profile/` is a complete example. Add a `## Question` heading with the answer below it to `answers.md` whenever `pnpm cli park` lists a question you want answered automatically next time.

## Job Search Board

Set `BOARD_MCP_URL` and `BOARD_MCP_TOKEN` in `.env`. The app uses `find_duplicate`, `create_application`, `update_application` and `log_activity`. If the board is unreachable, entries go to `data/board-log.jsonl` and a retry queue (`pnpm cli board:flush`). Applying never waits on the board.

## Project layout

```
config/default.yaml   settings, validated at startup
src/browser           browser interface, Playwright backend, registry
src/tailor            resume selection, grounding check, Puppeteer PDF
src/apply             field mapping, recipes, worker loop
src/verify            read-back comparison
src/queue             repo, orchestrator (worker pool, caps, fallback, shadow)
src/intake            board search, job parsing, classification, filters
src/board             Job Search Board loggers (MCP and file)
src/llm               gateway, OpenRouter client, offline stand-in
src/metrics           report and auto submit gate
src/demo              mock sites, mock board, demo runner
ai-browser/           future Rust browser, placeholder only
tests/                136 tests including full pipeline runs in real Chromium
```

## Requirements

Node 22.13 or newer, pnpm 10, and a Chromium or Chrome (`pnpm browsers:install` or `CHROMIUM_PATH`).
