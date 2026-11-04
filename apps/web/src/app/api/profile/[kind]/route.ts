import { PROFILE_FILES, PROFILE_KINDS, type ProfileKind } from '@apply/core/profile'
import { getProfileFiles } from '@apply/db'
import { db } from '@/lib/db'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** Download one of your profile files as Markdown. */
export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await currentUser()
  if (!user) return new Response('Sign in first.', { status: 401 })
  const { kind } = await ctx.params
  if (!(PROFILE_KINDS as readonly string[]).includes(kind))
    return new Response('Not found', { status: 404 })
  const files = await getProfileFiles(db(), user.id)
  const k = kind as ProfileKind
  return new Response(files[k].content, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${PROFILE_FILES[k]}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
