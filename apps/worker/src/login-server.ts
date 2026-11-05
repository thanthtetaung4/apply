import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { RemoteLoginBrowser, siteCookies, SIGN_IN_VIEWPORT } from '@apply/core/browser'
import { isSignInSite, SIGN_IN_LABEL, signInHostAllowed } from '@apply/core/signin'
import {
  TicketReplayGuard,
  userStores,
  verifyLoginTicket,
  type Db,
  type LoginTicket,
} from '@apply/db'
import type { WorkerEnv } from './env'

/**
 * Sign in windows. The web app gives a signed in user a short lived ticket; their browser opens a
 * WebSocket here with it. We start a real browser on the sign in page, stream it as JPEG frames,
 * and replay their clicks and keys. When they say they are signed in, the cookies are sealed to
 * the worker key and saved. Nothing they type is logged or stored.
 */

const IDLE_MS = 3 * 60_000
const MAX_MS = 10 * 60_000

const Inbound = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('mouse'),
    type: z.enum(['move', 'down', 'up']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['left', 'right']).optional(),
  }),
  z.object({ t: z.literal('wheel'), x: z.number(), y: z.number(), dx: z.number(), dy: z.number() }),
  z.object({
    t: z.literal('key'),
    key: z.string().min(1).max(20),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
  }),
  z.object({ t: z.literal('text'), text: z.string().max(2000) }),
  z.object({ t: z.literal('back') }),
  z.object({ t: z.literal('done') }),
  z.object({ t: z.literal('cancel') }),
])

export interface LoginServerOptions {
  log?: (line: string) => void
  /** Replaces the real browser in tests. */
  startBrowser?: typeof RemoteLoginBrowser.start
}

export interface LoginServer {
  port: number
  /** Open sign in windows right now. */
  active(): number
  close(): Promise<void>
}

