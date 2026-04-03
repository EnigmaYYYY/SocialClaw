# Memory Operations Guide

## Scope

This document explains how to operate the memory side of SocialClaw.

It focuses on the current user-facing workflows that already exist in the product:

- importing old chat records
- backfilling old chat records into memory
- viewing friend profiles
- adding friend profiles
- editing and saving friend information
- deleting friend profiles

It also briefly covers two higher-level maintenance actions:

- regenerating profiles
- clearing profile contents

This is an operations guide, not an internal architecture document.

## Where These Features Live

Most memory-side operations are available from the **Memory Library** / **Profile Library** area in the Electron app.

That panel currently provides:

- old-chat import
- old-chat backfill
- backfill session selection
- profile browsing
- profile editing
- single and batch deletion
- profile regeneration
- profile clearing

## 1. Import Old Chat Records

Use this when you already have exported WeChat history and want SocialClaw to ingest it.

Supported practical inputs include:

- `WeChatMsg` exports
- `wechatDataBackup` exports
- decrypted SQLite files
- supported CSV exports

From the UI:

1. open the **Memory Library** / **Profile Library**
2. find the **Import Old Chat Records** area
3. either:
   - drag a file or folder into the upload panel
   - click **Select File**
   - click **Select Folder**
4. choose the exported file or folder you want to import
5. wait for the import progress to complete

What happens during import:

1. SocialClaw reads the exported chat data
2. it normalizes the messages
3. it writes them into local `chat_records`
4. it automatically triggers an initial memory backfill pass

So import is not only file ingestion. It is also the first memory initialization step.

## 2. Backfill Old Chat Records

Use this when:

- you already imported chat records earlier
- new chat-record files have been added
- you want to rebuild or continue profile generation from local `chat_records`

From the UI:

1. open **Memory Library** / **Profile Library**
2. click **Backfill Old Chat**

This reads from the local `chat_records` storage and regenerates memory-side profile updates from those stored records.

### Selecting Which Sessions To Backfill

If you do not want to backfill everything:

1. click **Select Backfill Sessions**
2. review the listed sessions
3. choose specific sessions with checkboxes
4. click **Backfill Old Chat**

Each listed session shows:

- session name
- pending message count
- total message count
- last processed timestamp, when available

This is the right path when you only want to refresh a subset of contacts instead of all imported history.

## 3. View Friend Information

To view friend information:

1. open **Memory Library** / **Profile Library**
2. use the left-side profile list
3. choose a profile from the **Friends** section

Once selected, the detail panel on the right lets you inspect several tabs:

- `Profile`
- `Episodes`
- `Foresights`
- `MemCell`

### What You Can See In The Profile Tab

The `Profile` tab is the main friend-information view.

It includes editable or readable fields such as:

- display name
- aliases
- target user ID
- conversation ID
- intimacy level
- role
- current status
- age group
- occupation
- traits
- interests
- communication style
- catchphrases
- intermediary information
- risk level and risk warning

It also exposes system metadata such as:

- profile ID
- owner user ID
- creation time
- last updated time
- source MemCell count

### What The Other Tabs Show

- `Episodes`: higher-level episodic memories associated with the friend
- `Foresights`: future-oriented memory items
- `MemCell`: segmented conversation units and their underlying message slices

These tabs are useful when you want to understand not only the current profile fields, but also the evidence trail and generated memory structure behind them.

## 4. Add a New Friend Profile

To manually add a new friend profile:

1. open **Memory Library** / **Profile Library**
2. click **New Friend**
3. a local draft profile will be created immediately
4. edit the fields you need
5. click **Save**

Important behavior:

- `New Friend` creates a draft entry first
- the profile is not fully committed until you click **Save**

This is the right path when:

- you want to add a contact before enough chat history exists
- you want to manually create or seed a profile
- you want to maintain profile information that was not inferred automatically

## 5. Edit and Save Friend Information

To update an existing friend profile:

1. select the friend from the **Friends** list
2. stay on the `Profile` tab
3. edit the relevant fields
4. click **Save**

Typical editable fields include:

- display name
- aliases
- intimacy level
- role and status
- occupation
- relationship
- traits
- interests
- communication style
- catchphrases
- value / motivation / fear system fields
- intermediary information
- risk assessment fields

Use this when the automatically generated profile is incomplete, outdated, or simply not precise enough.

## 6. Delete Friend Information

### Delete a Single Friend Profile

To delete one friend profile:

1. select the friend profile
2. click **Delete** in the detail panel
3. confirm the deletion

You can also delete from the context menu on a profile item in the list.

### Batch Delete Multiple Profiles

To batch delete:

1. click **Batch Selection**
2. check the profiles you want to remove
3. click **Delete Selected**
4. confirm the deletion

Use batch deletion carefully, especially after large imports or backfill runs.

## 7. Regenerate Profiles

The **Regenerate Profiles** action is a higher-level maintenance tool.

Use it when:

- profile results look inconsistent
- you want to rebuild profile outputs from the current memory-side intermediate data
- you changed memory-generation logic and want a fresh profile pass

From the UI:

1. open **Memory Library** / **Profile Library**
2. click **Regenerate Profiles**
3. confirm the action

This is broader than simply backfilling old chat history.

## 8. Clear Profiles

The **Clear Profiles** action clears profile field contents while preserving the basic identity shell.

Use it when:

- you want to reset profile contents without deleting the profile entries themselves
- you want to keep IDs and names but remove generated profile details

From the UI:

1. open **Memory Library** / **Profile Library**
2. click **Clear Profiles**
3. confirm the action

This is a destructive maintenance action and should be used carefully.

## 9. Recommended Operating Patterns

### Recommended First-Time Flow

If you are setting up memory from scratch:

1. import old chat records
2. let the automatic initialization run
3. run **Backfill Old Chat** again if needed
4. review the generated friend profiles
5. manually fix high-value profiles

### Recommended Ongoing Flow

For ongoing use:

1. import new historical exports when needed
2. use **Select Backfill Sessions** if you only want to refresh specific contacts
3. manually edit important profiles after backfill
4. use deletion only when a profile is genuinely wrong or obsolete

## 10. Practical Notes

- Import and backfill are related but not identical operations.
- Import writes exported history into local `chat_records` and also triggers an initialization pass.
- Backfill works from the existing local `chat_records` store.
- `New Friend` creates a draft first; remember to click **Save**.
- Deleting a profile is different from clearing a profile.
- `Regenerate Profiles` and `Clear Profiles` are maintenance actions, not normal day-to-day actions.

## Bottom Line

If you only remember the main workflow, remember this:

1. **Import old chats** when you have exported history
2. **Backfill old chats** when you want to rebuild memory from local chat records
3. **View and edit friend profiles** in the Profile Library
4. **Use New Friend + Save** to add manual profile entries
5. **Use Delete carefully**, especially in batch mode
