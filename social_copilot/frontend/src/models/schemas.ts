import { z } from 'zod'

// ============================================================================
// Message Type Constants (reference: wechatDataBackup/openwechat)
// ============================================================================

export const MSG_TYPE = {
  TEXT: 1,
  IMAGE: 3,
  VOICE: 34,
  CARD: 42,
  VIDEO: 43,
  EMOJI: 47,
  POSITION: 48,
  APP: 49,
  VOIP: 50,
  SYSTEM: 10000
} as const

export const APP_MSG_TYPE = {
  TEXT: 1,
  MUSIC: 3,
  LINK: 5,
  FILE: 6,
  FORWARD: 19,
  APPLET: 33,
  REFER: 57,
  TRANSFER: 2000,
  RED_PACKET: 2003
} as const

// ============================================================================
// RawMessage - Raw message from data import (reference: openwechat/wechatDataBackup)
// ============================================================================

export const RawMessageSchema = z.object({
  msgId: z.string(),
  msgType: z.number(),
  subType: z.number().optional(),
  content: z.string(),
  fromUser: z.string(),
  toUser: z.string(),
  createTime: z.number(),
  isSend: z.boolean(),
  speakerId: z.string().optional(),
  speakerName: z.string().optional(),
  conversationTitle: z.string().optional()
})
export type RawMessage = z.infer<typeof RawMessageSchema>

// ============================================================================
// MessageBlock - Merged message block after cleaning
// ============================================================================

export const MessageBlockSchema = z.object({
  id: z.number(),
  sender: z.string(),
  isSend: z.boolean(),
  messages: z.array(z.string()),
  cleanContent: z.string(),
  startTime: z.number(),
  endTime: z.number()
})
export type MessageBlock = z.infer<typeof MessageBlockSchema>

// ============================================================================
// ParsedMessage - Parsed chat message for context buffer
// ============================================================================

export const ParsedMessageSchema = z.object({
  timestamp: z.coerce.date(),
  sender: z.string().min(1),
  content: z.string(),
  isFromUser: z.boolean()
})
export type ParsedMessage = z.infer<typeof ParsedMessageSchema>

// ============================================================================
// UserProfile - User's personal profile and communication preferences
// ============================================================================

export const GenderSchema = z.enum(['male', 'female', 'other'])
export type Gender = z.infer<typeof GenderSchema>

export const MsgLengthSchema = z.enum(['short', 'medium', 'long'])
export type MsgLength = z.infer<typeof MsgLengthSchema>

export const BaseInfoSchema = z.object({
  gender: GenderSchema,
  occupation: z.string(),
  tone_style: z.string()
})
export type BaseInfo = z.infer<typeof BaseInfoSchema>

export const CommunicationHabitsSchema = z.object({
  frequent_phrases: z.array(z.string()),
  emoji_usage: z.array(z.string()),
  punctuation_style: z.string(),
  msg_avg_length: MsgLengthSchema
})
export type CommunicationHabits = z.infer<typeof CommunicationHabitsSchema>

export const UserProfileSchema = z.object({
  user_id: z.string(),
  base_info: BaseInfoSchema,
  communication_habits: CommunicationHabitsSchema,
  last_updated: z.number()
})
export type UserProfile = z.infer<typeof UserProfileSchema>

export const DEFAULT_USER_PROFILE: UserProfile = {
  user_id: 'self',
  base_info: {
    gender: 'other',
    occupation: '',
    tone_style: 'friendly, casual'
  },
  communication_habits: {
    frequent_phrases: [],
    emoji_usage: [],
    punctuation_style: '',
    msg_avg_length: 'short'
  },
  last_updated: Date.now()
}

// ============================================================================
// UnifiedProfile - Shared profile contract aligned with EverMemOS
// ============================================================================

export const ProfileTypeSchema = z.enum(['user', 'contact'])
export type ProfileType = z.infer<typeof ProfileTypeSchema>

export const UnifiedFactCategorySchema = z.enum([
  'trait',
  'interest',
  'role',
  'style',
  'occupation',
  'other'
])
export type UnifiedFactCategory = z.infer<typeof UnifiedFactCategorySchema>

export const UnifiedIntermediarySchema = z.object({
  has_intermediary: z.boolean().default(false),
  name: z.string().nullable().optional(),
  context: z.string().nullable().optional()
})
export type UnifiedIntermediary = z.infer<typeof UnifiedIntermediarySchema>

export const UnifiedSocialAttributesSchema = z.object({
  role: z.string().default('unknown'),
  age_group: z.string().nullable().optional(),
  intimacy_level: z.enum(['stranger', 'formal', 'close', 'intimate']).default('stranger'),
  current_status: z.string().default('unknown'),
  intermediary: UnifiedIntermediarySchema.default({
    has_intermediary: false,
    name: null,
    context: null
  })
})
export type UnifiedSocialAttributes = z.infer<typeof UnifiedSocialAttributesSchema>

export const UnifiedCommunicationStyleSchema = z.object({
  frequent_phrases: z.array(z.string()).default([]),
  emoji_usage: z.array(z.string()).default([]),
  punctuation_style: z.string().default(''),
  avg_message_length: MsgLengthSchema.default('short'),
  tone_style: z.string().default('friendly')
})
export type UnifiedCommunicationStyle = z.infer<typeof UnifiedCommunicationStyleSchema>