export async function startLoginServer(
  db: Db,
  env: WorkerEnv,
  o: LoginServerOptions = {},
): Promise<LoginServer> {
  const log = o.log ?? (() => undefined)
  const start = o.startBrowser ?? RemoteLoginBrowser.start.bind(RemoteLoginBrowser)
  const guard = new TicketReplayGuard()
  /** One window per user. A new one replaces the old. */
  const byUser = new Map<string, WebSocket>()

  const http: Server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, active: byUser.size }))
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({
    server: http,
    path: '/signin',
    maxPayload: 16 * 1024,
    verifyClient: (info, done) => {
      const origin = (info.origin ?? '').replace(/\/$/, '')
      if (!env.LOGIN_ALLOWED_ORIGINS.includes(origin)) return done(false, 403, 'Origin not allowed')
      done(true)
    },
  })

  wss.on('connection', (ws, req) => {
    const send = (m: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }
    const fail = (message: string, code = 4000) => {
      send({ t: 'error', message })
      ws.close(code, message.slice(0, 120))
    }

    let ticket: LoginTicket
    try {
      ticket = verifyLoginTicket(
        env.encryptionKey,
        new URL(req.url ?? '', 'http://x').searchParams.get('t') ?? '',
      )
    } catch {
      return fail('This sign in link has expired. Close the window and press Connect again.', 4001)
    }
    if (!guard.claim(ticket)) return fail('This sign in link was already used.', 4001)
    if (!isSignInSite(ticket.site)) return fail('Unknown site.', 4002)
    const site = ticket.site
    const allowHost = (h: string) => signInHostAllowed(site, h, env.LOGIN_EXTRA_HOSTS)

    const previous = byUser.get(ticket.userId)
    if (previous) {
      previous.close(4003, 'Opened in another window')
      byUser.delete(ticket.userId)
    }
    if (byUser.size >= env.LOGIN_MAX_SESSIONS)
      return fail('Too many people are signing in right now. Try again in a minute.', 4004)
    byUser.set(ticket.userId, ws)

    const who = `${ticket.userId.slice(0, 8)} ${ticket.key}`
    log(`signin open ${who}`)
    let browser: RemoteLoginBrowser | undefined
    let closed = false
    let idle: NodeJS.Timeout | undefined
    const resetIdle = () => {
      clearTimeout(idle)
      idle = setTimeout(() => fail('Closed after 3 minutes without activity.', 4005), IDLE_MS)
    }
    const hard = setTimeout(() => fail('Sign in windows close after 10 minutes.', 4005), MAX_MS)
    resetIdle()

    const cleanup = async () => {
      if (closed) return
      closed = true
      clearTimeout(idle)
      clearTimeout(hard)
      if (byUser.get(ticket.userId) === ws) byUser.delete(ticket.userId)
      await browser?.close()
      log(`signin close ${who}`)
    }
    ws.on('close', () => void cleanup())
    ws.on('error', () => void cleanup())

    // Input can arrive before the browser is ready; it is dropped until then.
    let busy = Promise.resolve()
    ws.on('message', (data, isBinary) => {
      if (isBinary || closed) return
      let msg: z.infer<typeof Inbound>
      try {
        msg = Inbound.parse(JSON.parse(data.toString()))
      } catch {
        return
      }
      if (msg.t === 'cancel') return void ws.close(1000, 'Cancelled')
      // Run actions one at a time, in order, so typing never arrives scrambled.
      busy = busy
        .then(async () => {
          if (!browser || closed) return
          if (msg.t === 'done') return finish(browser)
          if (msg.t !== 'mouse' || msg.type !== 'move') resetIdle()
          await browser.input(msg)
        })
        .catch(() => undefined)
    })

    const finish = async (b: RemoteLoginBrowser) => {
      try {
        await save(b)
      } catch (err) {
        log(`signin save failed ${who}: ${(err as Error).message.slice(0, 120)}`)
        send({ t: 'error', message: 'Could not save the sign in. Try again.', keepOpen: true })
      }
    }
    const save = async (b: RemoteLoginBrowser) => {
      const state = await b.exportState()
      if (siteCookies(state, allowHost).length === 0) {
        send({
          t: 'error',
          message: `${SIGN_IN_LABEL[site]} has not signed you in yet. Finish signing in, then press the button again.`,
          keepOpen: true,
        })
        return
      }
      await userStores(db, ticket.userId, env.encryptionKey, env.sessionKeys).sessions.put(
        ticket.key,
        state,
      )
      log(`signin saved ${who}`)
      send({ t: 'saved', key: ticket.key })
      ws.close(1000, 'Saved')
    }

    void (async () => {
      try {
        const b = await start({
          url: ticket.url,
          allowHost,
          chromiumPath: env.CHROMIUM_PATH,
          onFrame: (jpeg) => {
            // Drop frames when the connection is backed up rather than queueing them.
            if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2_000_000) ws.send(jpeg)
          },
          onUrl: (url) => send({ t: 'url', url }),
          onBlocked: (host) =>
            send({
              t: 'blocked',
              message: `${host || 'That page'} is outside ${SIGN_IN_LABEL[site]}, so it was not opened. Sign in with your ${SIGN_IN_LABEL[site]} email and password; Google and Apple sign in do not work here.`,
            }),
        })
        if (closed) return void b.close()
        browser = b
        send({ t: 'ready', site, label: SIGN_IN_LABEL[site], ...SIGN_IN_VIEWPORT })
      } catch (err) {
        log(`signin failed to start ${who}: ${(err as Error).message.slice(0, 120)}`)
        fail('Could not open the sign in page. Try again in a moment.', 4006)
      }
    })()
  })

  await new Promise<void>((resolve) => http.listen(env.LOGIN_PORT, resolve))
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : env.LOGIN_PORT
  return {
    port,
    active: () => byUser.size,
    close: async () => {
      for (const ws of wss.clients) ws.close(1001, 'Worker stopping')
      await new Promise<void>((r) => wss.close(() => r()))
      await new Promise<void>((r) => http.close(() => r()))
    },
  }
}
