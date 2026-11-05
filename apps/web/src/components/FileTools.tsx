'use client'

import { useState, useTransition } from 'react'
import { deleteOldScreenshotsAction, importProfileFileAction } from '@/app/actions/files'
import type { FormState } from '@/lib/state'
import { Messages } from './Messages'
import { SubmitButton } from './SubmitButton'
import { useAction } from './useAction'

/** Free space by deleting old step screenshots. */
export function CleanupScreenshots() {
  const [days, setDays] = useState(30)
  const [state, setState] = useState<FormState>({})
  const [pending, start] = useTransition()
  return (
    <div>
      <div className="row">
        <label htmlFor="days" style={{ fontWeight: 400 }}>
          Delete screenshots older than
        </label>
        <select
          id="days"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ width: 'auto' }}
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={0}>any age (all)</option>
        </select>
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() => {
            if (
              days === 0 &&
              !window.confirm('Delete every screenshot? Job pages will no longer show them.')
            )
              return
            start(async () => setState(await deleteOldScreenshotsAction(days)))
          }}
        >
          {pending ? 'Deleting...' : 'Delete screenshots'}
        </button>
      </div>
      <Messages state={state} />
    </div>
  )
}

/** Replace a profile file with a Markdown file from the computer. */
export function ImportProfileFile({ kinds }: { kinds: { kind: string; file: string }[] }) {
  const { state, onSubmit, pending } = useAction(importProfileFileAction)
  return (
    <form onSubmit={onSubmit}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select name="kind" aria-label="Which profile file to replace" defaultValue="">
          <option value="" disabled>
            Replace which file?
          </option>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.file}
            </option>
          ))}
        </select>
        <input
          type="file"
          name="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          aria-label="Markdown file"
        />
        <SubmitButton busy={pending} pending="Uploading...">
          Upload and replace
        </SubmitButton>
      </div>
      <Messages state={state} />
    </form>
  )
}
