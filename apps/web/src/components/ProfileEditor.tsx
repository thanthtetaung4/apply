'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { saveFileAction, validateFileAction } from '@/app/actions/profile'

export interface EditorFile {
  kind: 'resume' | 'titles' | 'projects' | 'answers'
  label: string
  file: string
  help: string
  content: string
  revision: number
  template: string
}

interface Check {
  ok: boolean
  issues: string[]
  summary: string[]
}

interface FileState {
  text: string
  saved: string
  revision: number
  check?: Check
  message?: string
  error?: string
  saving?: boolean
}

export function ProfileEditor({ files }: { files: EditorFile[] }) {
  const [active, setActive] = useState<EditorFile['kind']>(files[0]!.kind)
  const [state, setState] = useState<Record<string, FileState>>(() =>
    Object.fromEntries(
      files.map((f) => [f.kind, { text: f.content, saved: f.content, revision: f.revision }]),
    ),
  )
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const patch = useCallback(
    (kind: string, p: Partial<FileState>) =>
      setState((s) => ({ ...s, [kind]: { ...s[kind]!, ...p } })),
    [],
  )

  const validate = useCallback(
    (kind: string, text: string) => {
      clearTimeout(timers.current[kind])
      timers.current[kind] = setTimeout(
        async () => patch(kind, { check: await validateFileAction(kind, text) }),
        350,
      )
    },
    [patch],
  )

  useEffect(() => {
    for (const f of files) validate(f.kind, f.content)
    const timersNow = timers.current
    return () => Object.values(timersNow).forEach(clearTimeout)
    // Run once on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = useCallback(
    async (kind: string) => {
      const cur = state[kind]!
      patch(kind, { saving: true, error: undefined, message: undefined })
      const r = await saveFileAction(kind, cur.text, cur.revision)
      if (r.saved)
        patch(kind, {
          saving: false,
          saved: cur.text,
          revision: r.revision!,
          check: r,
          message: 'Saved.',
        })
      else patch(kind, { saving: false, check: r, error: r.error })
    },
    [state, patch],
  )

  const dirtyAny = Object.values(state).some((s) => s.text !== s.saved)
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirtyAny) e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirtyAny])

  const f = files.find((x) => x.kind === active)!
  const s = state[active]!
  const dirty = s.text !== s.saved

  return (
    <div>
      <div className="tabs" role="tablist">
        {files.map((x) => {
          const st = state[x.kind]!
          const bad = st.check && !st.check.ok
          return (
            <button
              key={x.kind}
              role="tab"
              aria-selected={x.kind === active}
              className={`tab ${x.kind === active ? 'active' : ''}`}
              onClick={() => setActive(x.kind)}
            >
              {x.file}
              {st.text !== st.saved ? ' *' : ''}
              {bad ? <span className="error"> !</span> : null}
            </button>
          )
        })}
      </div>
      <div className="two" style={{ gridTemplateColumns: '1fr 300px', alignItems: 'start' }}>
        <div>
          <p className="muted small">{f.help}</p>
          <textarea
            className="editor"
            aria-label={f.file}
            spellCheck={false}
            value={s.text}
            onChange={(e) => {
              patch(active, { text: e.target.value, message: undefined })
              validate(active, e.target.value)
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault()
                void save(active)
              }
            }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button disabled={!dirty || s.saving} onClick={() => void save(active)}>
              {s.saving ? 'Saving...' : 'Save'}
            </button>
            <button
              className="secondary"
              onClick={() => {
                if (
                  window.confirm(
                    `Replace ${f.file} with the starter template? Your current text will be lost.`,
                  )
                ) {
                  patch(active, { text: f.template })
                  validate(active, f.template)
                }
              }}
            >
              Use starter template
            </button>
            {dirty && <span className="muted small">Unsaved changes. Ctrl+S saves.</span>}
            {s.message && <span className="okmsg">{s.message}</span>}
          </div>
          {s.error && <p className="error">{s.error}</p>}
        </div>
        <aside className="card" style={{ marginBottom: 0 }} aria-live="polite">
          <h3>{s.check ? (s.check.ok ? 'Looks good' : 'Needs fixing') : 'Checking...'}</h3>
          {s.check && s.check.issues.length > 0 && (
            <ul className="issues error">
              {s.check.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          {s.check && s.check.summary.length > 0 && (
            <ul className="muted small" style={{ paddingLeft: 18 }}>
              {s.check.summary.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  )
}
