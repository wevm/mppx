import * as defaults from './defaults.js'
import * as MachineTokenCharge from './machine-token-charge.js'

/**
 * Marks the MACH offer that `acceptMachineToken` adds, so charge and session handlers accept MACH as
 * its currency while still rejecting MACH configured any other way.
 *
 * @internal
 */
export const offered = Symbol.for('mppx.tempo.machineTokenOffer')

export type Parameters = {
  /**
   * Also accepts MACH, paid straight to the recipient, as the last offer of every Tempo charge and
   * session. Clients that hold enough MACH, and can pay its gas in a stablecoin unless the server
   * sponsors it, pay that offer; other clients keep paying the currencies listed before it.
   */
  acceptMachineToken?: boolean | undefined
}

type Resolved = { chainId: number; currency: string; decimals: number }

/** Appends the MACH offer after every configured currency when `acceptMachineToken` is set. */
export function append<const currency extends Resolved>(
  currencies: readonly [currency, ...currency[]],
  acceptMachineToken: boolean | undefined,
): readonly [currency, ...currency[]] {
  if (!acceptMachineToken) return currencies
  const { chainId } = currencies[0]
  const deployment = defaults.machineToken[chainId as keyof typeof defaults.machineToken]
  if (!deployment) throw new Error(`MACH is not supported on chainId ${chainId}.`)
  return [
    ...currencies,
    { ...currencies[0], currency: deployment.token, decimals: defaults.decimals, [offered]: true },
  ] as unknown as readonly [currency, ...currency[]]
}

/** Whether a handler was created for the offer `append` added. */
export function isOffer(parameters: object): boolean {
  return (parameters as { [offered]?: boolean })[offered] === true
}

/**
 * Rejects MACH as a currency except on the offer `acceptMachineToken` adds, so it is never first or
 * listed by hand.
 */
export function assertAllowed(parameters: {
  chainId: number | undefined
  currency: unknown
  offer: boolean
}) {
  if (parameters.offer || typeof parameters.currency !== 'string') return
  if (
    MachineTokenCharge.isMachineToken({
      chainId: parameters.chainId,
      currency: parameters.currency as `0x${string}`,
    })
  )
    throw new Error(
      'MACH cannot be listed as a currency. Use `acceptMachineToken: true` to accept it as the last offer.',
    )
}
