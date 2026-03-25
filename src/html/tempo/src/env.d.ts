import type { z } from 'zod/mini'

import type { Methods } from '../../../tempo/index.js'

declare global {
  interface MppxChallengeRequest extends z.output<typeof Methods.charge.schema.request> {}
}
