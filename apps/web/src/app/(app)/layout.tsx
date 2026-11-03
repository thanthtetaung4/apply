import { listJobs } from '@apply/db'
import { logoutAction } from '@/app/actions/auth'
import { Nav } from '@/components/Nav'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  const parked = await listJobs(db(), user.id, { status: 'needs_human', limit: 1 })
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Auto Apply</div>
        <Nav needsYou={parked.total} />
        <div className="me">
          <div style={{ fontWeight: 600 }}>{user.name ?? user.email}</div>
          <div className="muted" style={{ marginBottom: 8, wordBreak: 'break-all' }}>
            {user.email}
          </div>
          <form action={logoutAction}>
            <button className="secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}
