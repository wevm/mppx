/**
 * Link agent identity (https://docs.link.com/concepts/agent-identity): Link Agent Attestation
 * Tokens (Privacy Pass `PrivateToken`s in `Authorization`) and selectively disclosed identity
 * presentations (SD-JWT in `Identity-Presentation`). The server verifies them with Link's Agent
 * Identity SDK (`@stripe/agent-identity`); the client gets them from Link CLI or the Link SDK.
 */

/** Client provers that answer Link attestation and claims challenges. */
export * as Client from './client/index.js'
/** Server verifiers that require a Link attestation or Link-signed claims. */
export * as Server from './server/index.js'
export * from './Constants.js'
export type * from './Types.js'
