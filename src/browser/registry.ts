import { BrowserError, type BrowserBackend, type BrowserSession, type LaunchOptions } from './types'

type Factory = () => BrowserBackend

/** Backends register by name. Config picks one per site type. */
export class BackendRegistry {
  private factories = new Map<string, Factory>()
  private instances = new Map<string, BrowserBackend>()

  register(name: string, factory: Factory): this {
    this.factories.set(name, factory)
    return this
  }

  has(name: string): boolean {
    return this.factories.has(name)
  }

  names(): string[] {
    return [...this.factories.keys()]
  }

  get(name: string): BrowserBackend {
    const existing = this.instances.get(name)
    if (existing) return existing
    const factory = this.factories.get(name)
    if (!factory) {
      throw new BrowserError(
        `Unknown browser backend "${name}". Registered: ${this.names().join(', ') || '(none)'}`,
        'launch',
      )
    }
    const backend = factory()
    this.instances.set(name, backend)
    return backend
  }

  async launch(name: string, options: LaunchOptions): Promise<BrowserSession> {
    return this.get(name).launch(options)
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.instances.values()].map((b) => b.dispose()))
    this.instances.clear()
  }
}

/**
 * Placeholder for the future agent-native browser (see ai-browser/). It is registered so that
 * routing, fallback and shadow runs can be exercised today. It always fails to launch.
 */
export class NotImplementedBackend implements BrowserBackend {
  constructor(readonly name: string) {}
  async launch(): Promise<BrowserSession> {
    throw new BrowserError(`Backend "${this.name}" is not implemented yet`, 'not_implemented')
  }
  async dispose(): Promise<void> {}
}
