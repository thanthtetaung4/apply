import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp, type App, type AppOptions } from '../../src/app'
import { loadConfig } from '../../src/config/load'
import type { AppConfig } from '../../src/config/schema'
import { demoConfig } from '../../src/demo/config'
import { startMockServer, type MockServer } from '../../src/demo/mock-server'

export const ROOT = resolve(__dirname, '../..')

export interface TestEnv {
  server: MockServer
  config: AppConfig
  outRoot: string
  app: App
  close(): Promise<void>
}

/** A full app wired to the local mock sites in a fresh temp folder. */
export async function makeEnv(
  tweak: (c: AppConfig) => AppConfig = (c) => c,
  options: AppOptions = {},
): Promise<TestEnv> {
  const outRoot = mkdtempSync(join(tmpdir(), 'aa-env-'))
  cpSync(join(ROOT, 'demo', 'profile'), join(outRoot, 'profile'), { recursive: true })
  const server = await startMockServer()
  const config = tweak(demoConfig(loadConfig({ root: ROOT, env: {} }), server.url, outRoot))
  const app = await createApp(config, options)
  return {
    server,
    config,
    outRoot,
    app,
    async close() {
      await app.close()
      await server.close()
    },
  }
}
