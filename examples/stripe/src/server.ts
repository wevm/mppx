import { Mppx, stripe } from 'mppx/server'
import Stripe from 'stripe'

const secretKey = process.env.VITE_STRIPE_SECRET_KEY!
const stripeClient = new Stripe(secretKey)

//
const mppx = Mppx.create({
  methods: [
    stripe.charge({
      client: stripeClient,
      html: {
        createTokenUrl: '/api/create-spt',
        elements: {
          options: {},
          paymentOptions: {
            fields: {
              billingDetails: { address: { postalCode: 'never', country: 'never' } },
            },
          },
          createPaymentMethodOptions: {
            params: {
              billing_details: {
                address: { postal_code: '10001', country: 'US' },
              },
            },
          },
        },
        publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY!,
        text: {
          title: 'MPP Payment Required',
        },
        theme: {
          logo: {
            dark: 'data:image/svg+xml,%3Csvg%20width%3D%22184%22%20height%3D%2241%22%20viewBox%3D%220%200%20184%2041%22%20fill%3D%22none%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%0A%3Cpath%20d%3D%22M13.6424%2040.3635H2.80251L12.8492%209.60026H0L2.80251%200.58344H38.6006L35.7981%209.60026H23.6362L13.6424%2040.3635Z%22%20fill%3D%22white%22/%3E%0A%3Cpath%20d%3D%22M53.9809%2040.3635H28.2824L41.1846%200.58344H66.7773L64.3449%208.16818H49.4863L46.7896%2016.7076H61.1723L58.7399%2024.1863H44.3043L41.6076%2032.7788H56.3604L53.9809%2040.3635Z%22%20fill%3D%22white%22/%3E%0A%3Cpath%20d%3D%22M65.6123%2040.3635H56.9933L69.9483%200.58344H84.331L83.8551%2022.0647L97.8676%200.58344H113.625L100.723%2040.3635H89.936L98.5021%2013.6313H98.3435L80.7353%2040.3635H74.3371L74.6015%2013.3131H74.4957L65.6123%2040.3635Z%22%20fill%3D%22white%22/%3E%0A%3Cpath%20d%3D%22M125.758%207.95602L121.581%2020.7917H122.744C125.388%2020.7917%20127.592%2020.1729%20129.354%2018.9353C131.117%2017.6624%20132.262%2015.859%20132.791%2013.5252C133.249%2011.5097%20133.003%2010.0776%20132.051%209.22898C131.099%208.38034%20129.513%207.95602%20127.292%207.95602H125.758ZM115.289%2040.3635H104.449L117.351%200.58344H130.517C133.549%200.58344%20136.158%201.07848%20138.343%202.06856C140.564%203.02328%20142.186%204.40233%20143.208%206.20569C144.266%207.97369%20144.618%2010.0423%20144.266%2012.4114C143.807%2015.5231%20142.609%2018.2635%20140.67%2020.6326C138.731%2023.0017%20136.211%2024.8405%20133.108%2026.1488C130.042%2027.4217%20126.604%2028.0582%20122.797%2028.0582H119.255L115.289%2040.3635Z%22%20fill%3D%22white%22/%3E%0A%3Cpath%20d%3D%22M170.103%2037.8176C166.507%2039.9392%20162.682%2041%20158.628%2041H158.523C154.927%2041%20151.895%2040.2044%20149.428%2038.6132C146.995%2036.9866%20145.25%2034.7943%20144.193%2032.0362C143.171%2029.2781%20142.924%2026.2549%20143.453%2022.9664C144.122%2018.8292%20145.656%2015.0103%20148.053%2011.5097C150.45%208.00906%20153.446%205.21561%20157.042%203.12937C160.638%201.04312%20164.48%200%20168.569%200H168.675C172.412%200%20175.496%200.795602%20177.929%202.38681C180.396%203.97801%20182.106%206.15265%20183.058%208.91074C184.045%2011.6335%20184.256%2014.6921%20183.692%2018.0867C183.023%2022.0824%20181.489%2025.8482%20179.092%2029.3842C176.695%2032.8849%20173.699%2035.696%20170.103%2037.8176ZM155.138%2030.9754C156.09%2032.7788%20157.747%2033.6805%20160.109%2033.6805H160.215C162.154%2033.6805%20163.951%2032.9556%20165.608%2031.5058C167.3%2030.0207%20168.728%2028.0405%20169.891%2025.5653C171.09%2023.0901%20171.971%2020.332%20172.535%2017.2911C173.064%2014.3208%20172.852%2011.934%20171.901%2010.1307C170.949%208.29194%20169.31%207.37257%20166.983%207.37257H166.877C165.079%207.37257%20163.335%208.11514%20161.642%209.60026C159.986%2011.0854%20158.54%2013.0832%20157.306%2015.5938C156.073%2018.1044%20155.174%2020.8271%20154.61%2023.762C154.046%2026.7322%20154.222%2029.1367%20155.138%2030.9754Z%22%20fill%3D%22white%22/%3E%0A%3C/svg%3E',
            light:
              'data:image/svg+xml,%3Csvg%20width%3D%22184%22%20height%3D%2241%22%20viewBox%3D%220%200%20184%2041%22%20fill%3D%22none%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%0A%3Cpath%20d%3D%22M13.6424%2040.3635H2.80251L12.8492%209.60026H0L2.80251%200.58344H38.6006L35.7981%209.60026H23.6362L13.6424%2040.3635Z%22%20fill%3D%22black%22/%3E%0A%3Cpath%20d%3D%22M53.9809%2040.3635H28.2824L41.1846%200.58344H66.7773L64.3449%208.16818H49.4863L46.7896%2016.7076H61.1723L58.7399%2024.1863H44.3043L41.6076%2032.7788H56.3604L53.9809%2040.3635Z%22%20fill%3D%22black%22/%3E%0A%3Cpath%20d%3D%22M65.6123%2040.3635H56.9933L69.9483%200.58344H84.331L83.8551%2022.0647L97.8676%200.58344H113.625L100.723%2040.3635H89.936L98.5021%2013.6313H98.3435L80.7353%2040.3635H74.3371L74.6015%2013.3131H74.4957L65.6123%2040.3635Z%22%20fill%3D%22black%22/%3E%0A%3Cpath%20d%3D%22M125.758%207.95602L121.581%2020.7917H122.744C125.388%2020.7917%20127.592%2020.1729%20129.354%2018.9353C131.117%2017.6624%20132.262%2015.859%20132.791%2013.5252C133.249%2011.5097%20133.003%2010.0776%20132.051%209.22898C131.099%208.38034%20129.513%207.95602%20127.292%207.95602H125.758ZM115.289%2040.3635H104.449L117.351%200.58344H130.517C133.549%200.58344%20136.158%201.07848%20138.343%202.06856C140.564%203.02328%20142.186%204.40233%20143.208%206.20569C144.266%207.97369%20144.618%2010.0423%20144.266%2012.4114C143.807%2015.5231%20142.609%2018.2635%20140.67%2020.6326C138.731%2023.0017%20136.211%2024.8405%20133.108%2026.1488C130.042%2027.4217%20126.604%2028.0582%20122.797%2028.0582H119.255L115.289%2040.3635Z%22%20fill%3D%22black%22/%3E%0A%3Cpath%20d%3D%22M170.103%2037.8176C166.507%2039.9392%20162.682%2041%20158.628%2041H158.523C154.927%2041%20151.895%2040.2044%20149.428%2038.6132C146.995%2036.9866%20145.25%2034.7943%20144.193%2032.0362C143.171%2029.2781%20142.924%2026.2549%20143.453%2022.9664C144.122%2018.8292%20145.656%2015.0103%20148.053%2011.5097C150.45%208.00906%20153.446%205.21561%20157.042%203.12937C160.638%201.04312%20164.48%200%20168.569%200H168.675C172.412%200%20175.496%200.795602%20177.929%202.38681C180.396%203.97801%20182.106%206.15265%20183.058%208.91074C184.045%2011.6335%20184.256%2014.6921%20183.692%2018.0867C183.023%2022.0824%20181.489%2025.8482%20179.092%2029.3842C176.695%2032.8849%20173.699%2035.696%20170.103%2037.8176ZM155.138%2030.9754C156.09%2032.7788%20157.747%2033.6805%20160.109%2033.6805H160.215C162.154%2033.6805%20163.951%2032.9556%20165.608%2031.5058C167.3%2030.0207%20168.728%2028.0405%20169.891%2025.5653C171.09%2023.0901%20171.971%2020.332%20172.535%2017.2911C173.064%2014.3208%20172.852%2011.934%20171.901%2010.1307C170.949%208.29194%20169.31%207.37257%20166.983%207.37257H166.877C165.079%207.37257%20163.335%208.11514%20161.642%209.60026C159.986%2011.0854%20158.54%2013.0832%20157.306%2015.5938C156.073%2018.1044%20155.174%2020.8271%20154.61%2023.762C154.046%2026.7322%20154.222%2029.1367%20155.138%2030.9754Z%22%20fill%3D%22black%22/%3E%0A%3C/svg%3E',
          },
        },
      },
      // Stripe Business Network profile ID.
      networkId: 'internal',
      // Ensure only card is supported.
      paymentMethodTypes: ['card'],
    }),
  ],
})

