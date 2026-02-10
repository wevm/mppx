import type { Account } from 'viem'

export type DeriveDefaults<parameters, defaults> = Pick<
  parameters,
  Extract<keyof parameters, keyof defaults>
> &
  (parameters extends { recipient: Account | string } ? { recipient: string } : {})

export type FeePayerParameters =
  | {
      /** Recipient account. Address is used as the payment recipient. */
      recipient?: Account | undefined
      /** When true, the recipient account also sponsors (pays) transaction fees. */
      feePayer?: true | undefined
    }
  | {
      /** Address that receives payment. */
      recipient?: string | undefined
      /** Optional fee payer account for covering transaction fees. */
      feePayer?: Account | undefined
    }
