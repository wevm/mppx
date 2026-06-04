import type { SessionReceipt } from '../precompile/Protocol.js'
import type { SessionReceiptPredicate } from './Runtime.js'
import type { ActiveSocketSession } from './Transports.js'

type Waiter<Value> = {
  predicate: (value: Value) => boolean
  reject(error: Error): void
  resolve(value: Value): void
}

function createSingleWaiter<Value>(name: string) {
  let waiter: Waiter<Value> | null = null

  return {
    wait(predicate: (value: Value) => boolean = () => true) {
      if (waiter) throw new Error(`${name} wait already in progress`)
      return new Promise<Value>((resolve, reject) => {
        waiter = { predicate, resolve, reject }
      })
    },
    settle(value: Value) {
      if (!waiter || !waiter.predicate(value)) return
      const current = waiter
      waiter = null
      current.resolve(value)
    },
    reject(error: Error) {
      if (!waiter) return
      const current = waiter
      waiter = null
      current.reject(error)
    },
  }
}

/** Dependencies needed by receipt coordination to inspect active socket state. */
export type CreateSessionReceiptCoordinatorParameters = {
  /** Returns the active socket session, when a paid WebSocket is open. */
  getSocketSession(): ActiveSocketSession | null
}

/** Coordinates receipt waiters plus WebSocket close-ready receipt caching. */
export type SessionReceiptCoordinator = {
  /** Rejects a pending close-ready wait, when present. */
  rejectCloseReady(error: Error): void
  /** Rejects a pending payment receipt wait, when present. */
  rejectReceipt(error: Error): void
  /** Resolves a close-ready wait and caches matching socket close-ready receipts. */
  settleCloseReady(receipt: SessionReceipt): void
  /** Resolves a payment receipt wait when its predicate accepts the receipt. */
  settleReceipt(receipt: SessionReceipt): void
  /** Waits for a close-ready receipt, reusing the cached active socket receipt when available. */
  waitForCloseReady(): Promise<SessionReceipt>
  /** Waits for a payment receipt. Only one receipt wait may be active at a time. */
  waitForReceipt(predicate?: SessionReceiptPredicate): Promise<SessionReceipt>
}

/** Creates the receipt coordinator used by HTTP/SSE/WebSocket session manager flows. */
export function createSessionReceiptCoordinator(
  parameters: CreateSessionReceiptCoordinatorParameters,
): SessionReceiptCoordinator {
  const closeReadyWaiter = createSingleWaiter<SessionReceipt>('close-ready')
  const receiptWaiter = createSingleWaiter<SessionReceipt>('receipt')
  const matchesSocketSession = (receipt: SessionReceipt) => {
    const socketSession = parameters.getSocketSession()
    return (
      !socketSession ||
      (socketSession.challenge.id === receipt.challengeId &&
        socketSession.channelId === receipt.channelId)
    )
  }

  return {
    waitForReceipt(predicate) {
      return receiptWaiter.wait(predicate)
    },
    waitForCloseReady() {
      const receipt = parameters.getSocketSession()?.closeReadyReceipt
      if (receipt) return Promise.resolve(receipt)
      return closeReadyWaiter.wait(matchesSocketSession)
    },
    settleReceipt(receipt) {
      receiptWaiter.settle(receipt)
    },
    settleCloseReady(receipt) {
      const socketSession = parameters.getSocketSession()
      if (socketSession && matchesSocketSession(receipt)) {
        socketSession.closeReadyReceipt = receipt
      }
      closeReadyWaiter.settle(receipt)
    },
    rejectReceipt(error) {
      receiptWaiter.reject(error)
    },
    rejectCloseReady(error) {
      closeReadyWaiter.reject(error)
    },
  }
}
