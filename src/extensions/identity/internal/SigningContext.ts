import { Base64 } from 'ox'

/** Creates the attempt values shared by every prover on one HTTP attempt. */
export function create(): { readonly created: number; readonly nonce: string } {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return {
    created: Math.floor(Date.now() / 1_000),
    nonce: Base64.fromBytes(bytes, { pad: false, url: true }),
  }
}
