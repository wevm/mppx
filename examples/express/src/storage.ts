import type { tempo } from 'mpay/server'

type ChannelStorage = tempo.ChannelStorage
type ChannelState = tempo.ChannelState
type SessionState = tempo.SessionState

export function createMemoryStorage(): ChannelStorage {
  const channels = new Map<string, ChannelState>()
  const sessions = new Map<string, SessionState>()

  return {
    async getChannel(channelId) {
      return channels.get(channelId) ?? null
    },
    async getSession(challengeId) {
      return sessions.get(challengeId) ?? null
    },
    async updateChannel(channelId, fn) {
      const current = channels.get(channelId) ?? null
      const next = fn(current)
      if (next) channels.set(channelId, next)
      else channels.delete(channelId)
      return next
    },
    async updateSession(challengeId, fn) {
      const current = sessions.get(challengeId) ?? null
      const next = fn(current)
      if (next) sessions.set(challengeId, next)
      else channels.delete(challengeId)
      return next
    },
  }
}
