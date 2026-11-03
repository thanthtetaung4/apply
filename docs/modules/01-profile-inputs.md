# Module 01: Profile Inputs

## Purpose
Load and validate the user's markdown data once, and expose it as typed objects to every other module.

## Inputs (under `profile/`)
- `resume.md`: experience, education, skills, certifications
- `titles.md`: preferred job titles, keywords, locations, exclusions
- `projects.md`: project list with stack, outcomes, links
- `answers.md`: answer bank for screening questions

## Markdown schema (as implemented)
Sample files live in `tests/fixtures/profile/`. Copy them to `profile/` and replace the content.

`resume.md`: top-level `#` sections.
- `# Profile` with `Name:`, `Email:` (required), `Phone:`, `Location:`
- `# Links` with `- Label: url`
- `# Summary` free text
- `# Experience` with `## Company | Role | Start - End` then bullets (required)
- `# Education` with `## Institution | Degree | Start - End` then optional bullets
- `# Skills` with `- Category: a, b, c` (required)
- `# Certifications` with bullets (optional)

`titles.md`: `# Titles` (required, one per bullet), `# Keywords`, `# Locations`, `# Exclude`.

`projects.md`: one `## Project Name` per project with `Stack:` (required), optional `Link:`, `Role:`, `Period:`, a short description, and bullet highlights.

`answers.md`: each `## Question | alternate wording | another` heading is a set of patterns, the text below it is the answer. The file is optional.

## Outputs (TypeScript types, Zod validated)
- `Profile` (name, contact, links)
- `Experience[]`, `Education[]`, `SkillGroup[]`
- `Project[]` with stable ids
- `TitlePrefs` (titles, keywords, locations, exclusions)
- `AnswerBank` (pattern to answer, matcher)

## Responsibilities
- Parse markdown into typed structures.
- Assign stable ids to every experience bullet and project so tailoring can reference them and the grounding check can verify them.
- Validate required fields, fail with a clear message listing what is missing.
- Provide an `AnswerBank.match(questionText)` that returns an answer or null (fuzzy match, then optional model fallback in module 08).

## Answer matching rules (as implemented)
- Exact match after normalization scores 1.
- Otherwise a pattern matches when at least 75 percent of its words (stop words removed, words cut to 6 letters so "authorized" and "authorization" agree) appear in the question. The threshold is a parameter.
- A one-word pattern only matches short questions (it must make up at least half of the question's words). This stops "Website" from answering any long question that mentions a website.
- Caution: keyword matching cannot tell a statement from a yes/no threshold question. Write answers that stay true for common phrasings, and expect the model or `needs_human` to handle threshold questions such as "notice period of 3 months or more?".

## Non-responsibilities
- No network calls.
- No tailoring logic.

## Acceptance criteria
- Loading valid files returns typed data with ids.
- Missing or malformed sections produce actionable errors.
- Same input always produces the same ids (hash of normalized content).
- Unit tests cover parsing and matching.

## Open items
- Confirm the schema against the user's real files (run `pnpm cli profile:check`). Adjust parsers or files where they differ.
