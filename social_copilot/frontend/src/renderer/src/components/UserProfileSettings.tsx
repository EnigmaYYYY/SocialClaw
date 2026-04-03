/**
 * UserProfileSettings Component - User Profile Management Panel
 *
 * Form for editing base_info (gender, occupation, tone_style)
 * Form for editing communication_habits
 * Save changes to local storage
 *
 * Validates: Requirements 4.2
 */
import { useState, useEffect, useCallback } from 'react'

interface UserProfile {
  user_id: string
  base_info: {
    gender: 'male' | 'female' | 'other'
    occupation: string
    tone_style: string
  }
  communication_habits: {
    frequent_phrases: string[]
    emoji_usage: string[]
    punctuation_style: string
    msg_avg_length: 'short' | 'medium' | 'long'
  }
  last_updated: number
}

interface UserProfileSettingsProps {
  isOpen: boolean
  onClose: () => void
}

export function UserProfileSettings({ isOpen, onClose }: UserProfileSettingsProps): JSX.Element | null {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [newPhrase, setNewPhrase] = useState('')

  // Load user profile on mount
  useEffect(() => {
    if (isOpen) {
      loadProfile()
    }
  }, [isOpen])

  const loadProfile = async (): Promise<void> => {
    setIsLoading(true)
    try {
      if (window.electronAPI) {
        const loadedProfile = await window.electronAPI.loadUserProfile()
        setProfile(loadedProfile)
      }
    } catch (error) {
      console.error('Failed to load user profile:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = useCallback(async (): Promise<void> => {
    if (!profile) return

    setIsSaving(true)
    setSaveStatus('idle')

    try {
      if (window.electronAPI) {
        await window.electronAPI.saveUserProfile(profile)
        setSaveStatus('success')
        setTimeout(() => setSaveStatus('idle'), 2000)
      }
    } catch (error) {
      console.error('Failed to save user profile:', error)
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }, [profile])

  const handleGenderChange = (gender: 'male' | 'female' | 'other'): void => {
    if (!profile) return
    setProfile({
      ...profile,
      base_info: { ...profile.base_info, gender }
    })
  }

  const handleOccupationChange = (occupation: string): void => {
    if (!profile) return
    setProfile({
      ...profile,
      base_info: { ...profile.base_info, occupation }
    })
  }

  const handleToneStyleChange = (tone_style: string): void => {
    if (!profile) return
    setProfile({
      ...profile,
      base_info: { ...profile.base_info, tone_style }
    })
  }

  const handleMsgLengthChange = (msg_avg_length: 'short' | 'medium' | 'long'): void => {
    if (!profile) return
    setProfile({
      ...profile,
      communication_habits: { ...profile.communication_habits, msg_avg_length }
    })
  }

  const handleAddPhrase = (): void => {
    if (!profile || !newPhrase.trim()) return
    setProfile({
      ...profile,
      communication_habits: {
        ...profile.communication_habits,
        frequent_phrases: [...profile.communication_habits.frequent_phrases, newPhrase.trim()]
      }
    })
    setNewPhrase('')
  }

  const handleRemovePhrase = (index: number): void => {
    if (!profile) return
    const newPhrases = profile.communication_habits.frequent_phrases.filter((_, i) => i !== index)
    setProfile({
      ...profile,
      communication_habits: {
        ...profile.communication_habits,
        frequent_phrases: newPhrases
      }
    })
  }

  if (!isOpen) return null

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>用户设置</h2>
          <button type="button" className="close-button" onClick={onClose}>
            ✕
          </button>
        </div>

        {isLoading ? (
          <div className="settings-loading">
            <div className="spinner"></div>
            <span>加载中...</span>
          </div>
        ) : profile ? (
          <div className="settings-content">
            {/* Base Info Section */}
            <section className="settings-section">
              <h3>基本信息</h3>

              <div className="form-group">
                <label>性别</label>
                <div className="radio-group">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="gender"
                      value="male"
                      checked={profile.base_info.gender === 'male'}
                      onChange={() => handleGenderChange('male')}
                    />
                    <span>男</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="gender"
                      value="female"
                      checked={profile.base_info.gender === 'female'}
                      onChange={() => handleGenderChange('female')}
                    />
                    <span>女</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="gender"
                      value="other"
                      checked={profile.base_info.gender === 'other'}
                      onChange={() => handleGenderChange('other')}
                    />
                    <span>其他</span>
                  </label>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="occupation">职业</label>
                <input
                  type="text"
                  id="occupation"
                  value={profile.base_info.occupation}
                  onChange={(e) => handleOccupationChange(e.target.value)}
                  placeholder="例如: 软件工程师"
                />
              </div>

              <div className="form-group">
                <label htmlFor="tone_style">语气风格</label>
                <input
                  type="text"
                  id="tone_style"
                  value={profile.base_info.tone_style}
                  onChange={(e) => handleToneStyleChange(e.target.value)}
                  placeholder="例如: friendly, casual"
                />
                <span className="form-hint">描述你希望回复建议采用的语气风格</span>
              </div>
            </section>

            {/* Communication Habits Section */}
            <section className="settings-section">
              <h3>沟通习惯</h3>

              <div className="form-group">
                <label>消息长度偏好</label>
                <div className="radio-group">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="msg_length"
                      value="short"
                      checked={profile.communication_habits.msg_avg_length === 'short'}
                      onChange={() => handleMsgLengthChange('short')}
                    />
                    <span>简短</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="msg_length"
                      value="medium"
                      checked={profile.communication_habits.msg_avg_length === 'medium'}
                      onChange={() => handleMsgLengthChange('medium')}
                    />
                    <span>适中</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="msg_length"
                      value="long"
                      checked={profile.communication_habits.msg_avg_length === 'long'}
                      onChange={() => handleMsgLengthChange('long')}
                    />
                    <span>详细</span>
                  </label>
                </div>
              </div>

              <div className="form-group">
                <label>常用短语</label>
                <div className="phrase-list">
                  {profile.communication_habits.frequent_phrases.map((phrase, index) => (
                    <div key={index} className="phrase-tag">
                      <span>{phrase}</span>
                      <button
                        type="button"
                        className="remove-phrase"
                        onClick={() => handleRemovePhrase(index)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <div className="add-phrase">
                  <input
                    type="text"
                    value={newPhrase}
                    onChange={(e) => setNewPhrase(e.target.value)}
                    placeholder="添加常用短语"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleAddPhrase()
                      }
                    }}
                  />
                  <button type="button" onClick={handleAddPhrase} disabled={!newPhrase.trim()}>
                    添加
                  </button>
                </div>
                <span className="form-hint">这些短语会帮助 AI 更好地模仿你的说话风格</span>
              </div>
            </section>

            {/* Save Button */}
            <div className="settings-actions">
              <button
                type="button"
                className={`save-button ${saveStatus}`}
                onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? '保存中...' : saveStatus === 'success' ? '已保存 ✓' : '保存设置'}
              </button>
              {saveStatus === 'error' && (
                <span className="save-error">保存失败，请重试</span>
              )}
            </div>
          </div>
        ) : (
          <div className="settings-error">
            <p>无法加载用户设置</p>
            <button type="button" onClick={loadProfile}>
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
