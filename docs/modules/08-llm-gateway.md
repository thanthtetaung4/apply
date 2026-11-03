# Module 08: LLM Gateway (OpenRouter)

## Purpose
Single entry point for every model call, with routing, structured output, caching and cost tracking.

## Tasks and model tiers
| Task | Tier | Notes |
|---|---|---|
| Job requirement extraction | cheap | structured JSON |
| Fit scoring (optional) | cheap | only for borderline jobs |
| Unmapped form field answers | cheap | small context: field schema + job summary + profile facts |
| Screening question answers (free text) | mid | uses answer bank and projects as grounding |
| Resume rephrasing and summary | strong | only if enabled, grounded |

Model names live in config, not code. Decide the actual models after the Phase 1 baseline.

## Requirements
- OpenRouter HTTP client with timeouts, retries and backoff.
- Every call declares a Zod schema. Invalid output is retried once, then fails closed.
- Prompt templates in `src/llm/prompts/`, versioned.
- Cache by hash of (task, prompt version, inputs). SQLite table.
- Token and cost accounting per job and per task, written to `applications` and `events`.
- Redaction: strip secrets and unneeded personal fields from prompts. Only send what the task needs.
- Budget guard: stop the run when a configured daily cost cap is reached.

## Grounding
Answers about the user (experience, projects, skills) must come only from supplied profile content. Prompts instruct the model to answer "UNKNOWN" when the profile does not support an answer, and the caller treats UNKNOWN as `needs_human`.

## Acceptance criteria
- All model calls pass through the gateway (lint rule or test that forbids direct fetch to the provider elsewhere).
- Cache hit avoids a network call.
- Cost totals match per-call usage.
- Invalid structured output never reaches callers.