export const UnifiedRiskAssessmentSchema = z.object({
  is_suspicious: z.boolean().default(false),
  risk_level: z.enum(['low', 'medium', 'high']).default('low'),
  warning_msg: z.string().default(''),
  risk_patterns: z.array(z.string()).default([]),
  last_checked: z.string().nullable().optional()
})
export type UnifiedRiskAssessment = z.infer<typeof UnifiedRiskAssessmentSchema>

export const UnifiedEvidenceSchema = z.object({
  source: z.string(),
  timestamp: z.string(),
  message_id: z.string().nullable().optional()
})
export type UnifiedEvidence = z.infer<typeof UnifiedEvidenceSchema>

// ProfileField - 新格式：带证据的字段
export const ProfileFieldSchema = z.object({
  value: z.string(),
  evidence_level: z.enum(['L1', 'L2', 'L3']).default('L2'),
  evidences: z.array(z.string()).default([])
})
export type ProfileField = z.infer<typeof ProfileFieldSchema>

// 支持 ProfileField 列表或字符串列表（兼容旧格式）
const ProfileFieldListSchema = z.array(
  z.union([
    ProfileFieldSchema,
    z.string()  // 兼容旧格式
  ])
).default([])

export const UnifiedFactSchema = z.object({
  fact: z.string(),
  category: UnifiedFactCategorySchema.default('other'),
  evidence: z.array(UnifiedEvidenceSchema).default([]),
  confidence: z.number().min(0).max(1).default(0),
  last_updated: z.string().default('')
})
export type UnifiedFact = z.infer<typeof UnifiedFactSchema>

export const UnifiedProfileMetadataSchema = z.object({
  version: z.number().int().min(1).default(1),
  created_at: z.string().default(''),
  last_updated: z.string().default(''),
  source_memcell_count: z.number().int().min(0).default(0),
  last_cluster_id: z.string().nullable().optional(),
  update_count: z.number().int().min(0).default(0)
})
export type UnifiedProfileMetadata = z.infer<typeof UnifiedProfileMetadataSchema>

export const UnifiedRetrievalSchema = z.object({
  vector: z.array(z.number()).nullable().optional(),
  vector_model: z.string().nullable().optional(),
  keywords: z.array(z.string()).default([])
})
export type UnifiedRetrieval = z.infer<typeof UnifiedRetrievalSchema>

export const UnifiedProfileSchema = z.object({
  profile_id: z.string().min(1),
  profile_type: ProfileTypeSchema,
  owner_user_id: z.string().min(1),
  target_user_id: z.string().nullable().optional(),
  conversation_id: z.string().nullable().optional(),
  display_name: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  // 单值字段（新格式）
  gender: ProfileFieldSchema.nullable().optional(),
  age: ProfileFieldSchema.nullable().optional(),
  education_level: ProfileFieldSchema.nullable().optional(),
  intimacy_level: ProfileFieldSchema.nullable().optional(),
  // 列表字段（新格式，兼容旧格式）
  traits: ProfileFieldListSchema,
  personality: ProfileFieldListSchema,
  interests: ProfileFieldListSchema,
  occupation: ProfileFieldListSchema,
  relationship: ProfileFieldListSchema,
  way_of_decision_making: ProfileFieldListSchema,
  life_habit_preference: ProfileFieldListSchema,
  communication_style: ProfileFieldListSchema,
  catchphrase: ProfileFieldListSchema,
  user_to_friend_catchphrase: ProfileFieldListSchema,
  user_to_friend_chat_style: ProfileFieldListSchema,
  motivation_system: ProfileFieldListSchema,
  fear_system: ProfileFieldListSchema,
  value_system: ProfileFieldListSchema,
  humor_use: ProfileFieldListSchema,
  social_attributes: UnifiedSocialAttributesSchema.default({
    role: 'unknown',
    age_group: null,
    intimacy_level: 'stranger',
    current_status: 'unknown',
    intermediary: {
      has_intermediary: false,
      name: null,
      context: null
    }
  }),
  risk_assessment: UnifiedRiskAssessmentSchema.nullable().optional(),
  metadata: UnifiedProfileMetadataSchema.default({
    version: 1,
    created_at: '',
    last_updated: '',
    source_memcell_count: 0,
    last_cluster_id: null,
    update_count: 0
  }),
  retrieval: UnifiedRetrievalSchema.nullable().optional(),
  extend: z.record(z.string(), z.unknown()).default({})
})
export type UnifiedProfile = z.infer<typeof UnifiedProfileSchema>

function isoNow(): string {
  return new Date().toISOString()
}

function normalizedIso(input: string | number | undefined | null): string {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return new Date(input).toISOString()
  }
  if (typeof input === 'string' && input.trim().length > 0) {
    const date = new Date(input)
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString()
    }
    return input.trim()
  }
  return isoNow()
}

