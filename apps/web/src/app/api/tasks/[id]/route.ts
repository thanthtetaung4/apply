import { getTask, listTaskLogs } from '@apply/db'
import { db } from '@/lib/db'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 })
  const { id } = await ctx.params
  const task = await getTask(db(), user.id, id)
  if (!task) return Response.json({ error: 'Not found' }, { status: 404 })
  const after = Number(new URL(req.url).searchParams.get('after') ?? 0) || 0
  const logs = await listTaskLogs(db(), user.id, id, after)
  return Response.json({
    id: task.id,
    type: task.type,
    status: task.status,
    error: task.error,
    result: task.result,
    cancelRequested: task.cancelRequested,
    logs: logs.map((l) => ({ id: l.id, level: l.level, message: l.message, ts: l.ts })),
  })
}
