# Module 07: Verifier and Logger

## Purpose
Prove that what was filled matches what was intended, keep an audit trail, and record outcomes in the Job Search Board.

## Verification (before submit)
- Read back all field values with `session.readValues()`.
- Compare to the intended `FillPlan`: exact match for text, normalized match for dates and phone numbers, option match for selects.
- Check required fields are non-empty and no validation errors are visible.
- Confirm the uploaded file name equals the tailored resume file.
- Take a final-step screenshot for the audit record only. The screenshot is not used to decide.
- Result: `pass`, `warn` (non-required mismatch), or `fail`. `fail` blocks submit.

## Submission confirmation (after submit)
- Look for a confirmation page, success text or URL change defined per recipe.
- Save the confirmation text and screenshot.
- If unconfirmed, mark `submitted_unconfirmed` and surface it in `status`.

## Audit record (per job)
`output/applications/<jobId>/record.json`
- job, recipe, backend, timings
- intended values vs read-back values
- fields answered by rules, answer bank, or model (with model name)
- tokens and cost
- screenshots, resume path, confirmation

Secrets and passwords are never written.

## Job Search Board logging
- On status changes (`submitted`, `needs_human`, `failed`) write to the Job Search Board.
- Check for duplicates before creating an entry.
- Store: company, role, link, source, date, stage, resume used, notes (failures and reasons).

### Integration approach (decided)
The app is an MCP client of the board's MCP server.
- Connection: streamable HTTP MCP client (official `@modelcontextprotocol/sdk`) to `BOARD_MCP_URL`, bearer token from the env var named in `board.tokenEnv` (default `BOARD_MCP_TOKEN`).
- Tools used: `find_duplicate` (before create), `create_application`, `update_application` (stage changes log a timeline activity automatically), `log_activity` (notes such as failure reasons), `list_applications` (intake dedupe).
- The board never sends email. This app never sends email or messages either.
- Implement behind a `BoardLogger` interface with two implementations: `McpBoardLogger` (real) and `FileBoardLogger` (local JSONL, used when the board is unreachable or `BOARD_MCP_URL` is unset). Failed board writes are queued locally and retried, and never block applying.
- Dates are YYYY-MM-DD in Singapore time (UTC+8).

## Acceptance criteria
- Fail verification blocks submission in tests.
- Every processed job has a complete record file.
- Logger is idempotent: reprocessing never creates duplicate board entries.
- Local-file logger works with no network.
