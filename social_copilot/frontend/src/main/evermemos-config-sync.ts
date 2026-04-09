import type { AppSettings } from '../models/schemas'

export interface EverMemOSConfigSyncRequest {
  endpoint: 'llm' | 'vectorize' | 'rerank'
  label: 'LLM' | 'Vectorize' | 'Rerank'
  payload: Record<string, unknown>
}

export function buildEverMemOSConfigSyncRequests(settings: AppSettings): EverMemOSConfigSyncRequest[] {
  return [
    {
      endpoint: 'llm',
      label: 'LLM',
      payload: {
        base_url: settings.evermemos.llm.baseUrl,
        api_key: settings.evermemos.llm.apiKey,
        model: settings.evermemos.llm.model,
        temperature: settings.evermemos.llm.temperature,
        max_tokens: settings.evermemos.llm.maxTokens
      }
    },
    {
      endpoint: 'vectorize',
      label: 'Vectorize',
      payload: {
        base_url: settings.evermemos.vectorize.baseUrl,
        api_key: settings.evermemos.vectorize.apiKey,
        model: settings.evermemos.vectorize.model
      }
    },
    {
      endpoint: 'rerank',
      label: 'Rerank',
      payload: {
        base_url: settings.evermemos.rerank.baseUrl,
        api_key: settings.evermemos.rerank.apiKey,
        model: settings.evermemos.rerank.model
      }
    }
  ]
}
