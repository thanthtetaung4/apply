# Module 09: Config, CLI and Metrics

## Config (`config/default.yaml`, Zod validated, env overrides)
```yaml
profileDir: ./profile
dataDir: ./data
outputDir: ./output
workers: 2
llm:
  provider: openrouter
  models: { cheap: "...", mid: "...", strong: "..." }
  dailyBudgetUsd: 2
sites:
  greenhouse:  { backend: playwright-chromium, submit: review, dailyCap: 30, headless: true }
  company_site:{ backend: playwright-chromium, submit: review, dailyCap: 20, headless: true }
  workday:     { backend: playwright-chromium, submit: review, dailyCap: 10, headless: false }
  indeed:      { backend: playwright-chromium, submit: review, dailyCap: 10, headless: false }
  linkedin:    { backend: playwright-chromium, submit: review, dailyCap: 10, headless: false }
  glassdoor:   { backend: playwright-chromium, submit: review, dailyCap: 10, headless: false }
board:
  type: mcp            # URL comes from BOARD_MCP_URL, token from BOARD_MCP_TOKEN
  tokenEnv: BOARD_MCP_TOKEN
backends:
  shadow: { enabled: false, name: ai-browser, sample: 0.2 }
```
Secrets (OpenRouter key) come from environment variables or a local `.env`, never committed.

## CLI
- `apply intake` fetch and enqueue jobs
- `apply tailor [--job id]` generate resumes for queued jobs
- `apply run` process ready jobs with the worker pool
- `apply status` counts by status and site, needs-human reasons
- `apply retry <jobId>`
- `apply login <site>` open a headed browser to sign in and save the session
- `apply report` metrics summary

Phase 0 and 1 CLI (implemented): `config:check`, `profile:check [dir]`, `profile:match "<question>"`, `db:init`. Run with `pnpm cli <command>`.

## Metrics (for baseline and A/B)
Per application: backend, site type, duration, tokens in and out, cost, fields total, fields filled by rule, by answer bank, by model, verification result, final status.

Reports:
- Accuracy and completion by site type and backend
- Tokens and cost per application
- Needs-human reasons ranked
- Shadow backend vs primary field-level diffs

## Baseline (Phase 1)
Record tokens and time for the current Claude-in-Chrome workflow on a sample of jobs so the savings target is measured, not assumed.

## Acceptance criteria
- Invalid config fails at startup with a clear message.
- Switching a site's backend requires only a config change.
- `report` reproduces the numbers in the PRD success metrics.
