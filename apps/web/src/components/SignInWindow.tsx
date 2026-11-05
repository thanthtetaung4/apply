'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { refreshConnectionsAction, startSignInAction } from '@/app/actions/connections'

type Phase = 'idle' | 'starting' | 'live' | 'saving' | 'saved' | 'closed'

/** Keys sent by name. Single characters are sent as typed text. */
const NAMED = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/**
 * "Connect" button plus the sign in window. The window shows a real browser running on our worker,
 * streamed as pictures. The user signs in there (2FA and CAPTCHAs work as usual); we keep only the
 * resulting cookies, sealed so only the worker can read them.
 */
export function ConnectButton({
  site,
  label,
  status,
  askForLink = false,
}: {
  site: string
  label: string
  status: 'connected' | 'expired' | 'none'
  /** Workday: one account per company, so ask for a job link of that company. */
  askForLink?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={status === 'connected' ? 'secondary' : ''}
        onClick={() => setOpen(true)}
      >
        {status === 'none' ? (askForLink ? 'Connect a company' : 'Connect') : 'Sign in again'}
      </button>
      {open && (
        <SignInWindow
          site={site}
          label={label}
          askForLink={askForLink}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function SignInWindow({
  site,
  label,
  askForLink,
  onClose,
}: {
  site: string
  label: string
  askForLink: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()
  const [address, setAddress] = useState('')
  const [link, setLink] = useState('')
  const [size, setSize] = useState({ width: 1280, height: 800 })
  const ws = useRef<WebSocket | null>(null)
  const img = useRef<HTMLImageElement | null>(null)
  const screen = useRef<HTMLDivElement | null>(null)
  const frameUrl = useRef<string | null>(null)
  const pendingMove = useRef<{ x: number; y: number } | null>(null)

  const send = useCallback((m: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m))
  }, [])

  const start = useCallback(async () => {
    setError(undefined)
    setMessage(undefined)
    setPhase('starting')
    const r = await startSignInAction(site, askForLink ? link : undefined)
    if (!r.ok) {
      setError(r.error)
      setPhase('idle')
      return
    }
    const sock = new WebSocket(`${r.wsUrl}?t=${encodeURIComponent(r.ticket)}`)
    sock.binaryType = 'blob'
    ws.current = sock
    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        // A new picture of the page. Swap it in and free the previous one.
        const url = URL.createObjectURL(ev.data as Blob)
        if (img.current) img.current.src = url
        if (frameUrl.current) URL.revokeObjectURL(frameUrl.current)
        frameUrl.current = url
        return
      }
      const m = JSON.parse(ev.data) as Record<string, unknown>
      switch (m.t) {
        case 'ready':
          setSize({ width: Number(m.width), height: Number(m.height) })
          setPhase('live')
          setTimeout(() => screen.current?.focus(), 50)
          break
        case 'url':
          setAddress(String(m.url))
          break
        case 'blocked':
          setMessage(String(m.message))
          break
        case 'error':
          setError(String(m.message))
          if (m.keepOpen) setPhase('live')
          break
        case 'saved':
          setPhase('saved')
          void refreshConnectionsAction().then(() => router.refresh())
          setTimeout(onClose, 1500)
          break
      }
    }
    sock.onerror = () =>
      setError('Could not reach the sign in service. Check your connection and try again.')
    sock.onclose = () => {
      setPhase((p) => (p === 'saved' ? p : 'closed'))
    }
  }, [site, askForLink, link, onClose, router])

  // Open straight away unless we first need a company link.
  useEffect(() => {
    if (!askForLink) void start()
    // Only on first open; `start` is deliberately left out of the dependencies.
  }, [])

  useEffect(
    () => () => {
      ws.current?.close()
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current)
    },
    [],
  )

  // Escape closes the window only when the page itself does not have focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement !== screen.current) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Page coordinates from a pointer position over the picture. */
  const point = (clientX: number, clientY: number) => {
    const r = img.current!.getBoundingClientRect()
    return {
      x: ((clientX - r.left) * size.width) / r.width,
      y: ((clientY - r.top) * size.height) / r.height,
    }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const first = pendingMove.current === null
    pendingMove.current = point(e.clientX, e.clientY)
    if (first)
      requestAnimationFrame(() => {
        if (pendingMove.current) send({ t: 'mouse', type: 'move', ...pendingMove.current })
        pendingMove.current = null
      })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Let the browser produce a paste event; we forward its text below.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return
    if (e.key.length === 1 || NAMED.has(e.key)) {
      e.preventDefault()
      send({
        t: 'key',
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      })
    }
  }

  const live = phase === 'live' || phase === 'saving'

  return (
    <div className="signin-overlay" role="presentation">
      <div className="signin-dialog" role="dialog" aria-modal="true" aria-labelledby="signin-title">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 id="signin-title" style={{ margin: 0 }}>
            Sign in to {label}
          </h2>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            {phase === 'saved' ? 'Close' : 'Cancel'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          This is a secure browser our service runs for you. Sign in as you normally would,
          including any code {label} sends you. We keep only the signed in session, encrypted so
          only the application worker can use it. Your password is never stored. Sign in with your{' '}
          {label} email and password: Google and Apple sign in are not supported here.
        </p>

        {askForLink && phase === 'idle' && (
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault()
              void start()
            }}
          >
            <label htmlFor="wd-link">A job link from the company Workday site</label>
            <div className="row">
              <input
                id="wd-link"
                type="url"
                required
                placeholder="https://company.wd3.myworkdayjobs.com/..."
                value={link}
                onChange={(e) => setLink(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit">Open sign in</button>
            </div>
            <p className="hint">
              Each company runs its own Workday, so you sign in once per company.
            </p>
          </form>
        )}

        {error && <p className="error">{error}</p>}
        {message && <p className="banner warn small">{message}</p>}

        {phase === 'starting' && <p className="muted">Opening {label}...</p>}
        {phase === 'saved' && (
          <p className="banner ok">{label} is connected. You can close this window.</p>
        )}
        {phase === 'closed' && (
          <p className="muted">
            The sign in window closed. Press {askForLink ? 'Open sign in' : 'Try again'} to start
            over.{' '}
            <button type="button" className="link" onClick={() => void start()}>
              Try again
            </button>
          </p>
        )}

        {(live || phase === 'starting') && (
          <>
            <div className="signin-address" title={address}>
              {address || ' '}
            </div>
            <div
              ref={screen}
              className="signin-screen"
              tabIndex={0}
              aria-label={`${label} sign in page. Click to interact, type to enter text.`}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                e.preventDefault()
                send({ t: 'text', text: e.clipboardData.getData('text/plain') })
              }}
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
            >
              <img
                ref={img}
                alt=""
                draggable={false}
                onMouseMove={onMouseMove}
                onMouseDown={(e) => {
                  e.preventDefault()
                  screen.current?.focus()
                  send({
                    t: 'mouse',
                    type: 'down',
                    button: e.button === 2 ? 'right' : 'left',
                    ...point(e.clientX, e.clientY),
                  })
                }}
                onMouseUp={(e) =>
                  send({
                    t: 'mouse',
                    type: 'up',
                    button: e.button === 2 ? 'right' : 'left',
                    ...point(e.clientX, e.clientY),
                  })
                }
                onWheel={(e) =>
                  send({ t: 'wheel', ...point(e.clientX, e.clientY), dx: e.deltaX, dy: e.deltaY })
                }
                onTouchStart={(e) => {
                  const t = e.touches[0]
                  if (t) send({ t: 'mouse', type: 'down', ...point(t.clientX, t.clientY) })
                }}
                onTouchEnd={(e) => {
                  const t = e.changedTouches[0]
                  if (t) send({ t: 'mouse', type: 'up', ...point(t.clientX, t.clientY) })
                }}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>
            <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <button type="button" className="secondary" onClick={() => send({ t: 'back' })}>
                Back
              </button>
              <input
                type="text"
                aria-label="Type into the page (for phones)"
                placeholder="On a phone? Tap the field on the page, then type here"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 200 }}
                onKeyDown={(e) => {
                  if (NAMED.has(e.key)) {
                    e.preventDefault()
                    send({ t: 'key', key: e.key })
                  }
                }}
                onChange={(e) => {
                  if (e.target.value) send({ t: 'text', text: e.target.value })
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                disabled={phase !== 'live'}
                onClick={() => {
                  setError(undefined)
                  setPhase('saving')
                  send({ t: 'done' })
                }}
              >
                {phase === 'saving' ? 'Saving...' : "I'm signed in"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
