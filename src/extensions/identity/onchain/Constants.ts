/** Onchain identity constants. */
export const Constants = {
  /** Default requirement type advertised in the 402's `Identity-Required` header. */
  type: 'kyc',
  /** Coinbase Verifications on Base mainnet (https://github.com/coinbase/verifications). */
  coinbase: {
    /** Base mainnet chain ID. */
    chainId: 8453,
    /** Ethereum Attestation Service predeploy. */
    eas: '0x4200000000000000000000000000000000000021',
    /** Coinbase attestation indexer: latest attestation UID per recipient and schema. */
    indexer: '0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C',
    /** Coinbase's attester. Attestations from any other attester are ignored. */
    attester: '0x357458739F90461b99789350868CD7CF330Dd7EE',
    /** EAS schema IDs of Coinbase Verifications. */
    schemas: {
      /** Holder of a Coinbase account that passed Coinbase's verification. */
      verifiedAccount: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
      /** Holder of a verified Coinbase business account. */
      verifiedBusinessAccount: '0xf82663c0eac879bed1e09e3d4598752359a321f51b38ae669728f480abf3f474',
      /** Coinbase One subscriber. */
      verifiedCoinbaseOne: '0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4',
    },
  },
} as const
