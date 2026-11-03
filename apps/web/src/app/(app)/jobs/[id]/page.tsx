import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getJobDetail } from '@apply/db'
import { AutoRefresh } from '@/components/AutoRefresh'
import { JobActions } from '@/components/JobActions'
import { db, stores } from '@/lib/db'
import { BLOCK_HELP, SITE_LABEL, STATUS_LABEL, STATUS_TONE, timeAgo } from '@/lib/format'
import { requireUser } from '@/lib/session'

interface RecordField {
  step: number
  label: string
  type: string
  required: boolean
  intended: unknown
  actual?: unknown
  source: string
  status: string
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params
  const d = await getJobDetail(db(), user.id, decodeURIComponent(id))
  if (!d) notFound()
  const { job, app, m } = d
  const site = job.applyTarget === 'board_native' ? job.source : job.applyTarget

  let fields: RecordField[] = []
  const rec = d.artifacts.find((a) => a.kind === 'record')
  if (rec) {
    try {
      const art = await stores(user.id).artifacts.get(rec.id)
      fields = (JSON.parse(art!.data.toString()).outcome?.fields ?? []) as RecordField[]
    } catch {
      fields = []
    }
  }
  const shots = d.artifacts.filter((a) => a.kind === 'screenshot' && !a.name.startsWith('shadow/'))
  const resume = d.artifacts.find((a) => a.kind === 'resume_pdf')
  const status = app.status
  const actions: ('approve' | 'retry' | 'applied' | 'skip')[] =
    status === 'ready_to_submit'
      ? ['approve', 'applied', 'skip']
      : status === 'needs_human'
        ? ['retry', 'applied', 'skip']
        : status === 'failed'
          ? ['retry', 'applied', 'skip']
          : status === 'ready' || status === 'queued'
            ? ['skip']
            : []
  const shown = (v: unknown) =>
    typeof v === 'string'
      ? v.split(/[\\/]/).pop()!
      : Array.isArray(v)
        ? v.join(', ')
        : v === null || v === undefined
          ? ''
          : String(v)

  return (
    <>
      <AutoRefresh active={['queued', 'tailoring', 'filling', 'verifying'].includes(status)} />
      <p className="muted small">
        <Link href="/jobs">Jobs</Link> / {job.company}
      </p>
      <div className="head">
        <div>
          <h1>{job.title}</h1>
          <p className="muted">
            {job.company}
            {job.location ? ` · ${job.location}` : ''} · {SITE_LABEL[site] ?? site}
          </p>
        </div>
        <span className={`chip ${STATUS_TONE[status] ?? 'gray'}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </div>

      {(status === 'needs_human' || status === 'failed') && (
        <div className="banner bad">
          <strong>{BLOCK_HELP[app.blockKind ?? 'error'] ?? 'This job needs you.'}</strong>
          {app.error && <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{app.error}</div>}
          {app.blockKind === 'unknown_question' && (
            <p style={{ margin: '8px 0 0' }}>
              <Link className="btn" href="/needs-you">
                Answer it
              </Link>
            </p>
          )}
          {app.blockKind === 'login_required' && (
            <p style={{ margin: '8px 0 0' }}>
              <Link className="btn" href="/connections">
                Connect your account
              </Link>
            </p>
          )}
        </div>
      )}
      {status === 'ready_to_submit' && (
        <div className="banner warn">
          <strong>The form is filled and checked. Nothing was submitted.</strong> Look at the
          screenshots below. If they look right, approve it and the worker fills the form again and
          submits.
        </div>
      )}

      <div className="card">
        {actions.length > 0 && <JobActions jobId={job.id} actions={actions} />}
        <dl className="kv" style={{ marginTop: actions.length ? 14 : 0 }}>
          <dt>Apply link</dt>
          <dd>
            <a href={job.applyUrl} target="_blank" rel="noreferrer noopener">
              {job.applyUrl}
            </a>
          </dd>
          {job.sourceUrl && (
            <>
              <dt>Found on</dt>
              <dd>
                <a href={job.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {job.sourceUrl}
                </a>
              </dd>
            </>
          )}
          <dt>Match</dt>
          <dd>{job.matchScore ?? 'n/a'}</dd>
          <dt>Resume</dt>
          <dd>
            {resume ? (
              <a href={`/api/artifacts/${resume.id}`} target="_blank">
                {resume.name}
              </a>
            ) : (
              'Not made yet'
            )}
          </dd>
          {m && (
            <>
              <dt>Run</dt>
              <dd>
                {m.backend}, {m.steps} step{m.steps === 1 ? '' : 's'},{' '}
                {(m.durationMs / 1000).toFixed(1)}s, checks {m.verify}
              </dd>
            </>
          )}
          <dt>Tries</dt>
          <dd>{app.attempts}</dd>
        </dl>
      </div>

      {fields.length > 0 && (
        <div className="card">
          <h2>What was filled in</h2>
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Field</th>
                <th>Value</th>
                <th>From</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {fields
                .filter((f) => f.status !== 'skipped')
                .map((f, i) => (
                  <tr key={i}>
                    <td className="num">{f.step}</td>
                    <td>
                      {f.label}
                      {f.required ? ' *' : ''}
                    </td>
                    <td>{shown(f.actual ?? f.intended)}</td>
                    <td className="muted">{f.source === 'bank' ? 'saved answer' : f.source}</td>
                    <td>
                      <span className={`chip ${f.status === 'ok' ? 'ok' : 'bad'}`}>
                        {f.status === 'ok' ? 'matches' : f.status}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {shots.length > 0 && (
        <div className="card">
          <h2>Screenshots</h2>
          <div className="shots">
            {shots.map((s) => (
              <a key={s.id} href={`/api/artifacts/${s.id}`} target="_blank">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/artifacts/${s.id}`} alt={s.name} loading="lazy" />
                <div className="muted small">{s.name}</div>
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Description</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{job.description}</p>
      </div>

      <div className="card">
        <h2>History</h2>
        <table>
          <tbody>
            {d.events.map((e, i) => (
              <tr key={i}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                  {timeAgo(e.ts)}
                </td>
                <td>{e.type}</td>
                <td className="muted small">
                  {e.payload ? JSON.stringify(e.payload).slice(0, 200) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
