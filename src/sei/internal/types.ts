export type DeriveDefaults<parameters, defaults> = Pick<
  parameters,
  Extract<keyof parameters, keyof defaults>
> &
  (parameters extends { account: string } ? { recipient: string } : {}) &
  (parameters extends { recipient: string } ? { recipient: string } : {})
