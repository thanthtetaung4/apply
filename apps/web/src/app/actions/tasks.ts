'use server'

import { revalidatePath } from 'next/cache'
import { retryJob } from '@apply/core/retry'
import { appendAnswer, validateProfileFile } from '@apply/core/profile'
import {
  ConflictError,
  enqueueRun,
  enqueueTask,
  getProfileFiles,
  listJobs,
  requestCancel,
  saveProfileFile,
} from '@apply/db'
import { db, jobStore } from '@/lib/db'
import { profileProblem } from '@/lib/preflight'
import { questionsFromReason } from '@/lib/format'
import { requireUser } from '@/lib/session'
import type { FormState } from '@/lib/state'

const refresh = () => {
  revalidatePath('/')
  revalidatePath('/jobs')
  revalidatePath('/needs-you')
}

export async function startIntakeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const problem = await profileProblem(user.id)
  if (problem) return { error: problem }
  const sources = fd
    .getAll('source')
    .map(String)
    .filter((s) => ['indeed', 'linkedin', 'glassdoor'].includes(s))
  const r = await enqueueTask(db(), user.id, 'intake', {
    thenRun: fd.get('thenRun') === 'on',
    ...(sources.length ? { sources } : {}),
  })
  refresh()
  return {
    ok: true,
    message: r.alreadyQueued
      ? 'A search is already waiting to run.'
      : 'Search queued. The worker will pick it up in a moment.',
  }
}

export async function startRunAction(): Promise<FormState> {
  const user = await requireUser()
  const problem = await profileProblem(user.id)
  if (problem) return { error: problem }
  const r = await enqueueRun(db(), user.id)
  refresh()
  return { ok: true, message: r.alreadyQueued ? 'A run is already waiting.' : 'Run queued.' }
}

export async function cancelTaskAction(taskId: string): Promise<void> {
  const user = await requireUser()
  await requestCancel(db(), user.id, taskId)
  refresh()
}

/** You looked at the filled form (screenshots) and want it submitted now. */
export async function approveJobAction(jobId: string): Promise<FormState> {
  const user = await requireUser()
  const problem = await profileProblem(user.id)
  if (problem) return { error: problem }
  try {
    await retryJob(jobStore(user.id), jobId)
    await enqueueRun(db(), user.id, { approveJobIds: [jobId] })
  } catch (err) {
    return { error: (err as Error).message }
  }
  refresh()
  revalidatePath(`/jobs/${jobId}`)
  return { ok: true, message: 'Approved. The worker will fill the form again and submit it.' }
}

export async function retryJobAction(jobId: string): Promise<FormState> {
  const user = await requireUser()
  try {
    await retryJob(jobStore(user.id), jobId)
    await enqueueRun(db(), user.id)
  } catch (err) {
    return { error: (err as Error).message }
  }
  refresh()
  revalidatePath(`/jobs/${jobId}`)
  return { ok: true, message: 'Queued again.' }
}

/** You applied on the site yourself. */
export async function markAppliedAction(jobId: string): Promise<FormState> {
  const user = await requireUser()
  const store = jobStore(user.id)
  const app = await store.getApplication(jobId)
  if (!app) return { error: 'Job not found.' }
  await store.setStatus(jobId, 'submitted', { reason: 'Applied by hand', finishedAt: new Date() })
  refresh()
  revalidatePath(`/jobs/${jobId}`)
  return { ok: true, message: 'Marked as applied.' }
}

export async function skipJobAction(jobId: string): Promise<FormState> {
  const user = await requireUser()
  const store = jobStore(user.id)
  if (!(await store.getApplication(jobId))) return { error: 'Job not found.' }
  await store.setStatus(jobId, 'skipped', { reason: 'Skipped by you' })
  refresh()
  revalidatePath(`/jobs/${jobId}`)
  return { ok: true, message: 'Skipped.' }
}

/**
 * Save an answer to answers.md, mark the question answered, put every job that was waiting on it
 * back in the queue, and start a run.
 */
export async function answerQuestionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const question = String(fd.get('question') ?? '')
  const answer = String(fd.get('answer') ?? '')
  try {
    const files = await getProfileFiles(db(), user.id)
    const next = appendAnswer(files.answers.content, question, answer)
    const v = validateProfileFile('answers', next)
    if (!v.ok) return { error: 'That answer breaks answers.md.', issues: v.issues }
    await saveProfileFile(db(), user.id, 'answers', next, files.answers.revision)
  } catch (err) {
    if (err instanceof ConflictError) return { error: err.message }
    return { error: (err as Error).message }
  }
  const store = jobStore(user.id)
  await store.markAnswered(question)
  const parked = await listJobs(db(), user.id, { status: 'needs_human', limit: 500 })
  let retried = 0
  for (const j of parked.rows) {
    if (j.blockKind === 'unknown_question' && questionsFromReason(j.error).includes(question)) {
      await retryJob(store, j.id)
      retried++
    }
  }
  if (retried > 0) await enqueueRun(db(), user.id)
  refresh()
  revalidatePath('/profile')
  return {
    ok: true,
    message: retried
      ? `Saved. ${retried} job${retried === 1 ? '' : 's'} queued again.`
      : 'Saved to your answers.',
  }
}

/** Queue job pages the user pasted (company career pages, Greenhouse, Lever, Ashby). */
export async function addLinksAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser()
  const problem = await profileProblem(user.id)
  if (problem) return { error: problem }
  const lines = String(fd.get('urls') ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const bad = lines.filter((l) => {
    try {
      return !/^https?:$/.test(new URL(l).protocol)
    } catch {
      return true
    }
  })
  if (lines.length === 0) return { error: 'Paste at least one job link.' }
  if (bad.length) return { error: 'These are not web links:', issues: bad.slice(0, 5) }
  if (lines.length > 20) return { error: 'Add at most 20 links at a time.' }
  const urls = [...new Set(lines)]
  const r = await enqueueTask(db(), user.id, 'intake', {
    urls,
    thenRun: fd.get('thenRun') === 'on',
  })
  refresh()
  return {
    ok: true,
    message: r.alreadyQueued
      ? 'A search is already waiting to run. Add the links again when it finishes.'
      : `${urls.length} link${urls.length === 1 ? '' : 's'} queued. The worker reads each job page, then applies if you chose that.`,
  }
}
