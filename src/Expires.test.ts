import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as Expires from './Expires.js'

const FIXED_NOW = new Date('2025-06-15T12:00:00.000Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('seconds', () => {
  test('returns ISO string n seconds from now', () => {
    expect(Expires.seconds(30)).toBe('2025-06-15T12:00:30.000Z')
  })

  test('0 returns current time', () => {
    expect(Expires.seconds(0)).toBe('2025-06-15T12:00:00.000Z')
  })

  test('negative n returns past time', () => {
    expect(Expires.seconds(-60)).toBe('2025-06-15T11:59:00.000Z')
  })
})

describe('minutes', () => {
  test('returns ISO string n minutes from now', () => {
    expect(Expires.minutes(5)).toBe('2025-06-15T12:05:00.000Z')
  })

  test('0 returns current time', () => {
    expect(Expires.minutes(0)).toBe('2025-06-15T12:00:00.000Z')
  })

  test('negative n returns past time', () => {
    expect(Expires.minutes(-10)).toBe('2025-06-15T11:50:00.000Z')
  })
})

describe('hours', () => {
  test('returns ISO string n hours from now', () => {
    expect(Expires.hours(2)).toBe('2025-06-15T14:00:00.000Z')
  })

  test('0 returns current time', () => {
    expect(Expires.hours(0)).toBe('2025-06-15T12:00:00.000Z')
  })

  test('negative n returns past time', () => {
    expect(Expires.hours(-3)).toBe('2025-06-15T09:00:00.000Z')
  })
})

describe('days', () => {
  test('returns ISO string n days from now', () => {
    expect(Expires.days(1)).toBe('2025-06-16T12:00:00.000Z')
  })

  test('0 returns current time', () => {
    expect(Expires.days(0)).toBe('2025-06-15T12:00:00.000Z')
  })

  test('negative n returns past time', () => {
    expect(Expires.days(-2)).toBe('2025-06-13T12:00:00.000Z')
  })
})

describe('weeks', () => {
  test('returns ISO string n weeks from now', () => {
    expect(Expires.weeks(1)).toBe('2025-06-22T12:00:00.000Z')
  })

  test('0 returns current time', () => {
    expect(Expires.weeks(0)).toBe('2025-06-15T12:00:00.000Z')
  })

  test('negative n returns past time', () => {
    expect(Expires.weeks(-1)).toBe('2025-06-08T12:00:00.000Z')
  })
})

describe('months', () => {
  test('returns ISO string n months (30 days) from now', () => {
    expect(Expires.months(1)).toBe('2025-07-15T12:00:00.000Z')
  })

  test('0 returns current time', () => {
    expect(Expires.months(0)).toBe('2025-06-15T12:00:00.000Z')
  })

  test('negative n returns past time', () => {
    expect(Expires.months(-1)).toBe('2025-05-16T12:00:00.000Z')
  })
})

describe('years', () => {
  test('returns ISO string n years (365 days) from now', () => {
    expect(Expires.years(1)).toBe('2026-06-15T12:00:00.000Z')
  })

  test('0 returns current time', () => {
    expect(Expires.years(0)).toBe('2025-06-15T12:00:00.000Z')
  })

  test('negative n returns past time', () => {
    expect(Expires.years(-1)).toBe('2024-06-15T12:00:00.000Z')
  })
})
