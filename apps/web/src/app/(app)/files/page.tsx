import Link from 'next/link'
import { PROFILE_FILES, PROFILE_KINDS } from '@apply/core/profile'
import { fileUsage, FILE_KINDS, getProfileFiles, listFiles, type FileKind } from '@apply/db'
import { CleanupScreenshots, ImportProfileFile } from '@/components/FileTools'
import { FilesTable, type FileItem } from '@/components/FilesTable'
import { db } from '@/lib/db'
import { timeAgo } from '@/lib/format'
import { requireUser } from '@/lib/session'

const KIND_LABEL: Record<FileKind, string> = {
  resume_pdf: 'Tailored resume',
  screenshot: 'Screenshot',
  record: 'Run record',
  tailor: 'Tailoring notes',
}
const KIND_PLURAL: Record<FileKind, string> = {
  resume_pdf: 'Tailored resumes',
  screenshot: 'Screenshots',
  record: 'Run records',
  tailor: 'Tailoring notes',
}
const PAGE = 50

const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`

/** Types the browser can show safely in a new tab (served sandboxed). */
const viewable = (contentType: string) =>
  /^(image\/(png|jpeg|webp)|application\/pdf|application\/json|text\/plain)/.test(contentType)

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; q?: string; page?: string }>
}) {
  const user = await requireUser()
  const sp = await searchParams
  const kind = (FILE_KINDS as readonly string[]).includes(sp.kind ?? '')
    ? (sp.kind as FileKind)
    : undefined
  const q = (sp.q ?? '').slice(0, 100)
  const page = Math.max(1, Number(sp.page) || 1)
  const [list, usage, profile] = await Promise.all([
    listFiles(db(), user.id, { kind, q, limit: PAGE, offset: (page - 1) * PAGE }),
    fileUsage(db(), user.id),
    getProfileFiles(db(), user.id),
  ])
  const total = usage.reduce((a, u) => a + u.bytes, 0)
  const pages = Math.max(1, Math.ceil(list.total / PAGE))
  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    const v = { kind, q: q || undefined, page: undefined, ...over }
    for (const [k, val] of Object.entries(v))
      if (val !== undefined && val !== '') p.set(k, String(val))
    const s = p.toString()
    return s ? `/files?${s}` : '/files'
  }
  const items: FileItem[] = list.rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind],
    name: r.name,
    size: bytes(r.size),
    created: timeAgo(r.createdAt),
    company: r.company,
    title: r.title,
    viewable: viewable(r.contentType),
  }))

  return (
    <>
      <div className="head">
        <div>
          <h1>Files</h1>
          <p className="muted">
            Your profile files, and everything the app made while applying: tailored resumes,
            screenshots of each step, and run records.
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Profile files</h2>
        <p className="muted small">
          The four files every application is built from. Edit them on the{' '}
          <Link href="/profile">Profile</Link> page, or download them and upload a new version here.
        </p>
        <table style={{ marginBottom: 12 }}>
          <tbody>
            {PROFILE_KINDS.map((k) => (
              <tr key={k}>
                <td>{PROFILE_FILES[k]}</td>
                <td className="muted">
                  {bytes(new TextEncoder().encode(profile[k].content).length)}, updated{' '}
                  {timeAgo(profile[k].updatedAt)}
                </td>
                <td className="num">
                  <a className="btn secondary" href={`/api/profile/${k}`}>
                    Download
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ImportProfileFile
          kinds={PROFILE_KINDS.map((k) => ({ kind: k, file: PROFILE_FILES[k] }))}
        />
      </div>

      <div className="card">
        <h2>Storage</h2>
        <div className="storage">
          <div>
            <div className="muted small">Total</div>
            <strong>{bytes(total)}</strong>
          </div>
          {usage.map((u) => (
            <div key={u.kind}>
              <div className="muted small">{KIND_PLURAL[u.kind]}</div>
              <strong>{u.count}</strong> <span className="muted">({bytes(u.bytes)})</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <CleanupScreenshots />
        </div>
      </div>

      <div className="card">
        <div className="tabs" role="navigation" aria-label="File types">
          <Link href={href({ kind: undefined })} className={!kind ? 'active' : ''}>
            All
          </Link>
          {FILE_KINDS.map((k) => (
            <Link key={k} href={href({ kind: k })} className={kind === k ? 'active' : ''}>
              {KIND_PLURAL[k]}
            </Link>
          ))}
        </div>
        <form className="row" action="/files" style={{ margin: '12px 0' }}>
          {kind && <input type="hidden" name="kind" value={kind} />}
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search by company, job title or file name"
            aria-label="Search files"
            style={{ flex: 1 }}
          />
          <button type="submit" className="secondary">
            Search
          </button>
        </form>
        <FilesTable key={`${kind}-${q}-${page}`} files={items} />
        {pages > 1 && (
          <div className="row" style={{ marginTop: 10 }}>
            {page > 1 && (
              <Link className="btn secondary" href={href({ page: page - 1 })}>
                Previous
              </Link>
            )}
            <span className="muted">
              Page {page} of {pages} ({list.total} files)
            </span>
            {page < pages && (
              <Link className="btn secondary" href={href({ page: page + 1 })}>
                Next
              </Link>
            )}
          </div>
        )}
      </div>
    </>
  )
}
