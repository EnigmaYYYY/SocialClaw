export interface VisionTestResult {
  ok: boolean
  parse_ok: boolean
  message_count: number
  roundtrip_ms: number
  error?: string
  raw_content_preview?: string
  stream_strategy?: 'stream' | 'non_stream'
}

export function formatVisionStreamStrategy(streamStrategy: 'stream' | 'non_stream' | undefined): string {
  return streamStrategy === 'non_stream' ? '非流式输出' : '流式输出'
}

export function buildVisionSkipMessage(
  basicResult: string,
  backendBaseUrl: string,
  reason: string
): string {
  const trimmedReason = reason.trim() || 'unknown_error'
  const unreachable =
    trimmedReason.includes('fetch failed') ||
    trimmedReason.includes('networkerror') ||
    trimmedReason.includes('econnrefused') ||
    trimmedReason.includes('failed to fetch')

  if (unreachable) {
    return `${basicResult}（VLM图像测试未执行：无法连接本地视觉监测后端 ${backendBaseUrl}。当前只完成了文本 smoke test；请检查 Visual Monitor 是否正在运行）`
  }

  return `${basicResult}（VLM图像测试未执行：${trimmedReason.slice(0, 120)}）`
}

export function buildVisionFailureMessage(result: VisionTestResult): string {
  const detail = (result.error ?? '').trim()
  const preview = (result.raw_content_preview ?? '').trim()
  const normalizedPreview = preview.toLowerCase()
  const strategyLabel = formatVisionStreamStrategy(result.stream_strategy)

  if (!detail && (!preview || normalizedPreview === 'none' || normalizedPreview === 'null')) {
    return `连接成功，但VLM图像解析失败：该模型/代理返回空图像响应，疑似不支持 VLM 输入，或代理未透传 image_url。当前策略：${strategyLabel}。`
  }

  if (detail === 'empty_image_response') {
    return `连接成功，但VLM图像解析失败：该模型/代理返回空图像响应，疑似不支持 VLM 输入，或代理未透传 image_url。当前策略：${strategyLabel}。`
  }

  if (detail) {
    return `连接成功，但VLM图像解析失败：${detail.slice(0, 160)}。当前策略：${strategyLabel}。`
  }

  return `连接成功，但VLM图像解析失败：模型返回了内容，但不是可解析的结构化 JSON。当前策略：${strategyLabel}。预览：${preview.slice(0, 120)}`
}
