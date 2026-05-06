import type { Address } from 'viem'

import * as Method from '../Method.js'
import * as z from '../zod.js'
import * as Charge_internal from './internal/charge.js'
import { credentialTypes, permit2Address } from './internal/constants.js'

export { credentialTypes, permit2Address }
export type CredentialType = Charge_internal.CredentialType

const credentialType = z.enum(credentialTypes)

const split = z.object({
  amount: z.amount(),
  memo: z.optional(z.string().check(z.maxLength(256))),
  recipient: z.pipe(
    z.address(),
    z.transform((v) => v as Address),
  ),
})

const permitted = z.object({
  amount: z.amount(),
  token: z.pipe(
    z.address(),
    z.transform((v) => v as Address),
  ),
})

const transferDetail = z.object({
  requestedAmount: z.amount(),
  to: z.pipe(
    z.address(),
    z.transform((v) => v as Address),
  ),
})

/**
 * EVM charge intent for one-time ERC-20 token transfers.
 *
 * @see https://datatracker.ietf.org/doc/draft-evm-charge/
 */
export const charge = Method.from({
  name: 'evm',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        z.object({
          permit: z.object({
            deadline: z.amount(),
            nonce: z.amount(),
            permitted: z.array(permitted).check(z.minLength(1)),
          }),
          signature: z.signature(),
          transferDetails: z.array(transferDetail).check(z.minLength(1)),
          type: z.literal('permit2'),
          witness: z.object({
            challengeHash: z.hash(),
          }),
        }),
        z.object({
          from: z.pipe(
            z.address(),
            z.transform((v) => v as Address),
          ),
          nonce: z.hash(),
          signature: z.signature(),
          to: z.pipe(
            z.address(),
            z.transform((v) => v as Address),
          ),
          type: z.literal('authorization'),
          validAfter: z.amount(),
          validBefore: z.amount(),
          value: z.amount(),
        }),
        z.object({ signature: z.signature(), type: z.literal('transaction') }),
        z.object({ hash: z.hash(), type: z.literal('hash') }),
      ]),
    },
    request: z.pipe(
      z
        .object({
          amount: z.amount(),
          chainId: z.optional(z.number()),
          credentialTypes: z.optional(z.array(credentialType).check(z.minLength(1))),
          currency: z.pipe(
            z.address(),
            z.transform((v) => v as Address),
          ),
          decimals: z.optional(z.number()),
          description: z.optional(z.string()),
          externalId: z.optional(z.string()),
          permit2Address: z.optional(
            z.pipe(
              z.address(),
              z.transform((v) => v as Address),
            ),
          ),
          recipient: z.pipe(
            z.address(),
            z.transform((v) => v as Address),
          ),
          spender: z.optional(
            z.pipe(
              z.address(),
              z.transform((v) => v as Address),
            ),
          ),
          splits: z.optional(z.array(split).check(z.minLength(1), z.maxLength(10))),
        })
        .check(
          z.refine(({ amount, decimals, splits }) => {
            if (!splits) return true
            const totalAmount = BigInt(Charge_internal.amountToBaseUnits(amount, decimals))
            const splitTotal = splits.reduce(
              (sum, split) =>
                sum + BigInt(Charge_internal.amountToBaseUnits(split.amount, decimals)),
              0n,
            )
            return (
              splits.every(
                (split) => BigInt(Charge_internal.amountToBaseUnits(split.amount, decimals)) > 0n,
              ) && splitTotal < totalAmount
            )
          }, 'Invalid splits'),
        ),
      z.transform(
        ({
          amount,
          chainId,
          credentialTypes,
          decimals,
          permit2Address: permit2Address_,
          spender,
          splits,
          ...rest
        }) => {
          const encodedSplits = splits?.map((split) => ({
            ...split,
            amount: Charge_internal.amountToBaseUnits(split.amount, decimals),
          }))
          const methodDetails =
            chainId !== undefined ||
            credentialTypes !== undefined ||
            decimals !== undefined ||
            permit2Address_ !== undefined ||
            spender !== undefined ||
            encodedSplits !== undefined
              ? {
                  ...(chainId !== undefined && { chainId }),
                  ...(credentialTypes !== undefined && { credentialTypes }),
                  ...(decimals !== undefined && { decimals }),
                  permit2Address: permit2Address_ ?? permit2Address,
                  ...(spender !== undefined && { spender }),
                  ...(encodedSplits !== undefined && { splits: encodedSplits }),
                }
              : undefined

          return {
            ...rest,
            amount: Charge_internal.amountToBaseUnits(amount, decimals),
            ...(methodDetails !== undefined && { methodDetails }),
          }
        },
      ),
    ),
  },
})
