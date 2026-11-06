import 'server-only'
import Stripe from 'stripe'
import { billing } from './env'

let client: Stripe | undefined

/** The Stripe client, or undefined when selling AI applications is not configured. */
export function stripe(): Stripe | undefined {
  const b = billing()
  if (!b.enabled) return undefined
  return (client ??= new Stripe(b.secretKey!))
}
