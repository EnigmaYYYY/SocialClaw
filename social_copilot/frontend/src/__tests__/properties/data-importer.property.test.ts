/**
 * Property-Based Tests for DataImporter
 *
 * **Feature: social-copilot-v2, Property 1: Data Format Detection**
 * **Validates: Requirements 1.2**
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fc from 'fast-check'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { DataImporter } from '../../services/data-importer'

// Test directory for creating temporary test files
let testDir: string

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `data-importer-test-${Date.now()}`)
  await fs.promises.mkdir(testDir, { recursive: true })
})

afterAll(async () => {
  // Clean up test directory
  try {
    await fs.promises.rm(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

// ============================================================================
// Arbitrary Generators for Test Data
// ============================================================================

// Generator for valid WeChatMsg CSV content
const wechatMsgCSVContentArbitrary = fc
  .record({
    msgId: fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
      minLength: 1,
      maxLength: 20
    }),
    typeName: fc.constantFrom('文本', '图片', '语音', '视频', '系统消息'),
    sender: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes(',') && !s.includes('\n')),
    time: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-12-31') }).map(
      (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    ),
    content: fc.string({ minLength: 0, maxLength: 100 }).filter((s) => !s.includes('\n'))
  })
  .map(({ msgId, typeName, sender, time, content }) => {
    // Escape content for CSV (wrap in quotes if contains comma)
    const escapedContent = content.includes(',') ? `"${content.replace(/"/g, '""')}"` : content
    return `${msgId},${typeName},${sender},${time},${escapedContent},备注,昵称,more`
  })

// Generator for array of CSV rows
const wechatMsgCSVRowsArbitrary = fc.array(wechatMsgCSVContentArbitrary, { minLength: 1, maxLength: 10 })

// Generator for wechatDataBackup folder structure indicator
const wechatDataBackupStructureArbitrary = fc.record({
  hasMultiFolder: fc.boolean(),
  dbFileCount: fc.integer({ min: 1, max: 3 })
})

// ============================================================================
// Helper Functions
// ============================================================================

async function createWeChatMsgCSVFile(dir: string, rows: string[]): Promise<string> {
  const header = '消息ID,类型,发送人,时间,内容,备注,昵称,更多信息'
  const content = [header, ...rows].join('\n')
  const filePath = path.join(dir, `test_${Date.now()}.csv`)
  // Write with BOM for utf-8-sig encoding
  await fs.promises.writeFile(filePath, '\uFEFF' + content, 'utf-8')
  return filePath
}

async function createWechatDataBackupStructure(
  dir: string,
  hasMultiFolder: boolean,
  dbFileCount: number
): Promise<string> {
  const rootDir = path.join(dir, `wechatbackup_${Date.now()}`)
  await fs.promises.mkdir(rootDir, { recursive: true })

  const msgDir = path.join(rootDir, 'Msg')
  await fs.promises.mkdir(msgDir, { recursive: true })

  if (hasMultiFolder) {
    const multiDir = path.join(msgDir, 'Multi')
    await fs.promises.mkdir(multiDir, { recursive: true })

    // Create SQLite database files with valid header
    for (let i = 0; i < dbFileCount; i++) {
      const dbName = i === 0 ? 'MSG.db' : `MSG${i}.db`
      const dbPath = path.join(multiDir, dbName)
      // Write SQLite header
      const sqliteHeader = Buffer.from('SQLite format 3\0')
      await fs.promises.writeFile(dbPath, sqliteHeader)
    }
  } else {
    // Create MSG.db directly in Msg folder
    const dbPath = path.join(msgDir, 'MSG.db')
    const sqliteHeader = Buffer.from('SQLite format 3\0')
    await fs.promises.writeFile(dbPath, sqliteHeader)
  }

  return rootDir
}

async function createDecryptedDBFile(dir: string): Promise<string> {
  const filePath = path.join(dir, `decrypted_${Date.now()}.db`)
  // Write SQLite header
  const sqliteHeader = Buffer.from('SQLite format 3\0')
  await fs.promises.writeFile(filePath, sqliteHeader)
  return filePath
}

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 1: Data Format Detection', () => {
  const importer = new DataImporter()

  /**
   * **Feature: social-copilot-v2, Property 1: Data Format Detection**
   * **Validates: Requirements 1.2**
   *
   * *For any* valid WeChatMsg CSV file with proper header,
   * the Data Importer SHALL detect it as 'wechatmsg_csv' format.
   */
  it('should detect WeChatMsg CSV format for any valid CSV file with proper header', async () => {
    await fc.assert(
      fc.asyncProperty(wechatMsgCSVRowsArbitrary, async (rows) => {
        const filePath = await createWeChatMsgCSVFile(testDir, rows)

        try {
          const format = await importer.detectFormat(filePath)
          expect(format).toBe('wechatmsg_csv')
        } finally {
          // Cleanup
          await fs.promises.unlink(filePath).catch(() => {})
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 1: Data Format Detection**
   * **Validates: Requirements 1.2**
   *
   * *For any* valid wechatDataBackup folder structure with MSG.db files,
   * the Data Importer SHALL detect it as 'wechatdatabackup' format.
   */
  it('should detect wechatDataBackup format for any valid folder structure', async () => {
    await fc.assert(
      fc.asyncProperty(wechatDataBackupStructureArbitrary, async ({ hasMultiFolder, dbFileCount }) => {
        const folderPath = await createWechatDataBackupStructure(testDir, hasMultiFolder, dbFileCount)

        try {
          const format = await importer.detectFormat(folderPath)
          expect(format).toBe('wechatdatabackup')
        } finally {
          // Cleanup
          await fs.promises.rm(folderPath, { recursive: true, force: true }).catch(() => {})
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 1: Data Format Detection**
   * **Validates: Requirements 1.2**
   *
   * *For any* valid SQLite database file,
   * the Data Importer SHALL detect it as 'decrypted_db' format.
   */
  it('should detect decrypted_db format for any valid SQLite file', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const filePath = await createDecryptedDBFile(testDir)

        try {
          const format = await importer.detectFormat(filePath)
          expect(format).toBe('decrypted_db')
        } finally {
          // Cleanup
          await fs.promises.unlink(filePath).catch(() => {})
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 1: Data Format Detection**
   * **Validates: Requirements 1.2**
   *
   * *For any* non-existent path,
   * the Data Importer SHALL return 'unknown' format.
   */
  it('should return unknown format for non-existent paths', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('/') && !s.includes('\\')),
        async (randomName) => {
          const nonExistentPath = path.join(testDir, `nonexistent_${randomName}_${Date.now()}`)

          const format = await importer.detectFormat(nonExistentPath)
          expect(format).toBe('unknown')
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 1: Data Format Detection**
   * **Validates: Requirements 1.2**
   *
   * *For any* file without valid format markers,
   * the Data Importer SHALL return 'unknown' format.
   */
  it('should return unknown format for files without valid format markers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }).filter(
          (s) => !s.startsWith('消息ID') && !s.startsWith('SQLite format 3')
        ),
        async (content) => {
          const filePath = path.join(testDir, `unknown_${Date.now()}.txt`)
          await fs.promises.writeFile(filePath, content, 'utf-8')

          try {
            const format = await importer.detectFormat(filePath)
            expect(format).toBe('unknown')
          } finally {
            // Cleanup
            await fs.promises.unlink(filePath).catch(() => {})
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 1: Data Format Detection**
   * **Validates: Requirements 1.2**
   *
   * Format detection is idempotent: detecting the same path multiple times
   * SHALL always return the same format.
   */
  it('should be idempotent - same path always returns same format', async () => {
    await fc.assert(
      fc.asyncProperty(wechatMsgCSVRowsArbitrary, async (rows) => {
        const filePath = await createWeChatMsgCSVFile(testDir, rows)

        try {
          const format1 = await importer.detectFormat(filePath)
          const format2 = await importer.detectFormat(filePath)
          const format3 = await importer.detectFormat(filePath)

          expect(format1).toBe(format2)
          expect(format2).toBe(format3)
        } finally {
          // Cleanup
          await fs.promises.unlink(filePath).catch(() => {})
        }
      }),
      { numRuns: 100 }
    )
  })
})
