import Link from 'next/link'
import { listJobs } from '@apply/db'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { SITE_LABEL, STATUS_LABEL, STATUS_TONE, timeAgo } from '@/lib/format'

const FILTERS = ['', 'ready', 'ready_to_submit', 'submitted', 'needs_human', 'failed', 'skipped']
const PAGE = 25

export default async function Jobs({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>
}) {
  const user = await requireUser()
  const sp = await searchParams
  const status = FILTERS.includes(sp.status ?? '') ? sp.status || undefined : undefined
  const page = Math.max(1, Number(sp.page) || 1)
  const { rows, total } = await listJobs(db(), user.id, {
    status,
    q: sp.q?.slice(0, 80),
    limit: PAGE,
    offset: (page - 1) * PAGE,
  })
  const href = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ status, q: sp.q, ...o })) if (v) p.set(k, v)
    return `/jobs?${p}`
  }
  return (
    <>
      <div className="head">
        <div>
          <h1>Jobs</h1>
          <p className="muted">
            {total} job{total === 1 ? '' : 's'}
          </p>
        </div>
      </div>
      <div className="tabs">
        {FILTERS.map((f) => (
          <Link
            key={f || 'all'}
            href={href({ status: f || undefined, page: undefined })}
            className={(status ?? '') === f ? 'active' : ''}
          >
            {f ? STATUS_LABEL[f] : 'All'}
          </Link>
        ))}
      </div>
      <form action="/jobs" className="row" style={{ marginBottom: 12 }}>
        {status && <input type="hidden" name="status" value={status} />}
        <input
          type="text"
          name="q"
          defaultValue={sp.q}
          placeholder="Search company or title"
          aria-label="Search"
          style={{ maxWidth: 320 }}
        />
        <button className="secondary" type="submit">
          Search
        </button>
      </form>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Where</th>
              <th>Status</th>
              <th className="num">Match</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing here yet.
                </td>
              </tr>
            )}
            {rows.map((j) => {
              const site = j.applyTarget === 'board_native' ? j.source : j.applyTarget
              return (
                <tr key={j.id}>
                  <td>
                    <Link href={`/jobs/${encodeURIComponent(j.id)}`}>
                      <b>{j.company}</b>
                    </Link>
                    <div className="muted">{j.title}</div>
                  </td>
                  <td>{SITE_LABEL[site] ?? site}</td>
                  <td>
                    <span className={`chip ${STATUS_TONE[j.status] ?? 'gray'}`}>
                      {STATUS_LABEL[j.status] ?? j.status}
                    </span>
                    {j.error && <div className="muted small">{j.error.slice(0, 90)}</div>}
                  </td>
                  <td className="num">{j.matchScore ?? ''}</td>
                  <td className="muted">{timeAgo(j.updatedAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="row">
        {page > 1 && (
          <Link className="btn secondary" href={href({ page: String(page - 1) })}>
            Previous
          </Link>
        )}
        {page * PAGE < total && (
          <Link className="btn secondary" href={href({ page: String(page + 1) })}>
            Next
          </Link>
        )}
      </div>
    </>
  )
}
