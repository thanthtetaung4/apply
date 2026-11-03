import { buildReport } from '@apply/core/report'
import { getSettings } from '@apply/db'
import { db, jobStore } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { SITE_LABEL } from '@/lib/format'

export default async function Report() {
  const user = await requireUser()
  const r = await buildReport(jobStore(user.id), await getSettings(db(), user.id))
  return (
    <>
      <div className="head">
        <div>
          <h1>Report</h1>
          <p className="muted">
            How each kind of site is doing, and whether it has earned Auto submit.
          </p>
        </div>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h2>By site</h2>
        {r.sites.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th className="num">Runs</th>
                <th className="num">Submitted</th>
                <th className="num">Review</th>
                <th className="num">Needs you</th>
                <th className="num">Checks passed</th>
                <th className="num">Avg time</th>
                <th>Submit policy</th>
              </tr>
            </thead>
            <tbody>
              {r.sites.map((s) => (
                <tr key={s.siteType}>
                  <td>{SITE_LABEL[s.siteType]}</td>
                  <td className="num">{s.runs}</td>
                  <td className="num">{s.submitted}</td>
                  <td className="num">{s.review}</td>
                  <td className="num">{s.needsHuman}</td>
                  <td className="num">
                    {s.verifyPass}/{s.runs}
                  </td>
                  <td className="num">{s.avgSeconds.toFixed(1)}s</td>
                  <td>
                    {s.configured} to <b>{s.effective}</b>{' '}
                    <span className="muted small">{s.gateNote}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Model usage</h2>
        <p>
          {r.llm.calls} calls ({r.llm.cached} from cache), {r.llm.tokensIn} tokens in,{' '}
          {r.llm.tokensOut} out, ${r.llm.costUsd.toFixed(4)}.
          {r.llm.calls > 0 && r.llm.tokensIn === 0 && (
            <span className="muted">
              {' '}
              No model key is set, so the offline stand-in ran and token counts are zero.
            </span>
          )}
        </p>
      </div>
      {r.shadow.length > 0 && (
        <div className="card">
          <h2>Browser comparisons</h2>
          <table>
            <thead>
              <tr>
                <th>Browser</th>
                <th className="num">Ran</th>
                <th className="num">Fields compared</th>
                <th className="num">Differences</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {r.shadow.map((s) => (
                <tr key={s.backend}>
                  <td>{s.backend}</td>
                  <td className="num">
                    {s.ok}/{s.runs}
                  </td>
                  <td className="num">{s.compared}</td>
                  <td className="num">{s.diffs}</td>
                  <td className="muted">{s.errors.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
