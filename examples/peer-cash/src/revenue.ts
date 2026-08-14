export type RevenueSnapshot = {
  available: bigint
  ready: boolean
  reserved: bigint
  settled: bigint
  threshold: bigint
}

/** Tracks confirmed merchant revenue without counting a settlement twice. */
export class RevenueTracker {
  readonly #references = new Set<string>()
  readonly #threshold: bigint
  #reserved = 0n
  #settled = 0n

  constructor(threshold: bigint) {
    if (threshold <= 0n) throw new Error('Revenue threshold must be positive.')
    this.#threshold = threshold
  }

  /** Records a successful settlement once, keyed by its receipt reference. */
  record(reference: string, amount: bigint): boolean {
    if (!reference) throw new Error('Settlement reference is required.')
    if (amount <= 0n) throw new Error('Settlement amount must be positive.')
    if (this.#references.has(reference)) return false
    this.#references.add(reference)
    this.#settled += amount
    return true
  }

  /** Reserves confirmed revenue before an asynchronous cash-out plan is prepared. */
  reserve(amount: bigint): void {
    if (amount <= 0n) throw new Error('Cash-out amount must be positive.')
    if (amount > this.available) throw new Error('Cash-out exceeds unreserved settlements.')
    this.#reserved += amount
  }

  /** Releases a reservation when preparing its cash-out plan fails. */
  release(amount: bigint): void {
    if (amount <= 0n || amount > this.#reserved) throw new Error('Invalid reservation release.')
    this.#reserved -= amount
  }

  /** Returns confirmed revenue that is not already assigned to a cash-out plan. */
  get available(): bigint {
    return this.#settled - this.#reserved
  }

  /** Returns the current in-memory accounting state. */
  snapshot(): RevenueSnapshot {
    return {
      available: this.available,
      ready: this.available >= this.#threshold,
      reserved: this.#reserved,
      settled: this.#settled,
      threshold: this.#threshold,
    }
  }
}
