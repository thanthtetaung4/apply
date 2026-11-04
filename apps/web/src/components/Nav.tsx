'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/needs-you', label: 'Needs you', badge: true },
  { href: '/jobs', label: 'Jobs' },
  { href: '/profile', label: 'Profile' },
  { href: '/files', label: 'Files' },
  { href: '/connections', label: 'Connections' },
  { href: '/settings', label: 'Settings' },
  { href: '/report', label: 'Report' },
]

export function Nav({ needsYou }: { needsYou: number }) {
  const path = usePathname()
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => {
        const active = i.href === '/' ? path === '/' : path.startsWith(i.href)
        return (
          <Link
            key={i.href}
            href={i.href}
            className={active ? 'active' : ''}
            aria-current={active ? 'page' : undefined}
          >
            <span>{i.label}</span>
            {i.badge && needsYou > 0 && <span className="badge">{needsYou}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
