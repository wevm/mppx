// Where keys live. Two kinds:
// - a local demo wallet key (legacy): macOS keychain (default on Mac), a 0600 file (default elsewhere), or MPP_PRIVATE_KEY;
// - a Tempo Wallet access key: a key the user's Tempo Wallet authorized to spend from it, up to a limit, until an expiry.
// Keys are never logged.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Address, Hex } from 'viem'

import { config } from './config.ts'

export type LegacySource = 'env' | 'file' | 'keychain'
const LEGACY_ITEM = ['-s', 'mpp-agent-demo-key', '-a', 'mpp-agent']
const ACCESS_ITEM = ['-s', 'mpp-agent-access-key', '-a', 'mpp-agent']

const keychainGet = (item: string[]) => {
  try {
    return execFileSync('security', ['find-generic-password', ...item, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}
const keychainSet = (item: string[], label: string, value: string) =>
  execFileSync('security', ['add-generic-password', '-U', ...item, '-l', label, '-w', value], {
    stdio: 'ignore',
  })
const keychainDelete = (item: string[]) =>
  execFileSync('security', ['delete-generic-password', ...item], { stdio: 'ignore' })
const fileGet = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
function fileSet(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** The local demo wallet's store: the forced raw-key mode, else the platform default. */
export const legacySource = (): LegacySource =>
  config.keySource === 'env' || config.keySource === 'file' || config.keySource === 'keychain'
    ? config.keySource
    : config.legacyStore

/** Returns the local demo wallet key, or null if none is stored. */
export function readKey(source: LegacySource = legacySource()): Hex | null {
  let raw: string | undefined
  if (source === 'env') raw = process.env.MPP_PRIVATE_KEY
  else if (source === 'file') raw = fileGet(config.keyFile)
  else raw = keychainGet(LEGACY_ITEM)
  delete process.env.MPP_PRIVATE_KEY
  const key = raw?.trim() ?? ''
  if (!key) return null
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error(`stored key from ${source} is malformed`)
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex
}

export function storeKey(key: Hex, source: LegacySource = legacySource()): void {
  if (source === 'env') throw new Error('MPP_KEY_SOURCE=env: set MPP_PRIVATE_KEY yourself')
  if (source === 'file') fileSet(config.keyFile, key)
  else keychainSet(LEGACY_ITEM, 'mpp-agent demo wallet (Tempo)', key)
}

/** Deletes the local demo wallet key. Callers check the balance first (see `setup --forget-local-key`). */
export function forgetKey(source: LegacySource = legacySource()): void {
  if (source === 'env') throw new Error('MPP_KEY_SOURCE=env: unset MPP_PRIVATE_KEY yourself')
  if (source === 'file') unlinkSync(config.keyFile)
  else keychainDelete(LEGACY_ITEM)
}

export const describeLegacy = (source: LegacySource = legacySource()) =>
  source === 'file'
    ? config.keyFile
    : source === 'keychain'
      ? 'macOS keychain (mpp-agent-demo-key)'
      : 'MPP_PRIVATE_KEY'
export const describeAccessKey = () =>
  config.accessKeyStore === 'file' ? config.accessKeyFile : 'macOS keychain (mpp-agent-access-key)'

/** A Tempo Wallet access key: the agent signs with `privateKey`; payments come from `wallet`. */
export type AccessKeyRecord = {
  version: 1
  chainId: number
  wallet: Address // the user's Tempo Wallet (the payer)
  accessKey: Address // this agent's key
  privateKey: Hex
  keyAuthorization: Record<string, unknown> // the wallet's signed authorization (RPC form); sent with the first payment
  expiry: number // unix seconds
  limit: { token: Address; raw: string } // spending limit in token base units
  createdAt: string
}

export function readAccessKey(): AccessKeyRecord | null {
  const raw =
    config.accessKeyStore === 'file' ? fileGet(config.accessKeyFile) : keychainGet(ACCESS_ITEM)
  if (!raw?.trim()) return null
  let r: AccessKeyRecord
  try {
    r = JSON.parse(raw)
  } catch {
    throw new Error(`stored access key in ${describeAccessKey()} is malformed`)
  }
  const addr = (a: unknown) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
  if (
    r?.version !== 1 ||
    !addr(r.wallet) ||
    !addr(r.accessKey) ||
    !/^0x[0-9a-fA-F]{64}$/.test(r.privateKey ?? '') ||
    typeof r.expiry !== 'number' ||
    typeof r.chainId !== 'number' ||
    !r.keyAuthorization ||
    !/^\d+$/.test(r.limit?.raw ?? '')
  )
    throw new Error(`stored access key in ${describeAccessKey()} is malformed`)
  return r
}

export function storeAccessKey(record: AccessKeyRecord): void {
  const value = JSON.stringify(record)
  if (config.accessKeyStore === 'file') fileSet(config.accessKeyFile, value)
  else keychainSet(ACCESS_ITEM, 'mpp-agent Tempo Wallet access key', value)
}
