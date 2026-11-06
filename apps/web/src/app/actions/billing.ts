'use server'

import { redirect } from 'next/navigation'
import { billing } from '@/lib/env'
import { requireUser } from '@/lib/session'
import { stripe } from '@/lib/stripe'

/** Send the user to Stripe Checkout for one pack of AI applications. */
export async function buyAiCreditsAction(): Promise<void> {
  const user = await requireUser()
  const s = stripe()
  const b = billing()
  if (!s) throw new Error('Buying AI applications is not available.')
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: b.priceId!, quantity: 1 }],
    client_reference_id: user.id,
    customer_email: user.email,
    // Read back by the webhook. Set here on the server, so the user cannot change it.
    metadata: { userId: user.id, credits: String(b.creditsPerPack) },
    success_url: `${b.appUrl}/settings?bought=1#ai`,
    cancel_url: `${b.appUrl}/settings#ai`,
  })
  if (!session.url) throw new Error('Stripe did not return a checkout page.')
  redirect(session.url)
}
