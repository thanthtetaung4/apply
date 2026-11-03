# Build Plan

Follow phases in order. Each phase ends with a demo and acceptance checks. Do not start a phase until the previous one passes. Modules refer to `docs/modules/`.

## Status

All phases (0 to 12) are implemented as a proof of concept and covered by 136 passing tests plus a runnable demo (`pnpm demo`). Everything was exercised against local fictional sites and a real Chromium. See `docs/IMPLEMENTATION_NOTES.md` for what is built per module.

NOT yet verified: real Indeed, LinkedIn and Glassdoor pages (selectors are guesses), real Greenhouse and Workday DOMs, a live OpenRouter call, the live Job Search Board URL, `pnpm cli login` in a visible browser, and running on Windows. The gate that keeps auto submit off until a site type has proven itself is built, but it needs real runs to mean anything.

Next, in order:

1. Run `pnpm test` and `pnpm demo` on your Windows machine.
2. Fill `docs/baseline.md` so the token savings are measured.
3. `intake --dry-run` per board, fix selectors in config.
4. Run 3 to 5 real jobs per site type with `submit: review` and read the screenshots. Fix extractor gaps.
5. Set the board URL and an OpenRouter key and run one job each.
6. Only then consider `auto` for a site type, and only through the gate.

Decisions made along the way

- SQLite uses Node's built-in `node:sqlite` (Node 22.13+) instead of better-sqlite3, to avoid native builds on Windows.
- TypeScript is pinned to 5.9 until typescript-eslint supports TypeScript 7.
- The Job Search Board is an MCP client over a URL with a file fallback.
- Puppeteer renders resumes through `puppeteer-core` using Playwright's Chromium.

## Target repo layout

```
apply/
  PRD.md
  BUILD_PLAN.md
  docs/modules/*.md
  profile/            resume.md, titles.md, projects.md, answers.md   (user data, gitignored)
  templates/          resume.html
  config/             default.yaml
  src/
    profile/          module 01
    intake/           module 02 (sources/ adapters)
    tailor/           module 03
    browser/          module 04 (interface, registry, playwright backend)
    queue/            module 05
    apply/            module 06 (worker, recipes/)
    verify/           module 07 (verifier, board logger)
    llm/              module 08
    cli/              module 09
  tests/              unit, fixtures/ (saved HTML), e2e
  data/               sqlite, caches   (gitignored)
  output/             resumes, applications   (gitignored)
  sessions/           browser storage states   (gitignored)
  ai-browser/         future Rust browser, placeholder only
```

## Phase 0: Scaffold and baseline (0.5 to 1 day)

Tasks

- Init repo, pnpm, TypeScript strict, ESLint, Prettier, Vitest.
- Config loader with Zod (module 09), `.env` handling, `.gitignore` for user data.
- SQLite setup and migrations (module 05 tables).
- Measure baseline: tokens and time per application with the current Claude-in-Chrome workflow on 5 to 10 jobs. Record in `docs/baseline.md`.

Done when

- `pnpm test` and `pnpm lint` pass on an empty skeleton.
- Baseline numbers are written down.

## Phase 1: Profile inputs (module 01) (0.5 day)

Tasks

- Define markdown schema, write parsers, assign stable ids.
- Answer bank matcher.
- Add sample profile files under `tests/fixtures/profile/`.

Done when

- Real user files load into typed objects with clear errors for gaps.

## Phase 2: Browser interface and Playwright backend (module 04) (1 to 2 days)

Tasks

- Define `BrowserBackend`, `BrowserSession`, `FormSchema`, registry.
- Playwright backend: launch, context per job, storage state, lean mode.
- `formSchema` extraction with stable ids, fill helpers for text, select, radio, checkbox, textarea, file, custom dropdowns, iframes.
- Contract tests on local HTML fixtures. Fake backend for tests.

Done when

- Contract tests pass. Schema output is stable across reloads.

## Phase 3: Resume tailor (module 03) (1 to 2 days)

Tasks

- Port the existing HTML template to `templates/resume.html`.
- Requirement extraction, scoring, selection, page budget fitting.
- Grounding check with adversarial tests.
- Puppeteer PDF render with page-count check.
- LLM gateway minimal version (module 08) with cache and Zod output. Deterministic fallback with no model call.

