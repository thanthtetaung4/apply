import type { JobStore } from './store'

/** Put a parked or failed job back in the queue. Used by the engine and by the web app. */
export async function retryJob(store: JobStore, jobId: string): Promise<void> {
  const app = await store.getApplication(jobId)
  if (!app) throw new Error(`Unknown job ${jobId}`)
  if (app.status === 'submitted') throw new Error('That application was already submitted')
  if (app.status === 'filling' || app.status === 'tailoring') throw new Error('That job is running right now')
  await store.setStatus(jobId, app.resumeArtifactId ? 'ready' : 'queued', { reason: null, attempts: 0 })
}
