import Link from 'next/link'
import { listTasks } from '@apply/db'
import { AutoRefresh } from '@/components/AutoRefresh'
import { StartPanel } from '@/components/StartPanel'
import { TaskPanel } from '@/components/TaskPanel'
import { db, jobStore, stores } from '@/lib/db'
import { profileProblem } from '@/lib/preflight'
import { requireUser } from '@/lib/session'
import { timeAgo } from '@/lib/format'

export default async function Dashboard() {
  const user = await requireUser()
  const [counts, tasks, problem, sessions] = await Promise.all([
    jobStore(user.id).counts(),
    listTasks(db(), user.id, 6),
    profileProblem(user.id),
    stores(user.id).sessions.list(),
  ])
  const signedOut = sessions.filter((s) => s.status === 'expired')
  const n = (...s: string[]) =>
    counts.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.n, 0)
  const tiles = [
    {
      label: 'In the queue',
      value: n('queued', 'tailoring', 'ready', 'filling', 'verifying'),
      href: '/jobs?status=ready',
    },
    {
      label: 'Waiting for your review',
      value: n('ready_to_submit'),
      href: '/jobs?status=ready_to_submit',
    },
    {
      label: 'Submitted',
      value: n('submitted', 'submitted_unconfirmed'),
      href: '/jobs?status=submitted',
    },
    { label: 'Need you', value: n('needs_human'), href: '/needs-you' },
    { label: 'Failed', value: n('failed'), href: '/jobs?status=failed' },
  ]
  const latest = tasks[0]
  const busy = tasks.some((t) => t.status === 'queued' || t.status === 'running')
  const starter = problem?.includes('starter template')
  return (
    <>
      <AutoRefresh active={busy} />
      <div className="head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Find jobs, let the worker fill the forms, review, and submit.</p>
        </div>
      </div>

      {problem && (
        <div className="banner warn">
          <strong>{starter ? 'Add your resume first.' : 'Fix your profile first.'}</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{problem}</div>
          <p style={{ margin: '8px 0 0' }}>
            <Link className="btn" href="/profile">
              Open Profile
            </Link>
          </p>
        </div>
      )}

      {signedOut.length > 0 && (
        <div className="banner warn">
          <strong>Sign in again to keep applying.</strong>{' '}
          {signedOut.length === 1 ? 'One site has' : `${signedOut.length} sites have`} signed you
          out, so jobs there are waiting.
          <p style={{ margin: '8px 0 0' }}>
            <Link className="btn" href="/connections">
              Open Connections
            </Link>
          </p>
        </div>
      )}

      <div className="grid">
        {tiles.map((t) => (
          <Link key={t.label} className="tile" href={t.href}>
            <div className="n">{t.value}</div>
            <div className="muted">{t.label}</div>
          </Link>
        ))}
      </div>

      <div className="card">
        <StartPanel blocked={null} />
      </div>

      {latest ? (
        <div className="card">
          <h2>Latest task</h2>
          <TaskPanel
            key={latest.id}
            taskId={latest.id}
            type={latest.type}
            initialStatus={latest.status}
          />
        </div>
      ) : null}

      {tasks.length > 1 && (
        <div className="card">
          <h2>Recent tasks</h2>
          <table>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.type === 'intake' ? 'Find jobs' : 'Apply'}</td>
                  <td>
                    <span
                      className={`chip ${t.status === 'succeeded' ? 'ok' : t.status === 'failed' ? 'bad' : t.status === 'running' ? 'info' : 'gray'}`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="muted">{timeAgo(t.createdAt)}</td>
                  <td className="muted small" style={{ whiteSpace: 'pre-wrap' }}>
                    {t.error?.split('\n')[0]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
