/** Poppy (Personal Agent Protocol 1.0) values. */
export const Constants = {
  /** Header that carries the Session JWT on every request. */
  sessionHeader: 'Poppy-Session',
  /** Header that names the protocol version. */
  versionHeader: 'Poppy-Version',
  /** Protocol version this adapter speaks. */
  version: '1.0',
  /** `typ` of a Session JWT. */
  sessionType: 'poppy-session+jwt',
  /** `typ` of a delegation JWT. */
  delegationType: 'poppy-delegation+jwt',
  /** Longest a delegation may last, in seconds (spec 5.2). */
  maxDelegationLifetime: 24 * 60 * 60,
  /** Default delegation lifetime, in seconds. */
  defaultDelegationLifetime: 60 * 60,
  /** Default window, in seconds, around a Session JWT's `iat`. */
  maxAge: 60,
  /** Seconds a client's metadata and keys are cached. */
  keyCacheTtl: 300,
  /** Seconds before a failed load or an unknown key `kid` loads a client's keys again. */
  keyRetryAfter: 30,
} as const
