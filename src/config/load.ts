import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ConfigSchema, type AppConfig } from './schema'

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}\n${issues.map((i) => `  - ${i}`).join('\n')}` : message)
    this.name = 'ConfigError'
  }
}

export interface LoadConfigOptions {
  /** Project root. Relative paths in the config resolve against it. */
  root?: string
  /** Config file path, relative to root unless absolute. */
  file?: string
  env?: Record<string, string | undefined>
}

type RawConfig = Record<string, unknown>

function applyEnvOverrides(raw: RawConfig, env: Record<string, string | undefined>): RawConfig {
  const out: RawConfig = { ...raw }
  if (env.APPLY_WORKERS) {
    const n = Number(env.APPLY_WORKERS)
    if (!Number.isFinite(n))
      throw new ConfigError(`APPLY_WORKERS is not a number: ${env.APPLY_WORKERS}`)
    out.workers = n
  }
  if (env.APPLY_PROFILE_DIR) out.profileDir = env.APPLY_PROFILE_DIR
  if (env.BOARD_MCP_URL) {
    out.board = { ...((raw.board as RawConfig | undefined) ?? {}), url: env.BOARD_MCP_URL }
  }
  return out
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const root = resolve(options.root ?? process.cwd())
  const file = options.file ?? 'config/default.yaml'
  const path = isAbsolute(file) ? file : resolve(root, file)
  const env = options.env ?? process.env

  let raw: RawConfig = {}
  if (existsSync(path)) {
    try {
      const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object') raw = parsed as RawConfig
    } catch (err) {
      throw new ConfigError(`Could not parse ${path}: ${(err as Error).message}`)
    }
  } else if (options.file) {
    throw new ConfigError(`Config file not found: ${path}`)
  }

  const result = ConfigSchema.safeParse(applyEnvOverrides(raw, env))
  if (!result.success) {
    throw new ConfigError(
      `Invalid config (${path})`,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    )
  }

  const cfg = result.data
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p))
  return {
    ...cfg,
    profileDir: abs(cfg.profileDir),
    dataDir: abs(cfg.dataDir),
    outputDir: abs(cfg.outputDir),
    sessionsDir: abs(cfg.sessionsDir),
  }
}