// Handles creating an SPT and charging a customer.
// In production examples, this would be a DIFFERENT server than
// the one that handles the HTTP 402 flow.
export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/create-spt') {
    const { paymentMethod, amount, currency, expiresAt, networkId, metadata } =
      (await request.json()) as {
        paymentMethod: string
        amount: string
        currency: string
        expiresAt: number
        networkId?: string
        metadata?: Record<string, string>
      }

    if (metadata?.externalId) {
      return Response.json(
        { error: 'metadata.externalId is reserved; use credential externalId instead' },
        { status: 400 },
      )
    }

    const body = new URLSearchParams({
      payment_method: paymentMethod,
      'usage_limits[currency]': currency,
      'usage_limits[max_amount]': amount,
      'usage_limits[expires_at]': expiresAt.toString(),
    })
    if (networkId) body.set('seller_details[network_id]', networkId)
    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        body.set(`metadata[${key}]`, value)
      }
    }

    // Test-only endpoint; production SPT flow uses the agent-side issued_tokens API.
    const createSpt = async (bodyParams: URLSearchParams) =>
      fetch('https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${secretKey}:`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams,
      })

    let response = await createSpt(body)
    if (!response.ok) {
      const error = (await response.json()) as { error: { message: string } }
      if ((metadata || networkId) && error.error.message.includes('Received unknown parameter')) {
        const fallbackBody = new URLSearchParams({
          payment_method: paymentMethod,
          'usage_limits[currency]': currency,
          'usage_limits[max_amount]': amount,
          'usage_limits[expires_at]': expiresAt.toString(),
        })
        response = await createSpt(fallbackBody)
      } else {
        return Response.json({ error: error.error.message }, { status: 500 })
      }
    }

    if (!response.ok) {
      const error = (await response.json()) as { error: { message: string } }
      return Response.json({ error: error.error.message }, { status: 500 })
    }

    const { id: spt } = (await response.json()) as { id: string }
    return Response.json({ spt })
  }

  if (url.pathname === '/api/fortune') {
    const result = await mppx.charge({
      amount: '1',
      currency: 'usd',
      decimals: 2,
    })(request)

    if (result.status === 402) return result.challenge

    const fortune = fortunes[Math.floor(Math.random() * fortunes.length)]!
    return result.withReceipt(Response.json({ fortune }))
  }

  return null
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
