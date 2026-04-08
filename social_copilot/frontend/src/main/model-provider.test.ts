import { describe, expect, it, vi } from 'vitest'

import { probeProviderConnection } from './model-provider'

describe('probeProviderConnection', () => {
  it('uses non-stream smoke tests by default for assistant providers', async () => {
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: [{ id: 'gpt-5.1' }] })
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'ok' } }] })
      }
    })

    const message = await probeProviderConnection(fetchImpl, 'http://example.com/v1', 'test-key', 'gpt-5.1')
    const request = fetchImpl.mock.calls[1]?.[1] as RequestInit
    const payload = JSON.parse(String(request.body))

    expect(payload.stream).toBe(false)
    expect(message).toContain('gpt-5.1 smoke test 通过')
  })

  it('uses stream smoke tests when explicitly requested', async () => {
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ data: [{ id: 'gpt-5.1' }] })
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'ok' } }] })
      }
    })

    const message = await probeProviderConnection(
      fetchImpl,
      'http://example.com/v1',
      'test-key',
      'gpt-5.1',
      'stream'
    )
    const request = fetchImpl.mock.calls[1]?.[1] as RequestInit
    const payload = JSON.parse(String(request.body))

    expect(payload.stream).toBe(true)
    expect(message).toContain('流式输出')
  })
})
