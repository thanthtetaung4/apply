# Module 06: Applier Workers and Site Recipes

## Purpose
Given a ready job and a resume PDF, drive the application to the final step using the right recipe for the site.

## Worker loop
```
open applyUrl
loop:
  schema = session.formSchema()
  plan   = recipe.plan(schema, profile, answerBank, job)      // rules first
  unknown = plan.unmapped required fields
  if unknown: model.answer(unknown, context)                  // module 08, cheap model
  apply plan via session.fill / upload / click
  result = session.next()
  if final step: break
  if blocked (login, CAPTCHA, unknown): park as needs_human
verify (module 07)
submit according to site policy
```
The loop is code. The model never decides navigation, only answers specific unmapped questions.

## Field mapping order
1. Exact label or name rules per recipe (name, email, phone, links, location).
2. Answer bank match from `answers.md`.
3. Cheap model for remaining fields, given the field schema, the job, and the profile. Output validated with Zod. Answers are saved to `answers_seen` for review.
4. If still unresolved and required: `needs_human`.

## Submit policy (config per site type)
- `auto`: submit after verification passes.
- `review`: stop at the final step, save screenshot, mark `ready_to_submit` for manual click.
- `manual`: do not open the form, only log the link.

Defaults for v1: Greenhouse and company sites `review` until the accuracy bar is met, then `auto`. Workday `review`. Indeed, LinkedIn, Glassdoor `review`.

## Recipes

### Greenhouse
- No login needed. Single page form, standard fields, resume upload, custom questions, optional EEO section.
- First recipe to build. Used as the reference implementation.

### Company site (generic)
- Rule-based detection of form fields from `formSchema`.
- Handles common patterns: single page forms, "Apply" modal, multi-step wizards.
- Falls back to `needs_human` when a required field cannot be mapped.

### Workday
- Tenant-specific accounts. v1: user creates the account once per tenant, the session is stored under `sessions/workday/<tenant>`.
- Multi-step wizard: My Information, My Experience, Application Questions, Voluntary Disclosures, Review.
- Resume parsing prefill may overwrite fields, so values are re-filled and verified after upload.
- Expect the longest run time and the most `needs_human`.

### Indeed
- Indeed Apply flow and external redirect handling. Prefer the employer's apply page when available.
- Stored session, headed browser by default, low daily cap.

### LinkedIn
- Easy Apply modal steps and external "Apply" links. Prefer external links.
- Stored session, headed browser by default, low daily cap, default `review`.

### Glassdoor
- External redirect handling mostly. Stored session, low daily cap.

## Recipe interface
```ts
interface Recipe {
  matches(job: Job, url: string): boolean
  prepare(session: BrowserSession): Promise<void>        // cookie banners, login check
  plan(schema: FormSchema, ctx: ApplyContext): FillPlan
  isFinalStep(snapshot: PageSnapshot): boolean
  detectBlock(snapshot: PageSnapshot): Block | null     // login, captcha, error
}
```

## Acceptance criteria
- Greenhouse fixtures: at least 90 percent field accuracy.
- Block detection parks jobs instead of looping.
- Recipes have fixture tests built from saved real pages.
- No recipe contains model calls directly. All go through module 08.

## Risks
- Account restrictions on boards: low caps, `review` default, prefer employer pages.
- Anti-bot challenges: do not attempt to bypass, park instead.
