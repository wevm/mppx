import { describe, expect, test } from 'vp/test'

import { withMppClient, wrapMcpClientWithPayment } from './index.js'
import * as McpClient from './McpClient.js'

describe('MCP client wrapper aliases', () => {
  test('exports aliases for the canonical wrapper', () => {
    expect(McpClient.withMppClient).toBe(McpClient.wrap)
    expect(McpClient.wrapMcpClientWithPayment).toBe(McpClient.wrap)
    expect(withMppClient).toBe(McpClient.wrap)
    expect(wrapMcpClientWithPayment).toBe(McpClient.wrap)
  })
})
