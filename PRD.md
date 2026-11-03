# Auto Apply: Product Requirements Document

Status: Draft v1. Proof of concept implemented, see BUILD_PLAN.md and docs/IMPLEMENTATION_NOTES.md
Owner: Thant Htet Aung
Date: 2026-11-03

## 1. Summary

Auto Apply is a TypeScript application that takes a list of fetched jobs, tailors a resume for each one, opens the application in an isolated browser session, fills the form, verifies the result, and logs the outcome. It replaces the current Claude-in-Chrome workflow, which spends 50 to 60 percent of a session's tokens per run because the model drives every click.

The core design change: code drives the loop and the model is called only for judgment (tailoring wording, unknown screening questions). The browser sits behind an interface so the engine can be swapped later.

## 2. Goals

1. Apply to jobs from Indeed, LinkedIn, Glassdoor, Workday, Greenhouse and company websites.
2. Tailor a resume per job from the user's real content.
3. Cut tokens and time per application compared with the current Chrome workflow.
4. Keep every application auditable (what was filled, what was submitted, why it failed).
5. Keep the browser behind an interface so an agent-native browser (see `ai-browser/`) can replace Chromium later through a toggle and A/B testing.

## 3. Non-goals (v1)

- Building the agent-native browser. Only a placeholder folder exists (`ai-browser/`).
- Creating accounts on job sites automatically (except where noted for Workday, which is a manual step in v1).
- Bypassing CAPTCHAs or bot detection.
- Cover letter generation (possible later module).
- Outreach messages or networking automation.

## 4. Users and inputs

Single user: Thant. Assumed inputs, all in markdown under `profile/`:

| File          | Purpose                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `resume.md`   | Source of truth for experience, education, skills                                                        |
| `titles.md`   | Preferred job titles and search keywords                                                                 |
| `projects.md` | Project list with stack, outcomes, links                                                                 |
| `answers.md`  | Answer bank for common screening questions (work authorization, notice period, salary expectation, etc.) |

`answers.md` is added because screening questions are the main blocker for unattended applying. See module 01.

## 5. Functional requirements

### 5.1 Job intake

- FR-1: Fetch jobs for each preferred title from Indeed, LinkedIn and Glassdoor.
- FR-2: Classify each job's apply target: board-native flow, Greenhouse, Workday, or other company site.
- FR-3: Dedupe against previously processed jobs (local state and the Job Search Board).
- FR-4: Score or filter jobs against preferred titles and location rules.

### 5.2 Resume tailoring

- FR-5: Given a job description, select and order resume content and projects that best match.
- FR-6: Render a one-page PDF from an HTML template using Puppeteer.
- FR-7: Never invent skills, employers, dates, titles or projects. Output must pass a grounding check against the markdown inputs.

### 5.3 Application

- FR-8: Run one isolated browser context per job.
- FR-9: Support site recipes for Greenhouse, Workday, Indeed, LinkedIn, Glassdoor and a generic recipe for company sites.
- FR-10: Fill fields from profile data and the answer bank. Call the model only for unknown questions.
- FR-11: Upload the tailored resume PDF.
- FR-12: Apply a per-site submit policy: `auto`, `review` (stop before final submit) or `manual`.
- FR-13: Park jobs that hit a login wall, CAPTCHA or unknown required question as `needs_human` and continue the queue.

### 5.4 Verification and logging

- FR-14: Read back filled values from the page and compare with expected values.
- FR-15: Save a final-step screenshot and a JSON record per job.
- FR-16: Log each application and status change to the Job Search Board through its MCP server (the app is an MCP client of the board URL).

### 5.5 Operations

- FR-17: Run a pool of N workers (default 2).
- FR-18: Resume interrupted runs without reapplying to completed jobs.
- FR-19: Provide a CLI: `intake`, `tailor`, `apply`, `status`, `retry`.
- FR-20: Select the browser backend per site type through config (the toggle).

## 6. Non-functional requirements

