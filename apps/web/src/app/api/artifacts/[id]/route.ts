import { currentUser } from '@/lib/session'
import { stores } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const user = await currentUser()
  if (!user) return new Response('Sign in first.', { status: 401 })
  const art = await stores(user.id).artifacts.get(id)
  if (!art) return new Response('Not found', { status: 404 })
  // ?download=1 saves the file instead of opening it in the browser.
  const disposition = new URL(req.url).searchParams.get('download') ? 'attachment' : 'inline'
  return new Response(new Uint8Array(art.data), {
    headers: {
      'content-type': art.contentType,
      'content-disposition': `${disposition}; filename="${art.name.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'private, max-age=60',
      'content-security-policy':
        "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  })
}
