'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { cancelTaskAction } from '@/app/actions/tasks'

interface Log {
  id: number
  level: string
  message: string
}
interface TaskView {
  status: string
  type: string
  error: string | null
  result: unknown
  cancelRequested: boolean
}

const TERMINAL = ['succeeded', 'failed', 'canceled']
const LABEL: Record<string, string> = {
  queued: 'Waiting for the worker',
  running: 'Running',
  succeeded: 'Finished',
  failed: 'Failed',
  canceled: 'Canceled',
}
const TONE: Record<string, string> = {
  queued: 'gray',
  running: 'info',
  succeeded: 'ok',
  failed: 'bad',
  canceled: 'gray',
}

export function TaskPanel({
  taskId,
  type,
  initialStatus,
}: {
  taskId: string
  type: string
  initialStatus: string
}) {
  const router = useRouter()
  const [task, setTask] = useState<TaskView>({
    status: initialStatus,
    type,
    error: null,
    result: null,
    cancelRequested: false,
  })
  const [logs, setLogs] = useState<Log[]>([])
  const last = useRef(0)
  const box = useRef<HTMLDivElement>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    let stop = false
    let wasActive = !TERMINAL.includes(initialStatus)
    const tick = async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}?after=${last.current}`, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as TaskView & { logs: Log[] }
        if (data.logs.length) {
          last.current = data.logs[data.logs.length - 1]!.id
          setLogs((l) => [...l, ...data.logs])
        }
        setTask(data)
        if (TERMINAL.includes(data.status)) {
          if (wasActive) router.refresh()
          wasActive = false
          return
        }
        wasActive = true
      } catch {
        // Network blip. Try again on the next tick.
      }
      if (!stop) setTimeout(tick, 1500)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [taskId, initialStatus, router])

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [logs.length])

  const running = !TERMINAL.includes(task.status)
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>{task.type === 'intake' ? 'Finding jobs' : 'Applying'}</strong>
        <span className={`chip ${TONE[task.status] ?? 'gray'}`}>
          {LABEL[task.status] ?? task.status}
        </span>
        {task.cancelRequested && running && (
          <span className="muted small">Stopping after the current job...</span>
        )}
        <span className="spacer" />
        {running && !task.cancelRequested && (
          <button
            className="secondary"
            disabled={pending}
            onClick={() => start(async () => void (await cancelTaskAction(taskId)))}
          >
            Cancel
          </button>
        )}
      </div>
      {task.error && (
        <p className="error" style={{ whiteSpace: 'pre-wrap' }}>
          {task.error}
        </p>
      )}
      {task.status === 'succeeded' && <TaskResult type={task.type} result={task.result} />}
      <div className="log" ref={box} aria-live="polite">
        {logs.length === 0 ? (
          <span className="muted">
            {running ? 'Waiting for output...' : 'No output was recorded.'}
          </span>
        ) : (
          logs.map((l) => (
            <div key={l.id} className={l.level === 'error' ? 'e' : ''}>
              {l.message}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const BOARD_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
}

/** What a finished task did, in plain words, with where to go next. */
export function TaskResult({ type, result }: { type: string; result: unknown }) {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (type === 'intake') {
    const needs = (r.needsSignIn as string[] | undefined) ?? []
    const blocked = (r.blocked as string[] | undefined) ?? []
    return (
      <div className="banner ok" style={{ marginTop: 10 }}>
        Found {Number(r.found ?? 0)} jobs, {Number(r.queued ?? 0)} new and worth applying to.
        {needs.length > 0 && (
          <p className="error" style={{ margin: '6px 0 0' }}>
            {needs.map((n) => BOARD_LABEL[n] ?? n).join(', ')} asked you to sign in, so{' '}
            {needs.length === 1 ? 'it was' : 'they were'} skipped.{' '}
            <Link href="/connections">Connect on the Connections page</Link>.
          </p>
        )}
        {blocked.length > 0 && (
          <p className="error" style={{ margin: '6px 0 0' }}>
            {blocked.map((n) => BOARD_LABEL[n] ?? n).join(', ')} blocked the app&apos;s browser with
            bot protection, so {blocked.length === 1 ? 'it was' : 'they were'} skipped. You can turn{' '}
            {blocked.length === 1 ? 'it' : 'them'} off under Settings, Finding jobs.
          </p>
        )}
      </div>
    )
  }
  const by = (r.byStatus as Record<string, number> | undefined) ?? {}
  const n = (...keys: string[]) => keys.reduce((a, k) => a + (by[k] ?? 0), 0)
  const submitted = n('submitted', 'submitted_unconfirmed')
  const review = n('ready_to_submit')
  const needsYou = n('needs_human')
  const failed = n('failed')
  if (Number(r.processed ?? 0) === 0 && submitted + review + needsYou + failed === 0)
    return (
      <p className="muted" style={{ marginTop: 10 }}>
        Nothing was waiting to apply to. Find jobs first.
      </p>
    )
  return (
    <div className="banner ok" style={{ marginTop: 10 }}>
      <strong>Done.</strong> {submitted} submitted, {review} waiting for your review, {needsYou}{' '}
      need you{failed ? `, ${failed} failed` : ''}.
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {review > 0 && (
          <Link className="btn" href="/jobs?status=ready_to_submit">
            Review {review}
          </Link>
        )}
        {needsYou > 0 && (
          <Link className="btn secondary" href="/needs-you">
            See what needs you
          </Link>
        )}
        <Link className="btn secondary" href="/report">
          Open the report
        </Link>
      </div>
    </div>
  )
}
