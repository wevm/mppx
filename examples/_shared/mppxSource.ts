import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')

export const mppxSourceAlias = [
  { find: /^mppx\/stripe\/server$/, replacement: path.resolve(root, 'src/stripe/server') },
  { find: /^mppx\/stripe\/client$/, replacement: path.resolve(root, 'src/stripe/client') },
  { find: /^mppx\/stripe$/, replacement: path.resolve(root, 'src/stripe') },
  { find: /^mppx\/tempo$/, replacement: path.resolve(root, 'src/tempo') },
  { find: /^mppx\/server$/, replacement: path.resolve(root, 'src/server') },
  { find: /^mppx\/client$/, replacement: path.resolve(root, 'src/client') },
  { find: /^mppx$/, replacement: path.resolve(root, 'src') },
]