export function createDefaultUnifiedUserProfile(ownerUserId: string = 'self', displayName: string = 'Me'): UnifiedProfile {
  const now = isoNow()
  return {
    profile_id: ownerUserId,
    profile_type: 'user',
    owner_user_id: ownerUserId,
    target_user_id: null,
    conversation_id: null,
    display_name: displayName,
    aliases: [displayName],
    // 新格式：所有列表字段都是 ProfileField 数组
    traits: [],
    personality: [],
    interests: [],
    occupation: [],
    relationship: [],
    way_of_decision_making: [],
    life_habit_preference: [],
    communication_style: [],
    catchphrase: [],
    user_to_friend_catchphrase: [],
    user_to_friend_chat_style: [],
    motivation_system: [],
    fear_system: [],
    value_system: [],
    humor_use: [],
    social_attributes: {
      role: 'self',
      age_group: null,
      intimacy_level: 'stranger',
      current_status: 'self',
      intermediary: {
        has_intermediary: false,
        name: null,
        context: null
      }
    },
    risk_assessment: null,
    metadata: {
      version: 1,
      created_at: now,
      last_updated: now,
      source_memcell_count: 0,
      last_cluster_id: null,
      update_count: 0
    },
    retrieval: null,
    extend: {}
  }
}

export function createDefaultUnifiedContactProfile(
  ownerUserId: string,
  contactId: string,
  displayName: string
): UnifiedProfile {
  const now = isoNow()
  return {
    profile_id: contactId,
    profile_type: 'contact',
    owner_user_id: ownerUserId,
    target_user_id: contactId,
    conversation_id: contactId,
    display_name: displayName,
    aliases: [displayName],
    // 新格式：所有列表字段
    traits: [],
    personality: [],
    interests: [],
    occupation: [],
    relationship: [],
    way_of_decision_making: [],
    life_habit_preference: [],
    communication_style: [],
    catchphrase: [],
    user_to_friend_catchphrase: [],
    user_to_friend_chat_style: [],
    motivation_system: [],
    fear_system: [],
    value_system: [],
    humor_use: [],
    social_attributes: {
      role: 'unknown',
      age_group: null,
      intimacy_level: 'stranger',
      current_status: 'acquaintance',
      intermediary: {
        has_intermediary: false,
        name: null,
        context: null
      }
    },
    risk_assessment: {
      is_suspicious: false,
      risk_level: 'low',
      warning_msg: '',
      risk_patterns: [],
      last_checked: null
    },
    metadata: {
      version: 1,
      created_at: now,
      last_updated: now,
      source_memcell_count: 0,
      last_cluster_id: null,
      update_count: 0
    },
    retrieval: null,
    extend: {}
  }
}

export function convertLegacyUserProfileToUnifiedProfile(profile: UserProfile): UnifiedProfile {
  const now = normalizedIso(profile.last_updated)
  // 将旧的字符串格式转换为 ProfileField 格式
  const toProfileFields = (values: string[]): ProfileField[] =>
    values.map(v => ({ value: v, evidence_level: 'L2' as const, evidences: [] }))

  return {
    profile_id: profile.user_id,
    profile_type: 'user',
    owner_user_id: profile.user_id,
    target_user_id: null,
    conversation_id: null,
    display_name: 'Me',
    aliases: ['Me'],
    traits: [],
    personality: [],
    interests: [],
    occupation: profile.base_info.occupation ? [{ value: profile.base_info.occupation, evidence_level: 'L1', evidences: [] }] : [],
    relationship: [],
    way_of_decision_making: [],
    life_habit_preference: [],
    communication_style: [],
    catchphrase: toProfileFields(profile.communication_habits.frequent_phrases),
    user_to_friend_catchphrase: [],
    user_to_friend_chat_style: [],
    motivation_system: [],
    fear_system: [],
    value_system: [],
    humor_use: [],
    social_attributes: {
      role: 'self',
      age_group: null,
      intimacy_level: 'stranger',
      current_status: 'self',
      intermediary: {
        has_intermediary: false,
        name: null,
        context: null
      }
    },
    risk_assessment: null,
    metadata: {
      version: 1,
      created_at: now,
      last_updated: now,
      source_memcell_count: 0,
      last_cluster_id: null,
      update_count: 0
    },
    retrieval: null,
    extend: {
      legacy_gender: profile.base_info.gender,
      legacy_tone_style: profile.base_info.tone_style,
      legacy_msg_avg_length: profile.communication_habits.msg_avg_length,
      legacy_punctuation_style: profile.communication_habits.punctuation_style,
      legacy_emoji_usage: profile.communication_habits.emoji_usage
    }
  }
}

