/**
 * ContactSelector Component
 *
 * Displays contact list and allows switching between contacts
 * Validates: Requirements 7.1, 7.4
 */
import { useState, useEffect } from 'react'

interface ContactProfile {
  contact_id: string
  nickname: string
  chat_history_summary: string
  risk_assessment: {
    is_suspicious: boolean
    warning_msg: string
  }
}

interface ContactSelectorProps {
  contacts: string[]
  selectedContactId: string | null
  onSelectContact: (contactId: string) => void
  onLoadContactProfile: (contactId: string) => Promise<ContactProfile | null>
  isLoading: boolean
}

export function ContactSelector({
  contacts,
  selectedContactId,
  onSelectContact,
  onLoadContactProfile,
  isLoading
}: ContactSelectorProps): JSX.Element {
  const [contactProfiles, setContactProfiles] = useState<Map<string, ContactProfile>>(new Map())
  const [loadingContacts, setLoadingContacts] = useState<Set<string>>(new Set())

  useEffect(() => {
    const loadProfiles = async (): Promise<void> => {
      for (const contactId of contacts) {
        if (!contactProfiles.has(contactId)) {
          setLoadingContacts((prev) => new Set(prev).add(contactId))
          const profile = await onLoadContactProfile(contactId)
          if (profile) {
            setContactProfiles((prev) => new Map(prev).set(contactId, profile))
          }
          setLoadingContacts((prev) => {
            const next = new Set(prev)
            next.delete(contactId)
            return next
          })
        }
      }
    }
    void loadProfiles()
  }, [contacts, onLoadContactProfile, contactProfiles])

  const handleSelectContact = (contactId: string): void => {
    onSelectContact(contactId)
  }

  return (
    <aside className="contact-selector">
      <h2>联系人</h2>

      {isLoading && (
        <div className="loading-contacts">
          <span>加载中...</span>
        </div>
      )}

      {!isLoading && contacts.length === 0 && (
        <p className="empty-state">暂无联系人</p>
      )}

      {!isLoading && contacts.length > 0 && (
        <ul className="contact-list">
          {contacts.map((contactId) => {
            const profile = contactProfiles.get(contactId)
            const isSelected = selectedContactId === contactId
            const isContactLoading = loadingContacts.has(contactId)

            return (
              <li
                key={contactId}
                className={`contact-item ${isSelected ? 'selected' : ''} ${profile?.risk_assessment.is_suspicious ? 'suspicious' : ''}`}
                onClick={() => handleSelectContact(contactId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    handleSelectContact(contactId)
                  }
                }}
              >
                <div className="contact-name">
                  {isContactLoading ? contactId : profile?.nickname || contactId}
                </div>
                {profile?.risk_assessment.is_suspicious && (
                  <span className="suspicious-badge" title={profile.risk_assessment.warning_msg}>
                    ⚠️
                  </span>
                )}
                {isSelected && profile?.chat_history_summary && (
                  <div className="contact-summary">{profile.chat_history_summary}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
