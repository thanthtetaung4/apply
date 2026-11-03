# Implementation notes

What is built for each module, where it lives, and what has and has not been verified. Read this before trusting the tool on a real site.

## Verified in this repo

All of the following run in the test suite (136 tests) and in `pnpm demo`, against local fictional sites and a real Chromium:

- Browser layer: form schema extraction, filling every field type, uploads, wizards, iframes-free pages, cookie banners, storage state, lean mode.
- Resume tailoring: selection, grounding check (fails closed), one page PDF through Puppeteer.
- Apply engine: field mapping, answer bank, model fallback, read-back verification, submit policies, parking.
- Orchestrator: worker pool, caps, pacing, retry, fallback backend, shadow runs, metrics, gate.
- Job Search Board logging over MCP, against an in-process stand-in that follows the real tool names and argument shapes.

## NOT verified (needs your eyes)

| Area                                    | Why it is unverified                                                                                                                                                            | How to check                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Indeed, LinkedIn, Glassdoor pages  | Selectors in `config/default.yaml` are best guesses. Live sites were not reachable from the build environment, and they change often                                            | `pnpm cli intake --dry-run --source indeed`, then read what it found                                                                                       |
| Real Greenhouse, Workday, company forms | Recipes were tested on mock pages written for this repo. Real pages use custom widgets (React selects, date pickers, shadow DOM) the extractor may not read                     | Run on 3 to 5 real jobs with `submit: review` and read the step screenshots in `output/applications/<jobId>/`                                              |
| OpenRouter                              | The client is unit tested with a fake `fetch`. No live call was made. The default provider without an API key is an offline stand-in that never answers questions               | Set `OPENROUTER_API_KEY` and model ids in `config/default.yaml`, then run `pnpm cli run --limit 1`                                                         |
| Live board URL                          | `McpBoardLogger` is tested against an in-process server. The real `create_application` response shape was not observed (only `find_duplicate`, which returns `{"matches": []}`) | Set `BOARD_MCP_URL` and `BOARD_MCP_TOKEN`, run one job, and check the board. Failures go to `data/board-log.jsonl` and a retry queue, never block applying |
| `pnpm cli login`                        | Needs a visible browser window. Not run here                                                                                                                                    | Run `pnpm cli login workday <job url>` on your machine                                                                                                     |
| Windows                                 | Built and tested on Linux                                                                                                                                                       | `pnpm install`, `pnpm exec playwright-core install chromium`, `pnpm test`                                                                                  |

## Account safety

Boards (Indeed, LinkedIn, Glassdoor) can restrict accounts that automate. The defaults are conservative: `review` submit policy, daily caps of 10, random pauses between jobs, boards used mainly for discovery, and employer pages preferred over board flows. `gate.enforce: true` keeps `auto` switched off until a site type has 10 verified runs at 90 percent. Keep it on for real use.

## Per module

### 01 Profile inputs (`src/profile`)

Done in Phase 1. Markdown schema is in `docs/modules/01-profile-inputs.md`.

### 02 Job intake (`src/intake`)

- `parse.ts` reads schema.org `JobPosting` JSON-LD first, then falls back to page markup. Finds an employer apply link, an "Easy Apply" button, or a board apply link.
- `classify.ts` maps the apply URL to greenhouse, workday, company_site or board_native.
- `filter.ts` skips excluded titles, title mismatches, wrong locations. Match score is 60 percent title fit and 40 percent skill overlap.
- Duplicates are caught against saved jobs and within one run, across boards.
- Source adapters are configuration (`sources` in config), not code, so a changed site is a config edit.

### 03 Resume tailor (`src/tailor`, `templates/resume.html`)

- Requirements come from the model (or the offline stand-in) and are kept only if they appear in the description.
- Content is selected, never invented. Rewording is off by default (`rephrase`). When on, every rewrite must pass `checkRewrite`, otherwise the profile wording is used.
- Puppeteer renders the template through `puppeteer-core` using the Chromium that Playwright installs, so there is no second browser download.
- The least relevant item is dropped until the PDF is one page.
- The template uses Inter if installed, otherwise Segoe UI or Arial. Install Inter on your machine for the exact look.

### 04 Browser interface (`src/browser`)

- `types.ts` is the only API the app uses. `registry.ts` maps names to backends. `playwright-chromium` and `playwright-lean` are registered. `ai-browser` is a placeholder that refuses to launch, used to exercise fallback and shadow runs.
- Page side extraction is a plain string script (`extract-script.ts`) so a build tool cannot inject helpers into it.
- Known limits: closed shadow DOM, canvas based forms, drag and drop widgets, CAPTCHAs.

### 05 Queue, state, orchestrator (`src/queue`)

- Status machine, events, resumable runs, caps, pacing, retries, fallback, shadow runs. Rerunning never submits twice.
- A job is "started today" for cap purposes when it moves to `filling`.

### 06 Applier workers and recipes (`src/apply`)

- One schema driven worker loop for every site. Recipes hold only what differs: session keys, block detection, confirmation text, overlay buttons. Add a site by adding a recipe, not a new loop.
- Order inside a step: uploads, then other fields, then read back and retry once. This handles resume parsers that overwrite fields after upload (demonstrated by the Workday mock).
- Self identification questions are answered with the "decline" option when one exists.

### 07 Verifier and logger (`src/verify`, `src/board`)

- Verification compares read-back values with intended values, with normalisation for phone, URL, case and file names. A required mismatch parks the job.
- `record.json` per job lists every field, its value, where the value came from (rule, saved answer, model) and the step screenshots.
- Board logging: file logger (always available), MCP logger, and a fallback wrapper with a retry queue (`pnpm cli board:flush`).

### 08 LLM gateway (`src/llm`)

- Single entry point: cache, JSON validation with one retry, daily budget, usage rows. OpenRouter client retries 429 and 5xx with backoff and never echoes response bodies.
- Only the question, options and a short summary of your skills and roles are sent for form questions. Email and phone are never sent.

### 09 Config, CLI, metrics (`src/config`, `src/cli`, `src/metrics`)

- `pnpm cli report` and the HTML report show accuracy, completion, time, field sources, model usage and shadow differences by site type. `pnpm cli gate` shows which site types may auto submit.

## Decisions that differ from the first plan

- SQLite through `node:sqlite` (Node 22.13+), not better-sqlite3.
- Puppeteer is kept for resumes as asked, via `puppeteer-core`.
- Playwright is `playwright-core`. Install the browser with `pnpm browsers:install`.
- The Job Search Board is an MCP client over a URL, with a file fallback.
