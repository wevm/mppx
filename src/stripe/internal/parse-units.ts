/**
 * Converts a decimal string to its integer representation at the given precision.
 * Fractional digits beyond the precision are rounded half away from zero.
 *
 * @see https://github.com/wevm/viem/pull/4859
 */
export function parseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new RangeError('Decimals must be a non-negative integer.')
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    throw new TypeError(`Value \`${value}\` is not a valid decimal number.`)

  const negative = value.startsWith('-')
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const keptFraction = fraction.slice(0, decimals).padEnd(decimals, '0')
  let result = BigInt(`${integer || '0'}${keptFraction}`)

  if (fraction.length > decimals && fraction[decimals]! >= '5') result += 1n
  return negative ? -result : result
}
