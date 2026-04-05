import { describe, expect, it } from 'vitest'

import { createDefaultUnifiedContactProfile } from '../../../models/schemas'
import { buildRawJsonPreview, shouldShowEvidenceForField } from './ProfileLibraryPanel'

describe('ProfileLibraryPanel helpers', () => {
  it('hides evidence UI only for catchphrase field', () => {
    expect(shouldShowEvidenceForField('catchphrase')).toBe(false)
    expect(shouldShowEvidenceForField('traits')).toBe(true)
  })

  it('removes retrieval from raw JSON preview while keeping source profile intact', () => {
    const profile = createDefaultUnifiedContactProfile('owner_user', 'contact_001', 'test-contact')
    profile.retrieval = {
      vector: [0.1, 0.2],
      vector_model: 'test-model',
      keywords: ['alpha', 'beta']
    }

    const preview = buildRawJsonPreview(profile)

    expect('retrieval' in preview).toBe(false)
    expect(profile.retrieval).not.toBeNull()
    expect(profile.retrieval?.vector_model).toBe('test-model')
  })
})
