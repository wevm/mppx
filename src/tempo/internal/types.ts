import type { Account } from 'viem'

export type DeriveDefaults<parameters, defaults> = Pick<
  parameters,
  Extract<keyof parameters, keyof defaults>
> &
  (parameters extends { recipient: Account | string } ? { recipient: string } : {})
