# Module 02: Job Intake

## Purpose
Fetch jobs from the boards, normalize them, classify the apply target, dedupe, and enqueue.

## Sources
- Indeed
- LinkedIn
- Glassdoor

Boards are used mainly for discovery. When a job links out to an employer page, the apply target is that page, which avoids most board account risk.

## Job record (normalized)
```
Job {
  id            // hash of source + source job id
  source        // indeed | linkedin | glassdoor
  title, company, location
  description   // full text
  sourceUrl
  applyUrl      // resolved employer or board URL
  applyTarget   // board_native | greenhouse | workday | company_site
  postedAt, fetchedAt
}
```

## Classification rules (applyTarget)
- URL host contains `greenhouse.io` or `boards.greenhouse.io`: `greenhouse`
- URL host contains `myworkdayjobs.com` or `workday`: `workday`
- Apply stays on the board (Easy Apply, Indeed Apply, Glassdoor apply): `board_native`
- Anything else: `company_site`

## Responsibilities
- Search per preferred title and location from `titles.md`.
- Resolve the real apply URL (follow redirects, read "Apply on company site" links).
- Filter: exclusions, duplicates, already applied, stale postings.
- Score fit (keyword overlap first, optional cheap model pass) and drop low-fit jobs.
- Dedupe by (company, normalized title, location) and by URL, against local state and the Job Search Board.
- Enqueue with status `queued`.

## Implementation notes
- Intake uses the same `BrowserSession` interface (module 04) for pages that need rendering.
- Prefer lightweight HTTP and structured data where a source allows it, and fall back to the browser.
- Rate limits and randomized delays per source.
- Each source is an adapter implementing `JobSource { search(prefs): AsyncIterable<RawJob> }`.

## Acceptance criteria
- For a given titles file, returns normalized, deduped jobs from each source adapter.
- applyTarget classification covered by unit tests on sample URLs.
- Re-running intake does not create duplicates.
- Adapter failures are isolated and logged, other sources continue.

## Risks
- Board markup changes break adapters: keep fixtures and make adapters small.
- Board terms of service: keep volume low, no account actions beyond reading listings in intake.