- Token budget: target at least 70 percent fewer tokens per application than the current Chrome workflow (to be measured in Phase 1 baseline).
- Reliability: at least 90 percent field accuracy on Greenhouse and Lever style forms before enabling `auto` submit.
- Safety: no secrets in logs, credentials only in a local session store.
- Pace: randomized delays and per-site daily caps to reduce account risk on job boards.
- Portability: runs on Windows (user's machine) and Linux.

## 7. Architecture

```
profile/*.md
     |
     v
[Profile Loader] -----> [Resume Tailor] --PDF--+
                                               |
[Job Intake] --> [Queue + State (SQLite)] --> [Worker Pool]
 Indeed/LinkedIn/Glassdoor                        |
                                                  v
                                        [Site Recipe Engine]
                                                  |
                                       [BrowserSession interface]
                                          |                |
                                 Playwright+Chromium    ai-browser (future)
                                                  |
                                           [Verifier] --> [Logger] --> Job Search Board
```

Modules (each has a doc in `docs/modules/`):

1. 01 Profile Inputs
2. 02 Job Intake
3. 03 Resume Tailor
4. 04 Browser Interface
5. 05 Queue, State and Orchestrator
6. 06 Applier Workers and Site Recipes
7. 07 Verifier and Logger
8. 08 LLM Gateway (OpenRouter)
9. 09 Config, CLI and Metrics

## 8. Tech stack

- Language: TypeScript on Node 20+
- Browser control: Playwright with Chromium (apply), Puppeteer (resume PDF from HTML template)
- LLM: OpenRouter API, model routing by task (cheap model for field mapping, stronger for tailoring)
- Validation: Zod for all structured model output and config
- State: SQLite through Node's built-in `node:sqlite` (Node 22.13+, no native build step)
- Tests: Vitest, plus recorded HTML fixtures of real application pages
- Package manager: pnpm

## 9. Browser toggle and A/B plan

- All application code talks to `BrowserSession` only (module 04).
- Backends register by name (`playwright-chromium` now, `ai-browser` later).
- Config maps site type to backend. Shadow mode runs a second backend on the same job without submitting and records field-level differences.
- Promotion rule: a backend is promoted for a site type when it meets the accuracy bar and beats Chromium on tokens or time over a fixed sample.
- `ai-browser/` holds the Rust project later. Nothing is implemented now.

## 10. Success metrics

| Metric                                    | Target                                     |
| ----------------------------------------- | ------------------------------------------ |
| Tokens per application                    | At least 70 percent below baseline         |
| Fill accuracy (Greenhouse, company sites) | 90 percent or better before `auto`         |
| Completed applications per day            | Set after baseline                         |
| Needs-human rate                          | Under 25 percent after answer bank matures |
| Resume grounding failures                 | 0 shipped                                  |

## 11. Risks

| Risk                                                | Mitigation                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Account restrictions on LinkedIn, Indeed, Glassdoor | Default `review` policy, daily caps, discovery-first use of boards, apply on the employer's own page where possible |
| Workday per-tenant accounts                         | Manual account creation in v1, session reuse per tenant                                                             |
| Model misfills forms                                | Deterministic recipes first, DOM read-back verification, accuracy bar before `auto`                                 |
| Tailoring fabricates content                        | Grounding check, prompt rules, fail closed                                                                          |
| Site layout changes                                 | Fixture tests, graceful fallback to model-assisted fill, `needs_human`                                              |
| Board MCP server unreachable or auth fails mid-run  | Local-file fallback logger, retry later, never block applying                                                       |

## 12. Open questions

1. RESOLVED: the app connects to the Job Search Board as an MCP client using a URL (`BOARD_MCP_URL`) and a token (`BOARD_MCP_TOKEN`). See module 07.
2. Which OpenRouter models for each task? Decide after the Phase 1 baseline.
3. Auto-submit policy per site: confirm after the first 20 verified runs.
4. Does the generic company-site recipe need its own LLM-driven mode in v1 or only rule-based fill plus `needs_human`?

## 13. Out of scope for now

`ai-browser/` implementation, cover letters, interview scheduling, email parsing (existing `update-job-board` skill covers email sync).
