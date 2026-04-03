import { describe, expect, it, vi } from 'vitest'

import {
  buildChatCompletionsUrl,
  buildModelListCandidateUrls,
  listProviderModels,
  probeProviderConnection
} from './model-provider'

describe('model-provider helpers', () => {
  it('builds chat completions endpoint from the exact base url', () => {
    expect(buildChatCompletionsUrl('https://example.com/v1')).toBe('https://example.com/v1/chat/completions')
    expect(buildChatCompletionsUrl('https://example.com')).toBe('https://example.com/chat/completions')
  })

  it('builds model list endpoint from the exact base url', () => {
    expect(buildModelListCandidateUrls('https://example.com/v1')).toEqual(['https://example.com/v1/models'])
    expect(buildModelListCandidateUrls('https://example.com')).toEqual(['https://example.com/models'])
  })

  it('lists models from an OpenAI-compatible endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }]
      })
    }))

    await expect(listProviderModels(fetchMock as typeof fetch, 'https://example.com/v1', 'sk-test')).resolves.toEqual([
      'a-model',
      'b-model'
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/v1/models',
      expect.objectContaining({
        method: 'GET'
      })
    )
  })

  it('falls back to direct smoke test when model listing is unsupported but a manual model is provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => ''
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'chatcmpl-test' }),
        text: async () => 'ok'
      })

    await expect(
      probeProviderConnection(fetchMock as typeof fetch, 'https://example.com', 'sk-test', 'manual-model')
    ).resolves.toContain('手动模型 manual-model')
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://example.com/chat/completions',
      expect.objectContaining({
        method: 'POST'
      })
    )
  })
})