export function convertLegacyContactProfileToUnifiedProfile(profile: ContactProfile, ownerUserId: string = 'self'): UnifiedProfile {
  const now = normalizedIso(profile.last_updated)
  // 将旧的字符串格式转换为 ProfileField 格式
  const toProfileFields = (values: string[]): ProfileField[] =>
    values.map(v => ({ value: v, evidence_level: 'L2' as const, evidences: [] }))

  return {
    profile_id: profile.contact_id,
    profile_type: 'contact',
    owner_user_id: ownerUserId,
    target_user_id: profile.contact_id,
    conversation_id: profile.contact_id,
    display_name: profile.nickname,
    aliases: profile.nickname ? [profile.nickname] : [],
    traits: toProfileFields(profile.profile.personality_tags),
    personality: [],
    interests: toProfileFields(profile.profile.interests),
    occupation: profile.profile.occupation ? [{ value: profile.profile.occupation, evidence_level: 'L2', evidences: [] }] : [],
    relationship: [],
    way_of_decision_making: [],
    life_habit_preference: [],
    communication_style: [],
    catchphrase: [],
    user_to_friend_catchphrase: [],
    user_to_friend_chat_style: [],
    motivation_system: [],
    fear_system: [],
    value_system: [],
    humor_use: [],
    social_attributes: {
      role: profile.profile.role,
      age_group: profile.profile.age_group || null,
      intimacy_level: profile.relationship_graph.intimacy_level,
      current_status: profile.relationship_graph.current_status,
      intermediary: {
        has_intermediary: profile.relationship_graph.intermediary.has_intermediary,
        name: profile.relationship_graph.intermediary.name ?? null,
        context: profile.relationship_graph.intermediary.context ?? null
      }
    },
    risk_assessment: {
      is_suspicious: profile.risk_assessment.is_suspicious,
      risk_level: profile.risk_assessment.risk_level,
      warning_msg: profile.risk_assessment.warning_msg,
      risk_patterns: [],
      last_checked: now
    },
    metadata: {
      version: 1,
      created_at: now,
      last_updated: now,
      source_memcell_count: 0,
      last_cluster_id: null,
      update_count: 0
    },
    retrieval: null,
    extend: {
      chat_history_summary: profile.chat_history_summary
    }
  }
}

// 从 ProfileField 列表中提取值
function extractProfileFieldValues(fields: (ProfileField | string)[] | undefined): string[] {
  if (!fields) return []
  return fields.map(f => typeof f === 'string' ? f : f.value).filter(v => v)
}

export function convertUnifiedProfileToLegacyUserProfile(profile: UnifiedProfile): UserProfile {
  const occupation = extractProfileFieldValues(profile.occupation)[0] ?? ''
  const catchphrases = extractProfileFieldValues(profile.catchphrase)
  const legacyMsgAvgLength = profile.extend.legacy_msg_avg_length
  const msgAvgLength =
    legacyMsgAvgLength === 'short' ||
    legacyMsgAvgLength === 'medium' ||
    legacyMsgAvgLength === 'long'
      ? legacyMsgAvgLength
      : 'medium'
  const emojiUsage = Array.isArray(profile.extend.legacy_emoji_usage)
    ? profile.extend.legacy_emoji_usage.filter((value): value is string => typeof value === 'string')
    : []
  const punctuationStyle =
    typeof profile.extend.legacy_punctuation_style === 'string'
      ? profile.extend.legacy_punctuation_style
      : ''

  return {
    user_id: profile.owner_user_id,
    base_info: {
      gender:
        profile.extend.legacy_gender === 'male' ||
        profile.extend.legacy_gender === 'female' ||
        profile.extend.legacy_gender === 'other'
          ? (profile.extend.legacy_gender as Gender)
          : 'other',
      occupation: occupation,
      tone_style: (profile.extend.legacy_tone_style as string) ?? 'friendly'
    },
    communication_habits: {
      frequent_phrases: catchphrases,
      emoji_usage: emojiUsage,
      punctuation_style: punctuationStyle,
      msg_avg_length: msgAvgLength
    },
    last_updated: new Date(profile.metadata.last_updated || isoNow()).getTime()
  }
}

export function convertUnifiedProfileToLegacyContactProfile(profile: UnifiedProfile): ContactProfile {
  const summary =
    typeof profile.extend.chat_history_summary === 'string'
      ? profile.extend.chat_history_summary
      : ''

  const traits = extractProfileFieldValues(profile.traits)
  const interests = extractProfileFieldValues(profile.interests)
  const occupation = extractProfileFieldValues(profile.occupation)[0]

  return {
    contact_id: profile.target_user_id || profile.profile_id,
    nickname: profile.display_name,
    profile: {
      role: profile.social_attributes.role,
      age_group: profile.social_attributes.age_group ?? 'unknown',
      personality_tags: traits,
      interests: interests,
      occupation: occupation
    },
    relationship_graph: {
      current_status: profile.social_attributes.current_status,
      intimacy_level: profile.social_attributes.intimacy_level,
      intermediary: {
        has_intermediary: profile.social_attributes.intermediary.has_intermediary,
        name: profile.social_attributes.intermediary.name ?? undefined,
        context: profile.social_attributes.intermediary.context ?? undefined
      }
    },
    chat_history_summary: summary,
    risk_assessment: {
      is_suspicious: profile.risk_assessment?.is_suspicious ?? false,
      risk_level: profile.risk_assessment?.risk_level ?? 'low',
      warning_msg: profile.risk_assessment?.warning_msg ?? ''
    },
    last_updated: new Date(profile.metadata.last_updated || isoNow()).getTime()
  }
}

// ============================================================================
// ContactProfile - Contact's profile with relationship information
// ============================================================================

export const IntimacyLevelSchema = z.enum(['stranger', 'formal', 'close', 'intimate'])
export type IntimacyLevel = z.infer<typeof IntimacyLevelSchema>

export const RiskLevelSchema = z.enum(['low', 'medium', 'high'])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

export const ContactProfileInfoSchema = z.object({
  role: z.string(),
  age_group: z.string(),
  personality_tags: z.array(z.string()),
  interests: z.array(z.string()),
  occupation: z.string().optional()
})
export type ContactProfileInfo = z.infer<typeof ContactProfileInfoSchema>

export const IntermediarySchema = z.object({
  has_intermediary: z.boolean(),
  name: z.string().optional(),
  context: z.string().optional()
})
export type Intermediary = z.infer<typeof IntermediarySchema>

