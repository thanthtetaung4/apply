import type Stripe from 'stripe'
import { grantAiCredits } from '@apply/db'
import { db } from '@/lib/db'
import { billing } from '@/lib/env'
import { stripe } from '@/lib/stripe'

export const dynamic = 'force-dynamic'

/**
 * Stripe webhook. Grants AI applications when a Checkout payment completes. The signature is
 * checked on the raw body; a repeated event grants nothing more (keyed by the session id).
 */
export async function POST(req: Request) {
  const s = stripe()
  const secret = billing().webhookSecret
  if (!s || !secret) return new Response('billing is not configured', { status: 404 })

  const signature = req.headers.get('stripe-signature')
  if (!signature) return new Response('missing signature', { status: 400 })
  let event: Stripe.Event
  try {
    event = s.webhooks.constructEvent(await req.text(), signature, secret)
  } catch {
    return new Response('bad signature', { status: 400 })
  }

  // Card payments complete at once; some methods (bank debits) succeed later.
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const session = event.data.object
    if (session.mode === 'payment' && session.payment_status === 'paid') {
      const userId = session.metadata?.userId ?? session.client_reference_id
      const credits = Number(session.metadata?.credits)
      if (!userId || !Number.isInteger(credits) || credits <= 0)
        return new Response('session is missing the user or credits', { status: 400 })
      await grantAiCredits(db(), {
        userId,
        stripeSessionId: session.id,
        credits,
        amountCents: session.amount_total,
        currency: session.currency,
      })
    }
  }
  return Response.json({ received: true })
}
