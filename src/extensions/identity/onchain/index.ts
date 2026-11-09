/**
 * Onchain identity: a payment check that requires the payer's address to be allowed by an
 * onchain registry, such as a KYC allowlist contract or Coinbase Verifications on Base.
 *
 * The payer is the address in the Credential's `source` (`did:pkh:eip155:<chainId>:<address>`).
 * The check runs on the paid retry before settlement, and the payment method's own verification
 * then rejects a Credential whose `source` is not the account that signed or sent the payment, so
 * a payer cannot claim an allowed address it does not control. The client needs no prover.
 */
/** Server helpers that check the payer against an onchain registry. */
export * as Server from './server/index.js'
export * from './Constants.js'
export type * from './Types.js'
