import type { NextConfig } from 'next'

const config: NextConfig = {
  // The workspace packages ship TypeScript source.
  transpilePackages: ['@apply/core', '@apply/db'],
  // Keep Node-only drivers out of the bundle.
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

export default config
