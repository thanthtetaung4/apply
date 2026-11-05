'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { deleteFilesAction } from '@/app/actions/files'
import type { FormState } from '@/lib/state'
import { Messages } from './Messages'

export interface FileItem {
  id: string
  jobId: string
  kind: string
  kindLabel: string
  name: string
  size: string
  created: string
  company: string
  title: string
  viewable: boolean
}

/** File list with selection and delete. Rows come from the server page. */
export function FilesTable({ files }: { files: FileItem[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [state, setState] = useState<FormState>({})
  const [pending, start] = useTransition()
  const all = files.length > 0 && selected.size === files.length
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const remove = (ids: string[]) => {
    if (ids.length === 0) return
    if (
      !window.confirm(
        `Delete ${ids.length} file${ids.length === 1 ? '' : 's'}? This cannot be undone.`,
      )
    )
      return
    start(async () => {
      setState(await deleteFilesAction(ids))
      setSelected(new Set())
    })
  }

  if (files.length === 0) return <p className="muted">No files match.</p>

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className="danger"
          disabled={selected.size === 0 || pending}
          onClick={() => remove([...selected])}
        >
          {pending ? 'Deleting...' : `Delete selected (${selected.size})`}
        </button>
        <Messages state={state} />
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 28 }}>
              <input
                type="checkbox"
                aria-label="Select all on this page"
                checked={all}
                onChange={() => setSelected(all ? new Set() : new Set(files.map((f) => f.id)))}
              />
            </th>
            <th>File</th>
            <th>Job</th>
            <th className="num">Size</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${f.name}`}
                  checked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                />
              </td>
              <td>
                <span className="chip gray">{f.kindLabel}</span>{' '}
                {f.viewable ? (
                  <a href={`/api/artifacts/${f.id}`} target="_blank" rel="noreferrer">
                    {f.name}
                  </a>
                ) : (
                  f.name
                )}
              </td>
              <td>
                <Link href={`/jobs/${f.jobId}`}>{f.company}</Link>
                <div className="muted small">{f.title}</div>
              </td>
              <td className="num">{f.size}</td>
              <td className="muted">{f.created}</td>
              <td className="num">
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <a
                    className="btn secondary"
                    href={`/api/artifacts/${f.id}?download=1`}
                    aria-label={`Download ${f.name} (${f.company})`}
                  >
                    Download
                  </a>
                  <button
                    type="button"
                    className="link"
                    disabled={pending}
                    aria-label={`Delete ${f.name} (${f.company})`}
                    onClick={() => remove([f.id])}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
