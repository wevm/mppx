import type { ChannelState, ChannelStorage, SessionState } from 'mpay/server'

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
      else sessions.delete(challengeId)
      return next
    },
  }
}
