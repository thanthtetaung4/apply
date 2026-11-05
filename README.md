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
2. `pnpm keys:generate`: put `SESSION_PUBLIC_KEY` in the web and worker env, `WORKER_SESSION_PRIVATE_KEY` in the worker env only
3. Copy the env to `apps/web/.env.local` (without the private key) and `apps/worker/.env`
4. `pnpm install && pnpm db:migrate && pnpm browsers:install`
5. `pnpm dev` (web) and `pnpm dev:worker` (worker and sign in windows on port 4100) in two terminals
6. `pnpm demo` instead of the worker starts mock job sites and a demo account (demo@example.com / demo-password-123). It prints a demo Workday job link to try the sign in window with.

## How users connect job sites

On the Connections page a user presses Connect. The worker opens a real browser on the site's sign in page and streams it into the page; the user's clicks and keys are replayed into it, so 2FA and CAPTCHAs work. When they press "I'm signed in", only the cookies and local storage are kept, sealed to the worker's X25519 public key (`packages/db/src/sealed.ts`). The web app has only the public key, so it can store sessions but never read them. Each window needs a two minute, single use ticket from the web app, is limited to the site's own domains, and closes after 3 minutes idle or 10 minutes in total. When a site later shows a sign in page, the session is marked expired and the app asks the user to sign in again.

## Deploy

- Database: Neon. Use the pooled URL as `DATABASE_URL` for the app and the direct URL as `DATABASE_URL_UNPOOLED` for `pnpm db:migrate`.
- Web on Vercel: `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `SESSION_PUBLIC_KEY`, `WORKER_SIGNIN_URL` (wss:// address of the worker), `REGISTRATION_MODE` (open, invite, closed), `INVITE_CODE`.
- Worker: a container with Chromium (`pnpm browsers:install`), same database and app key, plus `WORKER_SESSION_PRIVATE_KEY` and `LOGIN_ALLOWED_ORIGINS` (the web app origin). Expose `LOGIN_PORT` over TLS (wss). Each open sign in window is a browser, so size memory for `LOGIN_MAX_SESSIONS`.
- Developers can still upload a session from their own computer with `pnpm login <site>` and an access token (Connections, "For developers").

## Tests

`pnpm -r test` (core, db, worker use in-memory Postgres). `pnpm --filter web e2e` runs the browser smoke test against a live stack.

Not verified: real job sites (including signing in to LinkedIn, Indeed, Glassdoor and Workday through the sign in window), live OpenRouter, a live board URL, Neon and Vercel deployments.
