'use client'

export function SubmitButton({
  children,
  busy,
  pending: label,
  className,
}: {
  children: React.ReactNode
  busy?: boolean
  pending?: string
  className?: string
}) {
  return (
    <button type="submit" disabled={busy} className={className}>
      {busy ? (label ?? 'Working...') : children}
    </button>
  )
}
