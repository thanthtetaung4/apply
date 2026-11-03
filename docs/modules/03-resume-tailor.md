# Module 03: Resume Tailor

## Purpose
Produce a one-page, job-specific resume PDF from the user's real content.

## Flow
1. Extract requirements from the job description (skills, tools, seniority, keywords). Cheap model, structured output.
2. Score every experience bullet and project from `Profile` against those requirements.
3. Select and order content under a page budget.
4. Optionally rephrase bullets (model) within strict rules.
5. Run the grounding check.
6. Render HTML template with Puppeteer and export PDF.
7. Verify page count and fonts, save to `output/resumes/<jobId>.pdf`.

## Tailoring rules
- Select, reorder and lightly rephrase only. Never invent skills, tools, employers, titles, dates, metrics or projects.
- Every bullet in the output must map to a source bullet id from module 01.
- Skills section may only list skills that exist in the profile. Reordering by relevance is allowed.
- Summary line may be generated, but every claim in it must be supported by the profile.
- Keep the user's preferred job title for the target role only if it matches `titles.md`.

## Grounding check (fail closed)
- Reject any output bullet without a valid source id.
- Reject numbers, company names, tools or certifications not present in the source.
- On failure: retry once with the violations listed, then fall back to a deterministic selection with no rephrasing.

## Template
- `templates/resume.html` with CSS for a single page, Inter-based, uppercase section headers, justified summary.
- Template slots: header, summary, experience, projects, skills, education.
- Puppeteer: launch once per run, reuse the browser, `page.pdf()` with fixed margins.
- Post-check with `pdfinfo` equivalent (page count must be 1). If overflow, drop the lowest scored items and re-render.

## Interfaces
```
tailorResume(job: Job, profile: Profile): Promise<TailoredResume>
TailoredResume { pdfPath, selectedIds, summary, warnings }
```

## Model usage
- Requirement extraction: cheap model.
- Rephrasing and summary: stronger model, only when enabled by config.
- Cache by hash of (job description, profile version) to avoid repeat cost.

## Acceptance criteria
- Output is a valid single-page PDF.
- Grounding check blocks fabricated content in tests (include adversarial cases).
- Deterministic fallback works with no model call.
- Same job and profile hit the cache.

## Open items
- Reuse the existing styling from the user's current resume template.
- Decide whether ATS-friendly plain-text extraction should be tested per PDF.
