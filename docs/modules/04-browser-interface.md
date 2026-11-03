# Module 04: Browser Interface

## Purpose
Isolate the rest of the app from any specific browser engine so the engine can be swapped by config. This is what makes the future toggle and A/B testing possible.

## Interface sketch
```ts
interface BrowserBackend {
  name: string                         // "playwright-chromium" | "ai-browser"
  launch(opts: LaunchOpts): Promise<BrowserSession>
}

interface BrowserSession {
  open(url: string): Promise<void>
  snapshot(): Promise<PageSnapshot>    // compact, text based, no screenshots
  formSchema(): Promise<FormSchema>    // fields, labels, types, required, options, current values
  fill(fieldId: string, value: string | string[] | boolean): Promise<void>
  click(targetId: string): Promise<void>
  upload(fieldId: string, filePath: string): Promise<void>
  next(): Promise<StepResult>          // advance to next step if present
  readValues(): Promise<Record<string, unknown>>   // for verification
  screenshot(): Promise<Buffer>        // verification and audit only
  saveState(): Promise<StorageState>   // cookies and storage for reuse
  close(): Promise<void>
}
```

`FormSchema` field: `{ id, label, type, required, options?, value?, section?, hint? }`.

## Playwright backend (v1)
- One browser, one context per job. Storage state per site loaded from `sessions/`.
- `snapshot` and `formSchema` built from DOM and accessibility tree. No screenshots in the loop.
- Stable ids: derived from label, name, input type and DOM path hash, kept stable across re-renders.
- Handles iframes, shadow DOM, file inputs, custom selects, date pickers via helpers.
- Lean mode: block images, fonts and media to cut load and memory.
- Headed or headless chosen per site by config (job boards default headed).

## Backend registry and routing
- Registry maps backend names to implementations.
- Config routes `siteType` to `backend`, with an optional `fallback` and an optional `shadow` backend.
- Shadow mode: run the shadow backend on the same job, collect `formSchema` and fill results, never submit.

## Non-responsibilities
- Knows nothing about jobs, resumes or sites.
- No LLM calls.

## Acceptance criteria
- Playwright backend passes the interface contract tests on local HTML fixtures (text, select, radio, checkbox, textarea, file upload, multi-step, iframe).
- `formSchema` output is stable across two loads of the same page.
- Swapping in a fake backend requires no change outside config.

## Future: ai-browser
A Rust implementation exposes the same operations over CDP or a local socket. Out of scope now. See `ai-browser/README.md`.
