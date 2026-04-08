export interface AssistantPersonaSkillOption {
  skillId: string
  name: string
  description: string
}

interface AssistantPersonaSkillResponseItem {
  skill_id?: string
  name?: string
  description?: string
}

interface AssistantPersonaSkillResponse {
  skills?: AssistantPersonaSkillResponseItem[]
}

export async function fetchAssistantPersonaSkills(baseUrl: string): Promise<AssistantPersonaSkillOption[]> {
  const trimmedBaseUrl = baseUrl.trim()
  if (!trimmedBaseUrl) {
    return []
  }

  const response = await fetch(`${trimmedBaseUrl}/assistant/skills`)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`assistant skills failed ${response.status}: ${body}`)
  }

  const payload = (await response.json()) as AssistantPersonaSkillResponse
  return (payload.skills ?? [])
    .map((item) => ({
      skillId: (item.skill_id ?? '').trim(),
      name: (item.name ?? '').trim(),
      description: (item.description ?? '').trim()
    }))
    .filter((item) => item.skillId.length > 0 && item.name.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}