export const RelationshipGraphSchema = z.object({
  current_status: z.string(),
  intimacy_level: IntimacyLevelSchema,
  intermediary: IntermediarySchema
})
export type RelationshipGraph = z.infer<typeof RelationshipGraphSchema>

export const RiskAssessmentSchema = z.object({
  is_suspicious: z.boolean(),
  risk_level: RiskLevelSchema,
  warning_msg: z.string()
})
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>

export const ContactProfileSchema = z.object({
  contact_id: z.string(),
  nickname: z.string(),
  profile: ContactProfileInfoSchema,
  relationship_graph: RelationshipGraphSchema,
  chat_history_summary: z.string(),
  risk_assessment: RiskAssessmentSchema,
  last_updated: z.number()
})
export type ContactProfile = z.infer<typeof ContactProfileSchema>

export const createDefaultContactProfile = (
  contactId: string,
  nickname: string
): ContactProfile => ({
  contact_id: contactId,
  nickname,
  profile: {
    role: 'unknown',
    age_group: 'unknown',
    personality_tags: [],
    interests: [],
    occupation: undefined
  },
  relationship_graph: {
    current_status: 'acquaintance',
    intimacy_level: 'stranger',
    intermediary: {
      has_intermediary: false,
      name: undefined,
      context: undefined
    }
  },
  chat_history_summary: '',
  risk_assessment: {
    is_suspicious: false,
    risk_level: 'low',
    warning_msg: ''
  },
  last_updated: Date.now()
})

// ============================================================================
// IntentAnalysis - Output from Intent Agent
// ============================================================================

export const IntentAnalysisSchema = z.object({
  intent: z.string().min(1),
  mood: z.string().min(1),
  topic: z.string().min(1)
})
export type IntentAnalysis = z.infer<typeof IntentAnalysisSchema>

// ============================================================================
// Suggestion - Reply suggestion from Coach Agent
// ============================================================================

export const SuggestionSchema = z.object({
  content: z.string().min(1),
  reason: z.string().min(1)
})
export type Suggestion = z.infer<typeof SuggestionSchema>

export const SuggestionsArraySchema = z.array(SuggestionSchema).length(3)

// ============================================================================
// AppSettings - Application settings
// ============================================================================

export const MonitorModeSchema = z.enum(['auto', 'accessibility', 'ocr'])
export type MonitorMode = z.infer<typeof MonitorModeSchema>
export const VisualMonitorStrategySchema = z.enum(['manual', 'auto', 'hybrid'])
export type VisualMonitorStrategy = z.infer<typeof VisualMonitorStrategySchema>
export const OcrModelStrategySchema = z.enum(['ocr', 'vlm_structured', 'hybrid'])
export type OcrModelStrategy = z.infer<typeof OcrModelStrategySchema>

export const WindowPositionSchema = z.object({
  x: z.number(),
  y: z.number()
})
export type WindowPosition = z.infer<typeof WindowPositionSchema>

export const FloatingWindowSettingsSchema = z.object({
  opacity: z.number().min(0).max(1),
  width: z.number().positive(),
  height: z.number().positive(),
  position: WindowPositionSchema.nullable(),
  lazyFollow: z.boolean()
})
export type FloatingWindowSettings = z.infer<typeof FloatingWindowSettingsSchema>

export const ModelProviderSettingsSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  modelName: z.string().min(1),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxTokens: z.number().int().min(64).max(32768).default(2000),
  disableThinking: z.boolean().default(true)
})
export type ModelProviderSettings = z.infer<typeof ModelProviderSettingsSchema>

export const ModelProvidersSchema = z.object({
  assistant: ModelProviderSettingsSchema,
  vision: ModelProviderSettingsSchema
})
export type ModelProviders = z.infer<typeof ModelProvidersSchema>

export const ManualRoiSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive()
})
export type ManualRoi = z.infer<typeof ManualRoiSchema>

export const AutoRoiTuningSchema = z.object({
  coarseLeftRatio: z.number().min(0).max(1).default(0.27),
  coarseTopRatio: z.number().min(0).max(1).default(0),
  coarseWidthRatio: z.number().min(0.1).max(1).default(0.71),
  coarseHeightRatio: z.number().min(0.1).max(1).default(0.92)
})
export type AutoRoiTuning = z.infer<typeof AutoRoiTuningSchema>

export const WindowGateTuningSchema = z.object({
  confirmationSamples: z.number().int().min(1).max(5).default(3),
  confirmationIntervalMs: z.number().int().min(0).max(500).default(120)
})
export type WindowGateTuning = z.infer<typeof WindowGateTuningSchema>

export const VisualMonitorCaptureSchemeSchema = z.enum(['legacy', 'current'])
export type VisualMonitorCaptureScheme = z.infer<typeof VisualMonitorCaptureSchemeSchema>

export const VisualMonitorCaptureSensitivitySchema = z.enum(['high', 'medium', 'low'])
export type VisualMonitorCaptureSensitivity = z.infer<typeof VisualMonitorCaptureSensitivitySchema>

export const VisualMonitorCaptureScopeSchema = z.enum(['roi', 'full_window'])
export type VisualMonitorCaptureScope = z.infer<typeof VisualMonitorCaptureScopeSchema>

