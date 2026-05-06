import { Errors, z } from 'incur'
import { createClient, erc20Abi, http, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readContract } from 'viem/actions'

import { charge as evmCharge } from '../../evm/client/index.js'
import { createKeychain, resolveAccountName } from '../account.js'
import { resolveChain, resolveRpcUrl } from '../utils.js'
import { createPlugin } from './plugin.js'

export function evm() {
  return createPlugin({
    method: 'evm',
    supports(challenge) {
      return challenge.method === 'evm' && challenge.intent === 'charge'
    },

    async setup({ challenge, options, methodOpts }) {
      const accountName = resolveAccountName(options.account)
      const privateKey =
        process.env.MPPX_PRIVATE_KEY?.trim() || (await createKeychain(accountName).get())
      if (!privateKey)
        throw new Errors.IncurError({
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account "${accountName}" not found.`,
          exitCode: 69,
        })

      const evmOpts = parseOptions(
        z.object({
          credentialType: z.optional(z.enum(['permit2', 'authorization', 'transaction', 'hash'])),
          permit2Deadline: z.optional(z.coerce.bigint()),
          permit2Nonce: z.optional(z.coerce.bigint()),
        }),
        methodOpts,
      )
      const rpcUrl = resolveRpcUrl(options.rpcUrl)
      const chain = await resolveChain({ rpcUrl })
      const client = createClient({ chain, transport: http(rpcUrl) })
      const account = privateKeyToAccount(privateKey as `0x${string}`)
      const challengeRequest = challenge.request as Record<string, unknown>
      const currency = challengeRequest.currency as Address | undefined
      const explorerUrl = chain.blockExplorers?.default?.url
      const metadata = currency
        ? await fetchErc20Metadata(client, currency).catch(() => undefined)
        : undefined
      const advertised =
        (challengeRequest.methodDetails as { credentialTypes?: readonly string[] } | undefined)
          ?.credentialTypes ?? []
      const credentialType =
        evmOpts.credentialType ??
        (advertised.includes('transaction')
          ? 'transaction'
          : advertised.includes('hash')
            ? 'hash'
            : advertised.includes('permit2')
              ? 'permit2'
              : undefined)

      return {
        tokenSymbol: metadata?.symbol ?? currency ?? '',
        tokenDecimals:
          metadata?.decimals ?? (challengeRequest.decimals as number | undefined) ?? 18,
        explorerUrl,
        methods: [
          evmCharge({
            account,
            credentialType,
            getClient: () => client,
            permit2:
              evmOpts.permit2Nonce !== undefined || evmOpts.permit2Deadline !== undefined
                ? {
                    ...(evmOpts.permit2Deadline !== undefined && {
                      deadline: evmOpts.permit2Deadline,
                    }),
                    ...(evmOpts.permit2Nonce !== undefined && { nonce: evmOpts.permit2Nonce }),
                  }
                : undefined,
          }),
        ],
        credentialContext: credentialType ? { credentialType } : undefined,
      }
    },
  })
}

async function fetchErc20Metadata(client: ReturnType<typeof createClient>, token: Address) {
  const [symbol, decimals] = await Promise.all([
    readContract(client, { abi: erc20Abi, address: token, functionName: 'symbol' }),
    readContract(client, { abi: erc20Abi, address: token, functionName: 'decimals' }),
  ])
  return { symbol, decimals }
}

function parseOptions<const schema extends z.ZodType>(
  schema: schema,
  rawOptions: unknown,
): z.output<schema> {
  const result = schema.safeParse(rawOptions ?? {})
  if (result.success) return result.data
  const summary = result.error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'options'
      return `${path}: ${issue.message}`
    })
    .join(', ')
  throw new Error(`Invalid CLI options (${summary})`)
}
