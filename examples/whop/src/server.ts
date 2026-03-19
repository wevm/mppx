import { Mppx, whop } from 'mppx/server'

const apiKey = process.env.WHOP_API_KEY!
const companyId = process.env.WHOP_COMPANY_ID!

if (!apiKey) throw new Error('WHOP_API_KEY environment variable is required')
if (!companyId) throw new Error('WHOP_COMPANY_ID environment variable is required')

const mppx = Mppx.create({
  methods: [
    whop({
      apiKey,
      companyId,
      currency: 'usd',
    }),
  ],
})

// Track checkout sessions → payment IDs
const pendingCheckouts = new Map<string, { planId: string; paymentId?: string; createdAt: number }>()

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Free health check
  if (url.pathname === '/api/health') {
    return Response.json({ status: 'ok' })
  }

  // Paid fortune endpoint
  if (url.pathname === '/api/fortune') {
    const checkoutConfig = await createCheckoutConfig(apiKey, companyId, 1.0)

    // Store the session for polling
    const sessionTag = new URL(checkoutConfig.purchase_url).searchParams.get('session') ??
      checkoutConfig.id
    pendingCheckouts.set(sessionTag, {
      planId: checkoutConfig.plan_id ?? '',
      createdAt: Date.now(),
    })

    const result = await mppx.charge({
      amount: 1.0,
      meta: {
        purchase_url: checkoutConfig.purchase_url,
        session_id: sessionTag,
      },
    })(request)

    if (result.status === 402) return result.challenge

    const fortune = fortunes[Math.floor(Math.random() * fortunes.length)]!
    return result.withReceipt(Response.json({ fortune }))
  }

  // Poll endpoint — client checks if payment completed for a session
  if (url.pathname === '/api/check-payment') {
    const sessionId = url.searchParams.get('session')
    if (!sessionId) return Response.json({ error: 'session required' }, { status: 400 })

    const entry = pendingCheckouts.get(sessionId)
    if (!entry) return Response.json({ status: 'unknown' })

    // If we already found the payment, return it
    if (entry.paymentId) {
      return Response.json({ status: 'paid', paymentId: entry.paymentId })
    }

    // Poll Whop API for recent payments
    try {
      const res = await fetch(
        `https://api.whop.com/api/v1/payments?company_id=${companyId}&per=10`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      )
      if (res.ok) {
        const data = (await res.json()) as {
          data: Array<{ id: string; status: string; total: number; created_at: string }>
        }
        // Find a recent paid payment matching our amount
        for (const payment of data.data) {
          if (
            (payment.status === 'paid' || payment.status === 'succeeded') &&
            payment.total === 1.0 &&
            // Only consider payments created after our checkout
            new Date(payment.created_at).getTime() >= entry.createdAt - 5000
          ) {
            entry.paymentId = payment.id
            return Response.json({ status: 'paid', paymentId: payment.id })
          }
        }
      }
    } catch {
      // Polling failed, client will retry
    }

    return Response.json({ status: 'pending' })
  }

  return null
}

async function createCheckoutConfig(apiKey: string, companyId: string, amount: number) {
  const response = await fetch('https://api.whop.com/api/v1/checkout_configurations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      plan: {
        initial_price: amount,
        plan_type: 'one_time',
        currency: 'usd',
        company_id: companyId,
      },
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to create checkout config: ${error}`)
  }

  return (await response.json()) as { id: string; purchase_url: string; plan_id?: string }
}

const fortunes = [
  'A beautiful, smart, and loving person will come into your life.',
  'A dubious friend may be an enemy in camouflage.',
  'A faithful friend is a strong defense.',
  'A fresh start will put you on your way.',
  'A golden egg of opportunity falls into your lap this month.',
  'A good time to finish up old tasks.',
  'A hunch is creativity trying to tell you something.',
  'A lifetime of happiness lies ahead of you.',
  'A light heart carries you through all the hard times.',
  'A new perspective will come with the new year.',
]