export const VisualMonitorRoiStrategySchema = z.enum(['manual', 'auto', 'hybrid'])
export type VisualMonitorRoiStrategy = z.infer<typeof VisualMonitorRoiStrategySchema>

export const VisualMonitorCaptureTuningSchema = z.object({
  hashSimilaritySkip: z.number().min(0).max(1).default(0.99),
  ssimChange: z.number().min(0).max(1).default(0.985),
  keptFrameDedupSimilarityThreshold: z.number().min(0).max(1).default(0.99),
  chatRecordCaptureDedupWindowMs: z.number().int().min(1000).max(600000).default(120000)
})
export type VisualMonitorCaptureTuning = z.infer<typeof VisualMonitorCaptureTuningSchema>

function migrateVisualMonitorSettingsInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return input
  }
  const payload = { ...(input as Record<string, unknown>) }
  const legacyCaptureScheme =
    payload.captureScheme === 'current' || payload.captureScheme === 'legacy'
      ? payload.captureScheme
      : null
  if (payload.captureSensitivity !== 'high' && payload.captureSensitivity !== 'medium' && payload.captureSensitivity !== 'low') {
    payload.captureSensitivity = 'medium'
  }
  if (legacyCaptureScheme === null) {
    payload.captureScheme = payload.captureSensitivity === 'high' ? 'legacy' : 'current'
  }
  return payload
}

export const VisualMonitorSettingsSchema = z.preprocess(
  migrateVisualMonitorSettingsInput,
  z.object({
    apiBaseUrl: z.string().min(1),
    monitoredAppName: z.string().min(1).default('WeChat'),
    testingMode: z.boolean().default(false),
    captureSensitivity: VisualMonitorCaptureSensitivitySchema.default('medium'),
    captureScheme: VisualMonitorCaptureSchemeSchema.default('current'),
    captureScope: VisualMonitorCaptureScopeSchema.default('roi'),
    roiStrategy: VisualMonitorRoiStrategySchema.default('hybrid'),
    manualRoi: ManualRoiSchema.nullable().default(null),
    autoRoi: AutoRoiTuningSchema.default({
      coarseLeftRatio: 0.27,
      coarseTopRatio: 0,
      coarseWidthRatio: 0.71,
      coarseHeightRatio: 0.92
    }),
    windowGate: WindowGateTuningSchema.default({
      confirmationSamples: 3,
      confirmationIntervalMs: 120
    }),
    captureTuning: VisualMonitorCaptureTuningSchema.default({
      hashSimilaritySkip: 0.99,
      ssimChange: 0.985,
      keptFrameDedupSimilarityThreshold: 0.99,
      chatRecordCaptureDedupWindowMs: 120000
    })
  })
)
export type VisualMonitorSettings = z.infer<typeof VisualMonitorSettingsSchema>

export const LLMConfigSchema = z.object({
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('gpt-4'),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().min(1).max(32768).default(8192)
})
export type LLMConfig = z.infer<typeof LLMConfigSchema>

export const EverMemOSSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  apiBaseUrl: z.string().min(1).default('http://127.0.0.1:1995'),
  ownerUserId: z.string().min(1).default('self'),
  requestTimeoutMs: z.number().int().min(1000).max(60000).default(12000),
  backfillChunkSize: z.number().int().min(1).max(200).default(20),
  backfillChunkTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
  backfillChunkMessageBudgetSeconds: z.number().int().min(1).max(120).default(3),
  backfillMaxRetryPerChunk: z.number().int().min(0).max(5).default(1),
  backfillMinChunkSize: z.number().int().min(1).max(200).default(5),
  // LLM 配置
  llm: LLMConfigSchema.default({
    baseUrl: '',
    apiKey: '',
    model: 'gpt-4',
    temperature: 0.3,
    maxTokens: 8192
  }),
  // Blacklist of session keys for deleted profiles (prevent auto-recreation)
  deletedProfileSessionKeys: z.array(z.string()).default([]),
  // Last processed timestamp per session (sessionKey -> ISO timestamp)
  // Used to only backfill new messages since last processing
  sessionBackfillProgress: z.record(z.string(), z.string()).default({}),
  // Available accounts for switching
  availableAccounts: z.array(z.object({
    userId: z.string(),
    displayName: z.string()
  })).optional()
})
export type EverMemOSSettings = z.infer<typeof EverMemOSSettingsSchema>

export const StoragePathsSchema = z.object({
  rootDir: z.string().min(1),
  cacheDir: z.string().min(1),
  chatRecordsDir: z.string().min(1),
  memoryLibraryDir: z.string().min(1)
})
export type StoragePaths = z.infer<typeof StoragePathsSchema>

export const ShortcutsSchema = z.object({
  copySuggestion1: z.string(),
  copySuggestion2: z.string(),
  copySuggestion3: z.string()
})
export type Shortcuts = z.infer<typeof ShortcutsSchema>

