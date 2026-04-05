import { mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { cleanupLocalData } from './cleanup-local-data'

async function makeTempDir(prefix: string): Promise<string> {
  const base = join(tmpdir(), `socialclaw-${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`)
  await mkdir(base, { recursive: true })
  return base
}

describe('cleanupLocalData', () => {
  const createdRoots: string[] = []

  afterEach(async () => {
    for (const root of createdRoots.splice(0)) {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes chat messages older than cutoff while keeping undated messages and foreign-owner files', async () => {
    const root = await makeTempDir('cleanup-chat')
    createdRoots.push(root)

    const chatRecordsDir = join(root, 'chat_records')
    const cacheDir = join(root, 'cache')
    await mkdir(join(chatRecordsDir, 'Wechat'), { recursive: true })
    await mkdir(cacheDir, { recursive: true })

    const mainSessionPath = join(chatRecordsDir, 'Wechat', 'Alice.json')
    const oldOnlySessionPath = join(chatRecordsDir, 'Wechat', 'OldOnly.json')
    const foreignSessionPath = join(chatRecordsDir, 'Wechat', 'Foreign.json')

    await writeFile(
      mainSessionPath,
      JSON.stringify(
        {
          owner_user_id: 'u1',
          session_name: 'Alice',
          session_key: 'Wechat::Alice',
          updated_at: '2026-04-01T00:00:00.000Z',
          messages: [
            { message_id: 'old-ts', timestamp: '2026-04-01T00:00:00.000Z', metadata: {} },
            { message_id: 'recent-ts', timestamp: '2026-04-06T01:00:00.000Z', metadata: {} },
            {
              message_id: 'old-capture',
              timestamp: null,
              metadata: { capture_timestamp: '2026-04-01T03:00:00.000Z' }
            },
            { message_id: 'unknown-time', timestamp: null, metadata: {} }
          ]
        },
        null,
        2
      ),
      'utf-8'
    )

    await writeFile(
      oldOnlySessionPath,
      JSON.stringify(
        {
          owner_user_id: 'u1',
          session_name: 'OldOnly',
          session_key: 'Wechat::OldOnly',
          updated_at: '2026-04-01T00:00:00.000Z',
          messages: [{ message_id: 'old-only', timestamp: '2026-04-01T00:00:00.000Z', metadata: {} }]
        },
        null,
        2
      ),
      'utf-8'
    )

    await writeFile(
      foreignSessionPath,
      JSON.stringify(
        {
          owner_user_id: 'u2',
          session_name: 'Foreign',
          session_key: 'Wechat::Foreign',
          updated_at: '2026-04-01T00:00:00.000Z',
          messages: [{ message_id: 'foreign-old', timestamp: '2026-04-01T00:00:00.000Z', metadata: {} }]
        },
        null,
        2
      ),
      'utf-8'
    )

    const result = await cleanupLocalData({
      chatRecordsDir,
      cacheDir,
      ownerUserId: 'u1',
      cutoffIso: '2026-04-05T00:00:00.000Z',
      activeCacheRunDir: null
    })

    expect(result.chat.deletedMessages).toBe(3)
    expect(result.chat.deletedFiles).toBe(1)

    const remainingMain = JSON.parse(await readFile(mainSessionPath, 'utf-8')) as {
      messages: Array<{ message_id: string }>
    }
    expect(remainingMain.messages.map((item) => item.message_id)).toEqual(['recent-ts', 'unknown-time'])

    const foreignRaw = JSON.parse(await readFile(foreignSessionPath, 'utf-8')) as {
      messages: unknown[]
    }
    expect(foreignRaw.messages).toHaveLength(1)

    await expect(stat(oldOnlySessionPath)).rejects.toBeDefined()
  })

  it('cleans cache files older than cutoff and skips active monitor run directory', async () => {
    const root = await makeTempDir('cleanup-cache')
    createdRoots.push(root)

    const chatRecordsDir = join(root, 'chat_records')
    const cacheDir = join(root, 'cache')
    const activeRunDir = join(cacheDir, 'monitor_frames_20260406_101010')
    const oldFilePath = join(cacheDir, 'old.log')
    const newFilePath = join(cacheDir, 'new.log')
    const activeFilePath = join(activeRunDir, 'frame-old.png')
    const oldEmptyDir = join(cacheDir, 'old-empty-dir')

    await mkdir(chatRecordsDir, { recursive: true })
    await mkdir(activeRunDir, { recursive: true })
    await mkdir(oldEmptyDir, { recursive: true })
    await writeFile(oldFilePath, 'old', 'utf-8')
    await writeFile(newFilePath, 'new', 'utf-8')
    await writeFile(activeFilePath, 'active-old', 'utf-8')

    const oldTime = new Date('2026-04-01T00:00:00.000Z')
    const newTime = new Date('2026-04-06T01:00:00.000Z')
    await utimes(oldFilePath, oldTime, oldTime)
    await utimes(activeFilePath, oldTime, oldTime)
    await utimes(oldEmptyDir, oldTime, oldTime)
    await utimes(newFilePath, newTime, newTime)

    const result = await cleanupLocalData({
      chatRecordsDir,
      cacheDir,
      ownerUserId: 'u1',
      cutoffIso: '2026-04-05T00:00:00.000Z',
      activeCacheRunDir: activeRunDir
    })

    expect(result.cache.deletedFiles).toBe(1)
    expect(result.cache.deletedDirs).toBeGreaterThanOrEqual(1)
    expect(result.cache.skippedActiveRunDir).toBe(true)

    await expect(stat(oldFilePath)).rejects.toBeDefined()
    await expect(stat(oldEmptyDir)).rejects.toBeDefined()
    await expect(stat(newFilePath)).resolves.toBeDefined()
    await expect(stat(activeFilePath)).resolves.toBeDefined()
  })
})
