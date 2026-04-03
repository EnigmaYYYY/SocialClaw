export interface ModelProviderFetch {
  (input: string, init?: RequestInit): Promise<{
    ok: boolean
    status?: number
    text(): Promise<string>
    json(): Promise<unknown>
  }>
}

export function normalizeModelProviderBaseUrl(baseUrl: string): string {
  return `${baseUrl || ''}`.trim().replace(/\/+$/, '')
}

export function buildModelListCandidateUrls(baseUrl: string): string[] {
  const normalizedBaseUrl = normalizeModelProviderBaseUrl(baseUrl)
  if (!normalizedBaseUrl) {
    return []
  }
  return [`${normalizedBaseUrl}/models`]
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const normalizedBaseUrl = normalizeModelProviderBaseUrl(baseUrl)
  return `${normalizedBaseUrl}/chat/completions`
}

function buildHeaders(apiKey: string, json: boolean = false): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json'
  }
  if (json) {
    headers['Content-Type'] = 'application/json'
  }
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  return headers
}

export async function listProviderModels(fetchImpl: ModelProviderFetch, baseUrl: string, apiKey: string = ''): Promise<string[]> {
  const normalizedBaseUrl = normalizeModelProviderBaseUrl(baseUrl)
  if (!normalizedBaseUrl) {
    throw new Error('model_provider_base_url_required')
  }

  let lastError = 'unknown_error'
  for (const url of buildModelListCandidateUrls(normalizedBaseUrl)) {
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: buildHeaders(apiKey) })
      if (!response.ok) {
        lastError = `HTTP ${response.status ?? 0}: ${await response.text()}`
        continue
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string }> }
      return Array.isArray(payload?.data)
        ? payload.data
            .map((item) => `${item?.id || ''}`.trim())
            .filter((item, index, array) => item.length > 0 && array.indexOf(item) === index)
            .sort((a, b) => a.localeCompare(b))
        : []
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  throw new Error(`model_provider_list_failed:${lastError}`)
}

export async function probeProviderConnection(
  fetchImpl: ModelProviderFetch,
  baseUrl: string,
  apiKey: string = '',
  model: string = ''
): Promise<string> {
  const trimmedModel = model.trim()
  let models: string[] | null = null
  let listError: string | null = null

  try {
    models = await listProviderModels(fetchImpl, baseUrl, apiKey)
  } catch (error) {
    listError = error instanceof Error ? error.message : String(error)
    if (!trimmedModel) {
      throw new Error(listError)
    }
  }

  if (!trimmedModel) {
    return models && models.length > 0 ? `连接成功，可用模型 ${models.length} 个` : '连接成功，但模型列表为空'
  }

  const response = await fetchImpl(buildChatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify({
      model: trimmedModel,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: 'Reply with exactly: ok' }
      ],
      temperature: 0,
      max_tokens: 8,
      stream: false
    })
  })
  if (!response.ok) {
    throw new Error(`model_smoke_test_failed:HTTP ${response.status ?? 0}: ${await response.text()}`)
  }

  if (models === null) {
    return `连接成功；服务不支持列模型，手动模型 ${trimmedModel} smoke test 通过`
  }
  if (!models.includes(trimmedModel)) {
    return `连接成功，可用模型 ${models.length} 个；手动模型 ${trimmedModel} smoke test 通过，但未出现在列表中`
  }
  return `连接成功，可用模型 ${models.length} 个；当前模型 ${trimmedModel} smoke test 通过`
}