export const AppSettingsSchema = z.object({
  monitorMode: MonitorModeSchema,
  floatingWindow: FloatingWindowSettingsSchema,
  shortcuts: ShortcutsSchema,
  sessionExpiryHours: z.number().positive(),
  modelProviders: ModelProvidersSchema.default({
    assistant: {
      baseUrl: 'https://litellm.sii.sh.cn/v1',
      apiKey: '',
      modelName: 'sii-dsv3.1',
      requestTimeoutMs: 30000,
      maxTokens: 2000,
      disableThinking: true
    },
    vision: {
      baseUrl: 'https://litellm.sii.sh.cn/v1',
      apiKey: '',
      modelName: 'sii-Qwen3-VL-235B-A22B-Instruct',
      requestTimeoutMs: 30000,
      maxTokens: 2000,
      disableThinking: true
    }
  }),
  visualMonitor: VisualMonitorSettingsSchema.default({
    apiBaseUrl: 'http://127.0.0.1:18777',
    monitoredAppName: 'WeChat',
    testingMode: false,
    captureSensitivity: 'medium',
    captureScheme: 'current',
    captureScope: 'roi',
    roiStrategy: 'hybrid',
    manualRoi: null,
    autoRoi: {
      coarseLeftRatio: 0.27,
      coarseTopRatio: 0,
      coarseWidthRatio: 0.71,
      coarseHeightRatio: 0.92
    },
    windowGate: {
      confirmationSamples: 3,
      confirmationIntervalMs: 120
    },
    captureTuning: {
      hashSimilaritySkip: 0.99,
      ssimChange: 0.985,
      keptFrameDedupSimilarityThreshold: 0.99,
      chatRecordCaptureDedupWindowMs: 120000
    }
  }),
  evermemos: EverMemOSSettingsSchema.default({
    enabled: true,
    apiBaseUrl: 'http://127.0.0.1:1995',
    ownerUserId: 'captain1307',
    requestTimeoutMs: 12000,
    backfillChunkSize: 20,
    backfillChunkTimeoutMs: 60000,
    backfillChunkMessageBudgetSeconds: 3,
    backfillMaxRetryPerChunk: 1,
    backfillMinChunkSize: 5,
    deletedProfileSessionKeys: [],
    sessionBackfillProgress: {},
    availableAccounts: [
      { userId: 'captain1307', displayName: 'Me' },
      { userId: '🌟', displayName: '🌟' }
    ]
  }),
  storagePaths: StoragePathsSchema.default({
    rootDir: './social_copilot',
    cacheDir: './social_copilot/cache',
    chatRecordsDir: './social_copilot/chat_records',
    memoryLibraryDir: './social_copilot/memory_library'
  }),
  onboardingComplete: z.boolean().optional().default(false)
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const DEFAULT_APP_SETTINGS: AppSettings = {
  monitorMode: 'auto',
  floatingWindow: {
    opacity: 0.95,
    width: 320,
    height: 400,
    position: null,
    lazyFollow: true
  },
  shortcuts: {
    copySuggestion1: 'CommandOrControl+1',
    copySuggestion2: 'CommandOrControl+2',
    copySuggestion3: 'CommandOrControl+3'
  },
  sessionExpiryHours: 3,
  modelProviders: {
    assistant: {
      baseUrl: 'https://litellm.sii.sh.cn/v1',
      apiKey: '',
      modelName: 'sii-dsv3.1',
      requestTimeoutMs: 30000,
      maxTokens: 2000,
      disableThinking: true
    },
    vision: {
      baseUrl: 'https://litellm.sii.sh.cn/v1',
      apiKey: '',
      modelName: 'sii-Qwen3-VL-235B-A22B-Instruct',
      requestTimeoutMs: 30000,
      maxTokens: 2000,
      disableThinking: true
    }
  },
  visualMonitor: {
    apiBaseUrl: 'http://127.0.0.1:18777',
    monitoredAppName: 'WeChat',
    testingMode: false,
    captureSensitivity: 'high',
    captureScheme: 'legacy',
    captureScope: 'roi',
    roiStrategy: 'hybrid',
    manualRoi: null,
    autoRoi: {
      coarseLeftRatio: 0.27,
      coarseTopRatio: 0,
      coarseWidthRatio: 0.71,
      coarseHeightRatio: 0.92
    },
    windowGate: {
      confirmationSamples: 3,
      confirmationIntervalMs: 120
    },
    captureTuning: {
      hashSimilaritySkip: 0.99,
      ssimChange: 0.985,
      keptFrameDedupSimilarityThreshold: 0.99,
      chatRecordCaptureDedupWindowMs: 120000
    }
  },
  evermemos: {
    enabled: true,
    apiBaseUrl: 'http://127.0.0.1:1995',
    ownerUserId: 'captain1307',
    requestTimeoutMs: 12000,
    backfillChunkSize: 20,
    backfillChunkTimeoutMs: 60000,
    backfillChunkMessageBudgetSeconds: 3,
    backfillMaxRetryPerChunk: 1,
    backfillMinChunkSize: 5,
    llm: {
      baseUrl: '',
      apiKey: '',
      model: 'gpt-4',
      temperature: 0.3,
      maxTokens: 8192
    },
    deletedProfileSessionKeys: [],
    sessionBackfillProgress: {},
    availableAccounts: [
      { userId: 'captain1307', displayName: 'captain1307' },
      { userId: '🌟', displayName: '🌟' }
    ]
  },
  storagePaths: {
    rootDir: './social_copilot',
    cacheDir: './social_copilot/cache',
    chatRecordsDir: './social_copilot/chat_records',
    memoryLibraryDir: './social_copilot/memory_library'
  },
  onboardingComplete: false
}

// ============================================================================
// Serialization/Deserialization Functions
// ============================================================================

export function serializeRawMessage(message: RawMessage): string {
  return JSON.stringify(message)
}

export function deserializeRawMessage(json: string): RawMessage {
  const parsed = JSON.parse(json)
  return RawMessageSchema.parse(parsed)
}

export function serializeRawMessages(messages: RawMessage[]): string {
  return JSON.stringify(messages)
}

export function deserializeRawMessages(json: string): RawMessage[] {
  const parsed = JSON.parse(json)
  return z.array(RawMessageSchema).parse(parsed)
}

export function serializeMessageBlock(block: MessageBlock): string {
  return JSON.stringify(block)
}

export function deserializeMessageBlock(json: string): MessageBlock {
  const parsed = JSON.parse(json)
  return MessageBlockSchema.parse(parsed)
}

export function serializeMessageBlocks(blocks: MessageBlock[]): string {
  return JSON.stringify(blocks)
}

export function deserializeMessageBlocks(json: string): MessageBlock[] {
  const parsed = JSON.parse(json)
  return z.array(MessageBlockSchema).parse(parsed)
}

export function serializeParsedMessage(message: ParsedMessage): string {
  return JSON.stringify({
    ...message,
    timestamp: message.timestamp.toISOString()
  })
}

export function deserializeParsedMessage(json: string): ParsedMessage {
  const parsed = JSON.parse(json)
  return ParsedMessageSchema.parse(parsed)
}

export function serializeParsedMessages(messages: ParsedMessage[]): string {
  return JSON.stringify(
    messages.map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString()
    }))
  )
}

