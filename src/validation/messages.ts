export const missingDiscoverySuggestion = [
  'No discovery document found, endpoints could not be automatically found.',
  'MPP servers must serve an OpenAPI document at /openapi.json with x-payment-info extensions.',
  'The MPP SDKs can automatically expose this endpoint. See https://mpp.dev/sdk.',
  '',
  'To test a specific endpoint: mppx validate <url> --endpoint POST:/your/path',
].join('\n')
