'use client'

import { useState, useTransition } from 'react'
import {
  approveJobAction,
  markAppliedAction,
  retryJobAction,
  skipJobAction,
} from '@/app/actions/tasks'
import type { FormState } from '@/lib/state'

type Action = 'approve' | 'retry' | 'applied' | 'skip'

const CALL: Record<Action, (id: string) => Promise<FormState>> = {
  approve: approveJobAction,
  retry: retryJobAction,
  applied: markAppliedAction,
  skip: skipJobAction,
}

const LABEL: Record<Action, string> = {
  approve: 'Approve and submit',
  retry: 'Retry',
  applied: 'I applied by hand',
  skip: 'Skip this job',
}

export function JobActions({ jobId, actions }: { jobId: string; actions: Action[] }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<FormState>({})
  return (
    <div>
      <div className="row">
        {actions.map((a, i) => (
          <button
            key={a}
            className={i === 0 ? '' : 'secondary'}
            disabled={pending}
            onClick={() => start(async () => setMsg(await CALL[a](jobId)))}
          >
            {LABEL[a]}
          </button>
        ))}
      </div>
      {msg.error && (
        <p className="error" style={{ whiteSpace: 'pre-wrap' }}>
          {msg.error}
        </p>
      )}
      {msg.message && <p className="okmsg">{msg.message}</p>}
    </div>
  )
}
