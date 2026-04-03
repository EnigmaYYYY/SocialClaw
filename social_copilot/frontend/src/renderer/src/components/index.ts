/**
 * Components Index
 *
 * Exports all UI components for the Social Copilot application
 */
export { ChatInputArea } from './ChatInputArea'
export { SuggestionPanel } from './SuggestionPanel'
export { ContactSelector } from './ContactSelector'
export { UserProfileSettings } from './UserProfileSettings'

// Floating Window Components (Task 20)
export { FloatingWindow } from './FloatingWindow'
export type { FloatingWindowProps, Suggestion, IntentAnalysis, RiskAssessment, AppStatus } from './FloatingWindow'
export { SuggestionCard } from './SuggestionCard'
export type { SuggestionCardProps } from './SuggestionCard'
export { StatusIndicator } from './StatusIndicator'
export type { StatusIndicatorProps } from './StatusIndicator'
export { RiskWarningBanner } from './RiskWarningBanner'
export type { RiskWarningBannerProps } from './RiskWarningBanner'
export { MinimizedBubble } from './MinimizedBubble'
export type { MinimizedBubbleProps } from './MinimizedBubble'
export { CopyToast } from './CopyToast'
export type { CopyToastProps } from './CopyToast'
export { SettingsPanel } from './SettingsPanel'
export type { SettingsPanelProps, MonitorMode } from './SettingsPanel'

// Onboarding Wizard (Task 22)
export { OnboardingWizard } from './OnboardingWizard'
export type { OnboardingWizardProps, OnboardingResult, OnboardingStep } from './OnboardingWizard'
