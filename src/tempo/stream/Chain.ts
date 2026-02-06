import { type Address, type Hex, type PublicClient, createPublicClient, http } from 'viem'

/**
 * Minimal ABI for the TempoStreamChannel escrow contract.
 * Only includes the functions needed for server-side verification.
 */
const escrowAbi = [
	{
		type: 'function',
		name: 'getChannel',
		inputs: [{ name: 'channelId', type: 'bytes32' }],
		outputs: [
			{
				name: '',
				type: 'tuple',
				components: [
					{ name: 'payer', type: 'address' },
					{ name: 'payee', type: 'address' },
					{ name: 'token', type: 'address' },
					{ name: 'authorizedSigner', type: 'address' },
					{ name: 'deposit', type: 'uint128' },
					{ name: 'settled', type: 'uint128' },
					{ name: 'closeRequestedAt', type: 'uint64' },
					{ name: 'finalized', type: 'bool' },
				],
			},
		],
		stateMutability: 'view',
	},
] as const

/**
 * On-chain channel state from the escrow contract.
 */
export interface OnChainChannel {
	payer: Address
	payee: Address
	token: Address
	authorizedSigner: Address
	deposit: bigint
	settled: bigint
	closeRequestedAt: bigint
	finalized: boolean
}

const clientCache = new Map<string, PublicClient>()

/**
 * Get or create a cached public client for the given RPC URL.
 */
export function getChainClient(rpcUrl: string): PublicClient {
	let client = clientCache.get(rpcUrl)
	if (!client) {
		client = createPublicClient({ transport: http(rpcUrl) })
		clientCache.set(rpcUrl, client)
	}
	return client
}

/**
 * Read channel state from the escrow contract.
 */
export async function getOnChainChannel(
	rpcUrl: string,
	escrowContract: Address,
	channelId: Hex,
): Promise<OnChainChannel> {
	const client = getChainClient(rpcUrl)
	return client.readContract({
		address: escrowContract,
		abi: escrowAbi,
		functionName: 'getChannel',
		args: [channelId],
	}) as Promise<OnChainChannel>
}

/**
 * Verify a topUp by re-reading on-chain channel state.
 *
 * The txHash is treated as informational only — we don't try to prove it
 * caused this channel's deposit increase, since that would require decoding
 * tx input/logs. Instead, we simply verify the on-chain deposit increased
 * and the channel is still valid.
 */
export async function verifyTopUpTransaction(
	rpcUrl: string,
	escrowContract: Address,
	channelId: Hex,
	_txHash: Hex,
	previousDeposit: bigint,
): Promise<{ deposit: bigint }> {
	const channel = await getOnChainChannel(rpcUrl, escrowContract, channelId)

	if (channel.finalized) {
		throw new Error('Channel is finalized on-chain')
	}

	if (channel.deposit <= previousDeposit) {
		throw new Error('Channel deposit did not increase')
	}

	return { deposit: channel.deposit }
}
