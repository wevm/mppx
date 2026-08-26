import { digestOpenApiDocument } from './openapi.js'
import type { ChallengeTerms, ContractRequirement } from './qualify.js'

/**
 * Frozen extract operation modeled on a live zero-spend HTTP 402 probe.
 *
 * The live seller advertised `GET /extract?url=https%3A%2F%2Fexample.com` with
 * one MPP evm/charge offer. This example never calls that seller.
 */
export const extractMethod = 'GET'

export const extractUrl = 'https://seller.example/extract?url=https%3A%2F%2Fexample.com'

export const extractOperationPath = '/extract'

export const extractSuccessStatus = '200'

export const extractMediaType = 'application/json'

export const extractRequiredOutputPaths = ['ok', 'url', 'title'] as const

export const extractChallengeTerms = {
  amount: '5000',
  currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  chainId: 8453,
  recipient: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  id: 'extract-charge',
} satisfies ChallengeTerms

/**
 * Directly represented OpenAPI 3.1 document for `GET /extract`.
 *
 * The operation requires query `url`. The JSON 200 schema requires `ok`,
 * `url`, and `title`. No `$ref`, composition, or extra success representation.
 */
export const extractOpenApiDocumentObject = {
  openapi: '3.1.0',
  info: {
    title: 'Extract',
    version: '1.0.0',
  },
  paths: {
    '/extract': {
      get: {
        operationId: 'extract',
        parameters: [
          {
            name: 'url',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Extracted page metadata',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok', 'url', 'title'],
                  properties: {
                    ok: { type: 'boolean' },
                    url: { type: 'string' },
                    title: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const

/** Frozen OpenAPI 3.1 document bytes used for the digest and qualifier. */
export const extractOpenApiDocument = JSON.stringify(extractOpenApiDocumentObject)

export const extractOpenApiDigest = digestOpenApiDocument(extractOpenApiDocument)

export const extractRequirement = {
  method: extractMethod,
  url: extractUrl,
  challenge: extractChallengeTerms,
  openApiDigest: extractOpenApiDigest,
  operationPath: extractOperationPath,
  operationMethod: 'get',
  successStatus: extractSuccessStatus,
  mediaType: extractMediaType,
  requiredOutputPaths: extractRequiredOutputPaths,
} satisfies ContractRequirement
