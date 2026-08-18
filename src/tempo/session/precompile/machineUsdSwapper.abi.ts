/** Minimal MachineUsdSwapper ABI used for atomic TIP-1034 session conversion. */
export const machineUsdSwapperAbi = [
  {
    type: 'function',
    name: 'settleSession',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'descriptor',
        type: 'tuple',
        components: [
          { name: 'payer', type: 'address' },
          { name: 'payee', type: 'address' },
          { name: 'operator', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'salt', type: 'bytes32' },
          { name: 'authorizedSigner', type: 'address' },
          { name: 'expiringNonceHash', type: 'bytes32' },
        ],
      },
      { name: 'recipient', type: 'address' },
      { name: 'targetToken', type: 'address' },
      { name: 'routeSalt', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const
