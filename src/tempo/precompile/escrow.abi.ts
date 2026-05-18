const channelDescriptorComponents = [
  { name: 'payer', type: 'address' },
  { name: 'payee', type: 'address' },
  { name: 'operator', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'salt', type: 'bytes32' },
  { name: 'authorizedSigner', type: 'address' },
  { name: 'expiringNonceHash', type: 'bytes32' },
] as const

const channelStateComponents = [
  { name: 'settled', type: 'uint96' },
  { name: 'deposit', type: 'uint96' },
  { name: 'closeRequestedAt', type: 'uint32' },
] as const

const channelDescriptorInput = {
  name: 'descriptor',
  type: 'tuple',
  components: channelDescriptorComponents,
} as const

/** ABI for the TIP-1034 TIP-20 Channel Escrow precompile. */
export const escrowAbi = [
  {
    type: 'function',
    name: 'CLOSE_GRACE_PERIOD',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'VOUCHER_TYPEHASH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'open',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'operator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'deposit', type: 'uint96' },
      { name: 'salt', type: 'bytes32' },
      { name: 'authorizedSigner', type: 'address' },
    ],
    outputs: [{ name: 'channelId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      channelDescriptorInput,
      { name: 'cumulativeAmount', type: 'uint96' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'topUp',
    stateMutability: 'nonpayable',
    inputs: [channelDescriptorInput, { name: 'additionalDeposit', type: 'uint96' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'close',
    stateMutability: 'nonpayable',
    inputs: [
      channelDescriptorInput,
      { name: 'cumulativeAmount', type: 'uint96' },
      { name: 'captureAmount', type: 'uint96' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'requestClose',
    stateMutability: 'nonpayable',
    inputs: [channelDescriptorInput],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [channelDescriptorInput],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getChannel',
    stateMutability: 'view',
    inputs: [channelDescriptorInput],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'descriptor', type: 'tuple', components: channelDescriptorComponents },
          { name: 'state', type: 'tuple', components: channelStateComponents },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getChannelState',
    stateMutability: 'view',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: channelStateComponents }],
  },
  {
    type: 'function',
    name: 'getChannelStatesBatch',
    stateMutability: 'view',
    inputs: [{ name: 'channelIds', type: 'bytes32[]' }],
    outputs: [{ type: 'tuple[]', components: channelStateComponents }],
  },
  {
    type: 'function',
    name: 'computeChannelId',
    stateMutability: 'view',
    inputs: [
      { name: 'payer', type: 'address' },
      { name: 'payee', type: 'address' },
      { name: 'operator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'authorizedSigner', type: 'address' },
      { name: 'expiringNonceHash', type: 'bytes32' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getVoucherDigest',
    stateMutability: 'view',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'cumulativeAmount', type: 'uint96' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'domainSeparator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'ChannelOpened',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'operator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'authorizedSigner', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'expiringNonceHash', type: 'bytes32' },
      { name: 'deposit', type: 'uint96' },
    ],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'cumulativeAmount', type: 'uint96' },
      { name: 'deltaPaid', type: 'uint96' },
      { name: 'newSettled', type: 'uint96' },
    ],
  },
  {
    type: 'event',
    name: 'TopUp',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'additionalDeposit', type: 'uint96' },
      { name: 'newDeposit', type: 'uint96' },
    ],
  },
  {
    type: 'event',
    name: 'CloseRequested',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'closeGraceEnd', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'ChannelClosed',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'settledToPayee', type: 'uint96' },
      { name: 'refundedToPayer', type: 'uint96' },
    ],
  },
  {
    type: 'event',
    name: 'CloseRequestCancelled',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
    ],
  },
] as const
