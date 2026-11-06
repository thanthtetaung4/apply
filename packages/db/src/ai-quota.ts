import { and, eq, gt, gte, sql } from 'drizzle-orm'
import type { Db } from './client'
import { aiCreditPurchases, aiCredits, platformAiJobs } from './schema'

/** Start of the current quota week: Monday 00:00 UTC. */
export function aiWeekStart(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const sinceMonday = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - sinceMonday)
  return d
}

export interface AiQuota {
  freeUsed: number
  freeLimit: number
  credits: number
  /** When the weekly free allowance starts again. */
  resetsAt: Date
}

export async function getAiQuota(
  db: Db,
  userId: string,
  freePerWeek: number,
  now = new Date(),
): Promise<AiQuota> {
  const start = aiWeekStart(now)
  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(platformAiJobs)
    .where(
      and(
        eq(platformAiJobs.userId, userId),
        eq(platformAiJobs.source, 'free'),
        gte(platformAiJobs.at, start),
      ),
    )
  const [bal] = await db
    .select({ balance: aiCredits.balance })
    .from(aiCredits)
    .where(eq(aiCredits.userId, userId))
  return {
    freeUsed: used?.n ?? 0,
    freeLimit: freePerWeek,
    credits: bal?.balance ?? 0,
    resetsAt: new Date(start.getTime() + 7 * 24 * 3600 * 1000),
  }
}

/**
 * May this job use the app's own model? A job already counted is always allowed. Otherwise it
 * takes one of this week's free applications, then one purchased credit. Runs under a per-user
 * lock so parallel browsers cannot spend the same free slot or credit twice.
 */
export async function admitPlatformAiJob(
  db: Db,
  userId: string,
  jobId: string,
  freePerWeek: number,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'ai-quota:' + userId}))`)
    const [seen] = await tx
      .select({ jobId: platformAiJobs.jobId })
      .from(platformAiJobs)
      .where(and(eq(platformAiJobs.userId, userId), eq(platformAiJobs.jobId, jobId)))
    if (seen) return true

    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(platformAiJobs)
      .where(
        and(
          eq(platformAiJobs.userId, userId),
          eq(platformAiJobs.source, 'free'),
          gte(platformAiJobs.at, aiWeekStart(now)),
        ),
      )
    if ((used?.n ?? 0) < freePerWeek) {
      await tx.insert(platformAiJobs).values({ userId, jobId, source: 'free', at: now })
      return true
    }

    const spent = await tx
      .update(aiCredits)
      .set({ balance: sql`${aiCredits.balance} - 1`, updatedAt: now })
      .where(and(eq(aiCredits.userId, userId), gt(aiCredits.balance, 0)))
      .returning({ balance: aiCredits.balance })
    if (spent.length === 0) return false
    await tx.insert(platformAiJobs).values({ userId, jobId, source: 'credit', at: now })
    return true
  })
}

/**
 * Add purchased credits once per Stripe Checkout session. Returns false when this session was
 * already granted (Stripe retries webhooks).
 */
export async function grantAiCredits(
  db: Db,
  p: {
    userId: string
    stripeSessionId: string
    credits: number
    amountCents?: number | null
    currency?: string | null
  },
): Promise<boolean> {
  if (!Number.isInteger(p.credits) || p.credits <= 0) throw new Error('credits must be positive')
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(aiCreditPurchases)
      .values({
        userId: p.userId,
        stripeSessionId: p.stripeSessionId,
        credits: p.credits,
        amountCents: p.amountCents ?? null,
        currency: p.currency ?? null,
      })
      .onConflictDoNothing({ target: aiCreditPurchases.stripeSessionId })
      .returning({ id: aiCreditPurchases.id })
    if (inserted.length === 0) return false
    await tx
      .insert(aiCredits)
      .values({ userId: p.userId, balance: p.credits })
      .onConflictDoUpdate({
        target: aiCredits.userId,
        set: { balance: sql`${aiCredits.balance} + ${p.credits}`, updatedAt: new Date() },
      })
    return true
  })
}
