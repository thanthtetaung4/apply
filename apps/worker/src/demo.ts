/**
 * Local demo with fictional job sites. Needs a migrated Postgres (DATABASE_URL) and APP_ENCRYPTION_KEY.
 *
 *   pnpm demo              start the mock sites and a worker, create demo@example.com, keep running
 *   pnpm demo --run        also queue a full run and print the result when it finishes
 *   pnpm demo --reset      delete the demo account and its data first
 *   pnpm demo --workday    pre-save a Workday sign in for the mock company
 *
 * Open the web app, sign in as demo@example.com / demo-password-123, and press "Find jobs".
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FallbackBoardLogger, McpBoardLogger } from '@apply/core/board'
import { PlaywrightBackend } from '@apply/core/browser'
import { createMockBoard, demoSettings, MOCK_TARGET_RULES, startMockServer } from '@apply/core/demo'
import { readProfileTexts } from '@apply/core/profile-fs'
import { buildReport, renderReportText } from '@apply/core/report'
import {
  createDb,
  enqueueTask,
  getSettings,
  registerUser,
  saveProfileFile,
  saveSettings,
  userStores,
  schema,
} from '@apply/db'
import { eq } from 'drizzle-orm'
import { loadEnv } from './env'
import { startLoginServer } from './login-server'
import { startWorker } from './worker'

const EMAIL = 'demo@example.com'
const PASSWORD = 'demo-password-123'

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const args = process.argv.slice(2)
  const env = loadEnv()
  const handle = createDb(process.env.DATABASE_URL!, { max: 10 })
  const { db } = handle
  const say = (l: string) => console.log(l)

  const server = await startMockServer(Number(process.env.MOCK_PORT ?? 4010))
  const board = await createMockBoard()
  say(`Mock job sites: ${server.url}`)

  if (args.includes('--reset')) {
    await db.delete(schema.users).where(eq(schema.users.email, EMAIL))
    say('Removed the old demo account.')
  }

  let [user] = await db.select().from(schema.users).where(eq(schema.users.email, EMAIL))
  if (!user) {
    const created = await registerUser(db, {
      email: EMAIL,
      password: PASSWORD,
      name: 'Alex Tan (demo)',
    })
    user = (await db.select().from(schema.users).where(eq(schema.users.id, created.id)))[0]!
    const texts = readProfileTexts(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../demo/profile'),
    )
    for (const kind of ['resume', 'titles', 'projects', 'answers'] as const)
      await saveProfileFile(db, user.id, kind, texts[kind] ?? '')
  }
  // Always point the demo account at the current mock server port.
  await saveSettings(
    db,
    user.id,
    demoSettings(server.url, {
      backends: { shadow: { enabled: true, name: 'playwright-lean', sample: 0.5 } },
    }),
  )

  if (args.includes('--workday')) {
    const backend = new PlaywrightBackend()
    const s = await backend.launch({ headless: true })
    await s.open(`${server.url}/wd/meridian/job/301`)
    const wall = await s.formSchema()
    await s.fill(wall.fields.find((f) => f.type === 'email')!.id, EMAIL)
    await s.fill(wall.fields.find((f) => f.type === 'password')!.id, 'demo')
    await s.click(wall.actions.find((a) => a.label === 'Sign In')!.id)
    await userStores(db, user.id, env.encryptionKey, env.sessionKeys).sessions.put(
      'workday-meridian',
      await s.exportState(),
    )
    await s.close()
    await backend.dispose()
    say('Saved a Workday sign in for the mock company.')
  }

  const worker = startWorker(db, env, {
    log: (l) => say(`[worker] ${l}`),
    hooks: {
      targetRules: MOCK_TARGET_RULES,
      boardFor: (_id, stores) =>
        new FallbackBoardLogger(
          new McpBoardLogger(board.client, stores.jobs),
          { name: 'none', log: async () => undefined },
          stores.jobs,
        ),
    },
  })

  if (args.includes('--run')) {
    await enqueueTask(db, user.id, 'intake', { thenRun: true })
    await worker.idle()
    const store = userStores(db, user.id, env.encryptionKey, env.sessionKeys).jobs
    say('\n' + renderReportText(await buildReport(store, await getSettings(db, user.id))))
    say(`\nBoard (mock, over MCP) holds ${board.apps.length} applications.`)
    await worker.stop()
    await board.close()
    await server.close()
    await handle.close()
    return
  }

  // Sign in windows, allowed to open the mock sites too (for the demo Workday company).
  const login = await startLoginServer(
    db,
    {
      ...env,
      LOGIN_EXTRA_HOSTS: [...env.LOGIN_EXTRA_HOSTS, new URL(server.url).hostname],
    },
    { log: (l) => say(`[signin] ${l}`) },
  )
  say(`Sign in windows on port ${login.port}`)
  say(`Demo Workday job link for Connections: ${server.url}/wd/meridian/job/301`)

  say(`\nDemo account: ${EMAIL} / ${PASSWORD}`)
  say('Open the web app, sign in, and press "Find jobs". Press Ctrl+C here to stop.\n')
  const stop = async () => {
    await login.close()
    await worker.stop()
    await board.close()
    await server.close()
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