export function deserializeParsedMessages(json: string): ParsedMessage[] {
  const parsed = JSON.parse(json)
  return z.array(ParsedMessageSchema).parse(parsed)
}

export function serializeUserProfile(profile: UserProfile): string {
  return JSON.stringify(profile)
}

export function deserializeUserProfile(json: string): UserProfile {
  const parsed = JSON.parse(json)
  return UserProfileSchema.parse(parsed)
}

export function serializeContactProfile(profile: ContactProfile): string {
  return JSON.stringify(profile)
}

export function deserializeContactProfile(json: string): ContactProfile {
  const parsed = JSON.parse(json)
  return ContactProfileSchema.parse(parsed)
}

export function serializeUnifiedProfile(profile: UnifiedProfile): string {
  return JSON.stringify(profile)
}

export function deserializeUnifiedProfile(json: string): UnifiedProfile {
  const parsed = JSON.parse(json)
  return UnifiedProfileSchema.parse(parsed)
}

export function serializeIntentAnalysis(analysis: IntentAnalysis): string {
  return JSON.stringify(analysis)
}

export function deserializeIntentAnalysis(json: string): IntentAnalysis {
  const parsed = JSON.parse(json)
  return IntentAnalysisSchema.parse(parsed)
}

export function serializeSuggestion(suggestion: Suggestion): string {
  return JSON.stringify(suggestion)
}

export function deserializeSuggestion(json: string): Suggestion {
  const parsed = JSON.parse(json)
  return SuggestionSchema.parse(parsed)
}

export function serializeSuggestions(suggestions: Suggestion[]): string {
  return JSON.stringify(suggestions)
}

export function deserializeSuggestions(json: string): Suggestion[] {
  const parsed = JSON.parse(json)
  return z.array(SuggestionSchema).parse(parsed)
}

export function serializeAppSettings(settings: AppSettings): string {
  return JSON.stringify(settings)
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const baseVal = base[key]
    const overVal = override[key]
    if (
      overVal !== null &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>)
    } else {
      result[key] = overVal
    }
  }
  return result
}

export function deserializeAppSettings(json: string): AppSettings {
  const parsed = JSON.parse(json)
  const merged = deepMerge(DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>, parsed as Record<string, unknown>)
  return AppSettingsSchema.parse(merged)
}

// ============================================================================
// Validation Functions
// ============================================================================

export function validateRawMessage(
  data: unknown
): { success: true; data: RawMessage } | { success: false; error: z.ZodError } {
  const result = RawMessageSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateMessageBlock(
  data: unknown
): { success: true; data: MessageBlock } | { success: false; error: z.ZodError } {
  const result = MessageBlockSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateParsedMessage(
  data: unknown
): { success: true; data: ParsedMessage } | { success: false; error: z.ZodError } {
  const result = ParsedMessageSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateUserProfile(
  data: unknown
): { success: true; data: UserProfile } | { success: false; error: z.ZodError } {
  const result = UserProfileSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateContactProfile(
  data: unknown
): { success: true; data: ContactProfile } | { success: false; error: z.ZodError } {
  const result = ContactProfileSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateUnifiedProfile(
  data: unknown
): { success: true; data: UnifiedProfile } | { success: false; error: z.ZodError } {
  const result = UnifiedProfileSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateIntentAnalysis(
  data: unknown
): { success: true; data: IntentAnalysis } | { success: false; error: z.ZodError } {
  const result = IntentAnalysisSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateSuggestion(
  data: unknown
): { success: true; data: Suggestion } | { success: false; error: z.ZodError } {
  const result = SuggestionSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

export function validateAppSettings(
  data: unknown
): { success: true; data: AppSettings } | { success: false; error: z.ZodError } {
  const result = AppSettingsSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}
