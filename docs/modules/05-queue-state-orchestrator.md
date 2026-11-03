# Module 05: Queue, State and Orchestrator

## Purpose
Track every job's lifecycle, schedule work across workers, and make runs resumable and idempotent.

## State store
SQLite through Node's built-in `node:sqlite` at `data/apply.db` (Node 22.13+, no native build).

Tables (sketch):
- `jobs` (id, source, title, company, location, applyUrl, applyTarget, description, fetchedAt)
- `applications` (jobId, status, attempts, resumePath, startedAt, finishedAt, error, backend, tokensIn, tokensOut, costUsd)
- `events` (jobId, ts, type, payload) for an audit trail
- `answers_seen` (question, answer, source) for new screening questions to review

## Status machine
```
queued -> tailoring -> ready -> filling -> verifying -> submitted
                                   |            |
                                   v            v
                              needs_human     failed
                                   |
                                   v
                               (manual resume) -> filling
skipped (filtered or duplicate)
```
- `needs_human`: login wall, CAPTCHA, unknown required question, ambiguous field.
- `failed`: unrecoverable error after retries.

## Orchestrator
- Pulls `queued` jobs, runs tailoring in a batch first (cheap, no browser), then dispatches `ready` jobs to workers.
- Worker pool size N (default 2). One job per worker at a time. Fresh context per job.
- Per-site concurrency and daily caps. Randomized delay between jobs on the same site.
- Retries with backoff for transient errors, no retry for `needs_human`.
- Idempotency: a job already `submitted` is never processed again. A crash mid-run resumes from the last durable status.
- Graceful shutdown on SIGINT: finish or park the current job.

## CLI hooks
`status` prints counts by status and site. `retry <jobId>` re-queues. `park` lists `needs_human` with reasons.

## Acceptance criteria
- Killing the process mid-run and restarting does not duplicate submissions.
- Caps and delays are enforced per site.
- A `needs_human` job never blocks the rest of the queue.
- Events table reconstructs what happened for any job.
