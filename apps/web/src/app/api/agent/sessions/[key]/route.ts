import { SESSION_KEY_PATTERN, verifyApiToken } from '@apply/db'
import { z } from 'zod'
import { db, stores } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** Large enough for a real browser storage state, small enough to refuse junk. */
const MAX_BYTES = 2_000_000

const StateSchema = z.object({
  cookies: z.array(z.record(z.string(), z.unknown())).max(2000),
  origins: z.array(z.record(z.string(), z.unknown())).max(500),
})

/**
 * Upload a browser sign in from `pnpm login <site>` on the user's own computer.
 * Auth is an API token from the Connections page (`Authorization: Bearer aat_...`), not the
 * browser cookie, so the CLI never needs the user's password. The state is stored encrypted.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const auth = req.headers.get('authorization') ?? ''
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1]
  const owner = token ? await verifyApiToken(db(), token) : null
  if (!owner) return Response.json({ error: 'A valid API token is required.' }, { status: 401 })

  const { key } = await ctx.params
  if (!SESSION_KEY_PATTERN.test(key)) {
    return Response.json(
      { error: 'Unknown site. Use indeed, linkedin, glassdoor or workday-<company>.' },
      { status: 400 },
    )
  }

  const raw = await req.text()
  if (raw.length > MAX_BYTES) return Response.json({ error: 'Session is too large.' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 })
  }
  const parsed = StateSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'Body must be a browser storage state with "cookies" and "origins".' },
      { status: 400 },
    )
  }
  if (parsed.data.cookies.length === 0 && parsed.data.origins.length === 0) {
    return Response.json(
      { error: 'The session is empty. Finish signing in before uploading.' },
      { status: 400 },
    )
  }

  await stores(owner.userId).sessions.put(key, parsed.data)
  return Response.json({ ok: true, key })
}
