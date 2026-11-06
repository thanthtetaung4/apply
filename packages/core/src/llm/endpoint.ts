import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type Lookup = (host: string) => Promise<{ address: string }[]>

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true })

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast and reserved above
]

/** True for addresses a hosted server must never call on a user's behalf. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip)
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (n & mask) === (v4ToInt(base) & mask)
    })
  }
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped) return isPrivateAddress(mapped[1]!)
  return (
    a === '::' ||
    a === '::1' ||
    /^f[cd]/.test(a) || // unique local
    /^fe[89ab]/.test(a) || // link-local
    /^ff/.test(a) // multicast
  )
}

/**
 * Check a model server URL a user typed in. Returns a problem in plain words, or undefined.
 * Unless `allowPrivate` (self-hosted installs), the host must resolve only to public addresses,
 * so the worker cannot be pointed at its own network or the cloud metadata service.
 */
export async function endpointProblem(
  raw: string,
  options: { allowPrivate?: boolean; lookup?: Lookup } = {},
): Promise<string | undefined> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'Enter the full address, for example https://ollama.example.com/v1.'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'The address must start with https://.'
  if (url.username || url.password) return 'Put the key in the key field, not in the address.'
  if (options.allowPrivate) return undefined
  if (url.protocol !== 'https:') return 'The address must use https.'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return 'The app runs on a server and cannot reach your computer. Use a public tunnel address.'
  let addresses: string[]
  try {
    addresses = isIP(host)
      ? [host]
      : (await (options.lookup ?? defaultLookup)(host)).map((a) => a.address)
  } catch {
    return `Could not find ${host}. Check the address.`
  }
  if (addresses.length === 0) return `Could not find ${host}. Check the address.`
  if (addresses.some(isPrivateAddress))
    return 'That address points to a private network. Use a public tunnel address.'
  return undefined
}
