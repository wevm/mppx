export { charge } from './Charge.js'
export { session, tempo } from './Methods.js'
export { session as sessionLegacy } from '../legacy/client/index.js'
export { subscription } from './Subscription.js'
export type {
  PaymentResponse as SessionLegacyPaymentResponse,
  SessionManager as SessionLegacyManager,
} from '../legacy/client/index.js'
export { sessionManager as sessionLegacyManager } from '../legacy/client/index.js'
export { session as sessionMethod } from '../session/client/Session.js'
export type {
  PaymentResponse,
  SessionManager,
  SessionManagerSseOptions,
  SessionManagerWebSocketOptions,
} from '../session/client/SessionManager.js'
export { sessionManager } from '../session/client/SessionManager.js'
