import { describe, expect, it } from 'vitest'
import { generateKey, parseKey } from '../src/crypto'
import { createLoginTicket, TicketReplayGuard, verifyLoginTicket } from '../src/login-ticket'

const key = parseKey(generateKey())
const t = { userId: 'u1', site: 'linkedin', key: 'linkedin', url: 'https://www.linkedin.com/login' }

describe('login tickets', () => {
  it('verify, expire, and refuse tampering or another key', () => {
    const now = 1_000_000
    const tok = createLoginTicket(key, t, 120_000, now)
    expect(verifyLoginTicket(key, tok, now + 1000)).toMatchObject(t)
    expect(() => verifyLoginTicket(key, tok, now + 120_001)).toThrow(/expired/)
    expect(() => verifyLoginTicket(parseKey(generateKey()), tok, now)).toThrow(/signature/)

    const [body, sig] = tok.split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), userId: 'u2' }),
    ).toString('base64url')
    expect(() => verifyLoginTicket(key, `${forged}.${sig}`, now)).toThrow(/signature/)
    expect(() => verifyLoginTicket(key, 'nonsense', now)).toThrow(/Malformed/)
  })

  it('can be used once', () => {
    const guard = new TicketReplayGuard()
    const v = verifyLoginTicket(key, createLoginTicket(key, t))
    expect(guard.claim(v)).toBe(true)
    expect(guard.claim(v)).toBe(false)
    expect(guard.claim(verifyLoginTicket(key, createLoginTicket(key, t)))).toBe(true)
  })
})
