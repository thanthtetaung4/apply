'use client'

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
