declare module '*.css' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

interface ImportMetaEnv {
  readonly DEV: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Per-method root element ID, set by composed pages. @internal */
declare var __mppx_root: string | undefined
/** Active method key for composed pages. @internal */
declare var __mppx_active: string | undefined
