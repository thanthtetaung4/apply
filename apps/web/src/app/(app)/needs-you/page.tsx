import Link from 'next/link'
import { listJobs } from '@apply/db'
import { AnswerForm } from '@/components/AnswerForm'
import { AutoRefresh } from '@/components/AutoRefresh'
import { JobActions } from '@/components/JobActions'
import { db } from '@/lib/db'
import { BLOCK_HELP, SITE_LABEL, questionsFromReason } from '@/lib/format'
import { requireUser } from '@/lib/session'

export default async function NeedsYou() {
  const user = await requireUser()
  const { rows } = await listJobs(db(), user.id, { status: 'needs_human', limit: 100 })
  const failed = (await listJobs(db(), user.id, { status: 'failed', limit: 50 })).rows
  const all = [...rows, ...failed]
  const questions = new Map<string, string[]>()
  for (const j of rows) {
    if (j.blockKind === 'unknown_question')
      for (const q of questionsFromReason(j.error))
        questions.set(q, [...(questions.get(q) ?? []), j.company])
  }
  return (
    <>
      <AutoRefresh active={false} />
      <div className="head">
        <div>
          <h1>Needs you</h1>
          <p className="muted">
            Jobs the app could not finish alone. Most are fixed once, and every later application
            reuses the fix.
          </p>
        </div>
      </div>

      {all.length === 0 && (
        <div className="card">
          <p>Nothing is waiting for you.</p>
        </div>
      )}

      {questions.size > 0 && (
        <div className="card">
          <h2>Questions to answer</h2>
          <p className="muted">
            Your answer is added to answers.md. Each job waiting on it is queued again right away.
          </p>
          {[...questions].map(([q, companies]) => (
            <div
              key={q}
              style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}
            >
              <div className="muted small">Asked by {companies.join(', ')}</div>
              <AnswerForm question={q} />
            </div>
          ))}
        </div>
      )}

      {all.filter((j) => j.blockKind !== 'unknown_question').length > 0 && (
        <div className="card">
          <h2>Other jobs</h2>
          {all
            .filter((j) => j.blockKind !== 'unknown_question')
            .map((j) => {
              const site = j.applyTarget === 'board_native' ? j.source : j.applyTarget
              return (
                <div
                  key={j.id}
                  style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}
                >
                  <div className="row">
                    <Link href={`/jobs/${encodeURIComponent(j.id)}`}>
                      <b>{j.company}</b>
                    </Link>
                    <span className="muted">
                      {j.title} · {SITE_LABEL[site] ?? site}
                    </span>
                  </div>
                  <p style={{ margin: '4px 0' }}>{BLOCK_HELP[j.blockKind ?? 'error'] ?? j.error}</p>
                  <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>
                    {j.error}
                  </p>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <a
                      className="btn secondary"
                      href={j.applyUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open the application
                    </a>
                    {j.blockKind === 'login_required' && (
                      <Link className="btn secondary" href="/connections">
                        Connect account
                      </Link>
                    )}
                  </div>
                  <JobActions jobId={j.id} actions={['retry', 'applied', 'skip']} />
                </div>
              )
            })}
        </div>
      )}
    </>
  )
}
