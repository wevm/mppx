import type { Address, Client, Account as viem_Account } from 'viem'
import { parseAccount } from 'viem/accounts'

export type Account = viem_Account

export function getResolver(parameters: getResolver.Parameters = {}) {
  const { account: defaultAccount } = parameters

  return (
    client: Client,
    { account: override }: { account?: Account | Address | undefined } = {},
  ): Account => {
    const account = override ?? defaultAccount

    if (!account) {
      if (!client.account)
        throw new Error('No `account` provided. Pass `account` to parameters or context.')
      return client.account
    }

    return parseAccount(account)
  }
}

export declare namespace getResolver {
  type Parameters = {
    /** Account to use for signing. If an Address is provided, it must match the client's account. */
    account?: Account | Address | undefined
  }
}
