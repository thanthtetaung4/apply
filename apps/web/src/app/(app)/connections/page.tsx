import { headers } from 'next/headers'
import { listApiTokens, listSecretNames } from '@apply/db'
import {
  BoardForm,
  ModelKeyForm,
  RemoveSessionButton,
  RevokeButton,
  TokenForm,
} from '@/components/ConnectionForms'
import { db, stores } from '@/lib/db'
import { timeAgo } from '@/lib/format'
import { requireUser } from '@/lib/session'

const SITES = [
  { key: 'indeed', label: 'Indeed' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'glassdoor', label: 'Glassdoor' },
]

export default async function Connections() {
  const user = await requireUser()
  const [sessions, secrets, tokens, h] = await Promise.all([
    stores(user.id).sessions.list(),
    listSecretNames(db(), user.id),
    listApiTokens(db(), user.id),
    headers(),
  ])
  const has = (n: string) => secrets.some((s) => s.name === n)
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`
  const byKey = new Map(sessions.map((s) => [s.key, s.updatedAt]))
  const workday = sessions.filter((s) => s.key.startsWith('workday-'))
  return (
    <>
      <div className="head">
        <div>
          <h1>Connections</h1>
          <p className="muted">Accounts, models and the board the worker uses on your behalf.</p>
        </div>
      </div>

      <div className="card">
        <h2>Job site accounts</h2>
        <p className="muted">
          You sign in yourself, on your own computer, so your password never reaches this app and
          2FA works. Only the resulting session is uploaded, and it is stored encrypted.
        </p>
        <table>
          <tbody>
            {SITES.map((s) => (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td>
                  {byKey.has(s.key) ? (
                    <span className="chip ok">connected {timeAgo(byKey.get(s.key))}</span>
                  ) : (
                    <span className="chip gray">not connected</span>
                  )}
                </td>
                <td className="num">{byKey.has(s.key) && <RemoveSessionButton name={s.key} />}</td>
              </tr>
            ))}
            {workday.map((s) => (
              <tr key={s.key}>
                <td>Workday ({s.key.replace('workday-', '')})</td>
                <td>
                  <span className="chip ok">connected {timeAgo(s.updatedAt)}</span>
                </td>
                <td className="num">
                  <RemoveSessionButton name={s.key} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 style={{ marginTop: 16 }}>How to connect</h3>
        <ol className="small">
          <li>Create an access token below.</li>
          <li>
            On your computer, in the project folder, run:
            <pre>{`APPLY_API_URL=${origin} APPLY_API_TOKEN=<your token> pnpm login linkedin`}</pre>
          </li>
          <li>
            Sign in in the window that opens (finish any 2FA), then press Enter in the terminal.
          </li>
          <li>
            For Workday, give a job page of that company:{' '}
            <code>pnpm login workday https://acme.wd3.myworkdayjobs.com/...</code>
          </li>
        </ol>
        <p className="muted small">
          Sessions expire. When a site asks you to sign in again, the job appears under Needs you
          and you repeat the steps.
        </p>
      </div>

      <div className="card">
        <h2>Access tokens</h2>
        <p className="muted small">
          Used only by the sign in tool above. A token can upload sessions to your account and
          nothing else.
        </p>
        {tokens.length > 0 && (
          <table style={{ marginBottom: 10 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Starts with</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}</code>
                  </td>
                  <td className="muted">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'never'}</td>
                  <td className="num">
                    <RevokeButton id={t.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <TokenForm />
      </div>

      <div className="card">
        <h2>Model</h2>
        <p className="muted small">
          Your own OpenRouter key pays for any model calls, so usage is yours alone. Without a key
          the app fills forms from your profile and saved answers and parks anything it cannot
          answer.
        </p>
        <ModelKeyForm saved={has('openrouter_api_key')} />
      </div>

      <div className="card">
        <h2>Job Search Board</h2>
        <p className="muted small">
          Optional. After each application the app records it on your board over MCP. If the board
          is unreachable, updates are retried later and never block applying.
        </p>
        <BoardForm saved={has('board_mcp_url')} />
      </div>
    </>
  )
}