Done when

- 10 real job descriptions produce valid one-page PDFs. Grounding tests block fabricated content.

## Phase 4: Queue, state and orchestrator (module 05) (1 day)

Tasks

- Status machine, events table, resumable runs, caps and delays.
- Worker pool skeleton using the fake backend.
- CLI: `status`, `retry`, `run`.

Done when

- Kill and restart produces no duplicates. `needs_human` does not block the queue.

## Phase 5: Greenhouse recipe end to end (module 06, 07) (2 days)

Tasks

- Save 10 to 15 real Greenhouse pages as fixtures.
- Recipe: plan, answer-bank mapping, model fallback for unmapped fields, resume upload.
- Verifier: read-back compare, required fields, upload check.
- Local-file `BoardLogger`.
- Run against live Greenhouse jobs in `review` mode.

Done when

- At least 90 percent field accuracy on fixtures. 10 live jobs reach the final step with a passing verification. Tokens per application are measured.

## Phase 6: Job Search Board over MCP (module 07) (0.5 to 1 day)

Tasks

- `BoardLogger` interface, `FileBoardLogger` (local JSONL) and `McpBoardLogger` using `@modelcontextprotocol/sdk` streamable HTTP client with `BOARD_MCP_URL` and `BOARD_MCP_TOKEN`.
- Use `find_duplicate` before `create_application`, `update_application` for stage changes, `log_activity` for notes.
- Retry queue for failed writes, fallback to the file logger when the board is unreachable.

Done when

- Status changes appear in the board without duplicates. Unplugging the board does not stop a run.

## Phase 7: Company-site generic recipe (module 06) (2 days)

Tasks

- Generic form detection, "Apply" modal handling, multi-step wizards.
- Block detection (login, CAPTCHA, error) and `needs_human` parking.

Done when

- Works on a sample of 15 company sites with correct parking behavior for the rest.

## Phase 8: Job intake (module 02) (2 to 3 days)

Tasks

- Source adapters for Indeed, LinkedIn, Glassdoor with fixtures.
- Apply URL resolution and `applyTarget` classification.
- Dedupe against local state and the board.
- `intake` CLI.

Done when

- Intake produces a deduped queue and routes jobs to recipes by target.

## Phase 9: Workday recipe (module 06) (2 to 3 days)

Tasks

- `apply login workday` session capture per tenant.
- Multi-step wizard handling, re-fill after resume parse prefill.
- Fixtures from 3 or more tenants.

Done when

- 5 live Workday applications reach the review step with passing verification.

## Phase 10: Board-native flows (module 06) (2 to 3 days)

Tasks

- Indeed Apply, LinkedIn Easy Apply, Glassdoor flows.
- Headed browsers, low caps, randomized pacing, `review` default.

Done when

- Each board completes a small supervised batch to the review step. Caps and delays are enforced.

## Phase 11: Metrics, shadow mode and toggle readiness (module 09, 04) (1 day)

Tasks

- `report` command with the PRD metrics.
- Shadow backend support: run second backend on same job without submitting, store field-level diffs.
- Per-site backend routing and fallback verified with the fake backend.

Done when

- Switching a site to another backend is a config change only. Reports compare backends.

## Phase 12: Hardening and auto-submit gates (1 to 2 days)

Tasks

- Retry and error taxonomy review, log redaction check, secrets audit.
- Review accuracy by site and enable `auto` only where the bar is met.
- README with setup and daily workflow.

Done when

- A full daily run completes with a report. `auto` is enabled only for sites that met 90 percent accuracy.

## Later (not in this plan)

- `ai-browser/` Rust implementation. Starts only after Phase 12 and after metrics show the browser is a real bottleneck.
- Cover letters, email sync, interview prep.

## Order of risk

1. Board integration approach (Phase 6) and Workday (Phase 9) are the biggest unknowns.
2. Account safety on boards (Phase 10). Keep conservative defaults.
3. Model cost. The budget guard in module 08 is built in Phase 3 so it exists before volume.

## Working agreement with Claude Code

- One module per session. Read the module doc and this plan first.
- Write tests and fixtures before the recipe or adapter that uses them.
- Keep PRs small. Update the module doc if the design changes.
