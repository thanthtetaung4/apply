'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/** Re-reads the page data every few seconds while work is in progress. */
export function AutoRefresh({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => router.refresh(), everyMs)
    return () => clearInterval(t)
  }, [active, everyMs, router])
  return null
}
