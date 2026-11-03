# Apply

Job application agent. Next.js full stack app, Postgres (Neon ready), and a separate worker that drives Chromium.

## Layout

- `packages/core` engine: profile parsing, resume tailoring, browser backends, apply recipes, safety gate
- `packages/db` Drizzle schema, migrations, stores, auth, task queue, encrypted secrets
- `apps/web` Next.js UI and API (deploy on Vercel)
- `apps/worker` task runner with Chromium (deploy on a container host)
- `legacy/` earlier SQLite CLI, kept for reference
- `ai-browser/` placeholder for the future agent-native browser

## Local start

1. `cp .env.example .env` and set `DATABASE_URL` and `APP_ENCRYPTION_KEY` (32 bytes, base64)
2. `pnpm install && pnpm db:migrate`
3. `pnpm dev` (web) and `pnpm dev:worker` (worker) in two terminals
4. `pnpm demo` starts mock job sites and a demo account (demo@example.com / demo-password-123)

## Deploy

- Database: Neon. Use the pooled URL as `DATABASE_URL` for the app and the direct URL as `DATABASE_URL_UNPOOLED` for `pnpm db:migrate`.
- Web on Vercel: `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `REGISTRATION_MODE` (open, invite, closed), `INVITE_CODE`.
- Worker: a container with Chromium (`pnpm browsers:install`), same database and key. The server browser is headless only.
- Site sign-ins: run `pnpm login <site>` on your own computer. It uploads the session to the app with an API token created on the Connections page.

## Tests

`pnpm -r test` (core, db, worker use in-memory Postgres). `pnpm --filter web e2e` runs the browser smoke test against a live stack.

Not verified: real job sites, live OpenRouter, a live board URL, Neon and Vercel deployments.
