# Baseline: current Claude-in-Chrome workflow

Purpose: measure what one application costs today, so the savings target in the PRD (at least 70 percent fewer tokens per application) is measured and not assumed.

Status: not yet measured. Fill this in before Phase 5.

## How to measure

1. Pick 8 to 10 jobs across the site types (2 Greenhouse, 2 company sites, 2 Workday, 2 from Indeed, LinkedIn or Glassdoor).
2. Run each in its own fresh session so context does not carry over. Same prompt and skills you use today.
3. After each run, note the session usage. Options: the usage meter percentage before and after, or run the `explain-usage` skill for a token breakdown.
4. Record wall-clock time and whether the application reached the final step, was submitted, or got stuck.

## Results

| #   | Site type                     | Job | Usage before | Usage after | Tokens (or % of session) | Minutes | Outcome | Notes |
| --- | ----------------------------- | --- | ------------ | ----------- | ------------------------ | ------- | ------- | ----- |
| 1   | greenhouse                    |     |              |             |                          |         |         |       |
| 2   | greenhouse                    |     |              |             |                          |         |         |       |
| 3   | company_site                  |     |              |             |                          |         |         |       |
| 4   | company_site                  |     |              |             |                          |         |         |       |
| 5   | workday                       |     |              |             |                          |         |         |       |
| 6   | workday                       |     |              |             |                          |         |         |       |
| 7   | indeed / linkedin / glassdoor |     |              |             |                          |         |         |       |
| 8   | indeed / linkedin / glassdoor |     |              |             |                          |         |         |       |

## Summary (fill in after the runs)

- Median tokens per application, by site type:
- Median minutes per application, by site type:
- Share of runs that needed manual help:
- Target for the new app (70 percent lower):

## Questions to answer from the data

- Which site type costs the most, and why (screenshots, long forms, retries)?
- How much of the cost is tailoring versus form filling?
- Where does the run get stuck most often?

The same fields are what `apply report` will produce from Phase 11 on, so the comparison stays like for like.

## What the new app reports (for the comparison)

`pnpm cli report` prints, per site type: runs, submitted, review, needs human, verify pass rate, average time, field sources (rule, saved answer, model) and model tokens and cost. With a hosted model configured, tokens per application are in the model usage line. Without one (offline stand-in) tokens are zero by design, so run the comparison with a real model.
