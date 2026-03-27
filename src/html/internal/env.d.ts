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

interface Window {
  /** Current composed-method scope while a method module initializes. @internal */
  __mppx_scope?: { key: string; rootId: string }
}
