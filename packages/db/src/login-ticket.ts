import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Short lived permission to open one sign in window, issued by the web app to a signed in user
 * and checked by the worker. The web app and worker share the app key; the ticket key is derived
 * from it so a ticket can never be confused with another use of that key.
 *
 * A ticket names the user, the site, the session name to save under, and the first page. The
 * worker refuses a ticket that is expired, tampered with, or used before.
 */

export interface LoginTicket {
  userId: string
  site: string
  /** Session name the result is saved under. */
  key: string
  url: string
  /** Expiry, ms since epoch. */
  exp: number
  nonce: string
}

const ticketKey = (appKey: Buffer) =>
  Buffer.from(hkdfSync('sha256', appKey, Buffer.alloc(0), 'apply/login-ticket/v1', 32))

const mac = (appKey: Buffer, body: string) =>
  createHmac('sha256', ticketKey(appKey)).update(body).digest()

export function createLoginTicket(
  appKey: Buffer,
  t: Omit<LoginTicket, 'exp' | 'nonce'>,
  ttlMs = 120_000,
  now = Date.now(),
): string {
  const ticket: LoginTicket = {
    ...t,
    exp: now + ttlMs,
    nonce: randomBytes(12).toString('base64url'),
  }
  const body = Buffer.from(JSON.stringify(ticket)).toString('base64url')
  return `${body}.${mac(appKey, body).toString('base64url')}`
}

export class TicketError extends Error {}

/** Check signature and expiry. Single use is enforced by the caller (see `TicketReplayGuard`). */
export function verifyLoginTicket(appKey: Buffer, token: string, now = Date.now()): LoginTicket {
  const [body, sig] = String(token).split('.')
  if (!body || !sig) throw new TicketError('Malformed ticket')
  const expected = mac(appKey, body)
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new TicketError('Bad ticket signature')
  let t: LoginTicket
  try {
    t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LoginTicket
  } catch {
    throw new TicketError('Malformed ticket')
  }
  if (typeof t.exp !== 'number' || t.exp < now) throw new TicketError('Ticket expired')
  if (!t.userId || !t.site || !t.key || !t.url || !t.nonce)
    throw new TicketError('Malformed ticket')
  return t
}

/** Remembers used ticket nonces until they would have expired anyway. */
export class TicketReplayGuard {
  private used = new Map<string, number>()

  /** True the first time a nonce is seen, false after. */
  claim(t: LoginTicket, now = Date.now()): boolean {
    for (const [n, exp] of this.used) if (exp < now) this.used.delete(n)
    if (this.used.has(t.nonce)) return false
    this.used.set(t.nonce, t.exp)
    return true
  }
}
