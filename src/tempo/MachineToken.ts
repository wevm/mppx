import type { Address } from 'viem'

import * as defaults from './internal/defaults.js'

/** Canonical first-party machine-token deployment metadata. */
export type Deployment = Readonly<{
  swapper: Address
  token: Address
}>

/** Resolves the canonical first-party machine-token deployment for a Tempo chain. */
export function getDeployment(chainId: number | undefined): Deployment | undefined {
  if (chainId === undefined) return undefined
  const deployment = defaults.machineToken[chainId as keyof typeof defaults.machineToken]
  if (!deployment) return undefined
  return { swapper: deployment.swap, token: deployment.token }
}
