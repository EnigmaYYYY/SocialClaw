import { describe, expect, it } from 'vitest'

import { buildVisionFailureMessage, buildVisionSkipMessage } from './vision-test-feedback'

describe('vision test feedback helpers', () => {
  it('explains skipped VLM test as backend unreachable when fetch fails', () => {
    expect(
      buildVisionSkipMessage(
        '连接成功，可用模型 56 个；当前模型 smoke test 通过',
        'http://127.0.0.1:18777',
        'fetch failed'
      )
    ).toContain('无法连接本地视觉监测后端 http://127.0.0.1:18777')
  })

  it('classifies empty image responses as unsupported VLM input', () => {
    expect(
      buildVisionFailureMessage({
        ok: false,
        parse_ok: false,
        message_count: 0,
        roundtrip_ms: 1000,
        error: '',
        raw_content_preview: 'None',
        stream_strategy: 'non_stream'
      })
    ).toContain('当前策略：非流式输出')
  })

  it('falls back to structured-json failure when content preview exists', () => {
    expect(
      buildVisionFailureMessage({
        ok: false,
        parse_ok: false,
        message_count: 0,
        roundtrip_ms: 1000,
        error: '',
        raw_content_preview: 'I can see a chat screenshot but here is my explanation',
        stream_strategy: 'stream'
      })
    ).toContain('当前策略：流式输出')
  })
})
