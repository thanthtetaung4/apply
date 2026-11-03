# ai-browser (placeholder)

Future home of an agent-native browser written in Rust. Nothing is implemented here yet and nothing should be until the TypeScript app (`../BUILD_PLAN.md`) has shipped and its metrics justify it.

## Intent
A browser built for agents, not for humans: no tabs or toolbar, structured page state instead of pixels, stable element ids, one-call form actions.

## How it plugs in
It will implement the same operations as `BrowserSession` in `../docs/modules/04-browser-interface.md` (open, snapshot, formSchema, fill, click, upload, next, readValues, screenshot, saveState, close), exposed over CDP or a local socket, and register as the backend name `ai-browser`.

Rollout is a config toggle, shadow mode first, then per-site promotion by A/B metrics. See PRD section 9.

## Start conditions (all required)
1. Phase 12 of the build plan is complete.
2. Metrics show the Chromium backend is a meaningful bottleneck for time, memory or tokens.
3. A fixture suite of real application pages exists to measure against.

## Options to evaluate when starting
1. Rust orchestrator and form-schema layer over Chromium via CDP (fastest to ship).
2. Minimal engine on html5ever and an embedded JS engine (learning-heavy, compatibility-limited).
3. Servo-based embedding (check embedding maturity first).
4. Contributing to Lightpanda instead of building a new engine.

Decision is deferred.
