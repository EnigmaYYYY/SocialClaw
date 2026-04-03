import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

let cachedEnvPath: string | null | undefined
let loaded = false

function looksLikeSocialClawRoot(dirPath: string): boolean {
  return existsSync(join(dirPath, 'social_copilot')) && existsSync(join(dirPath, 'memory'))
}

function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const equalIndex = withoutExport.indexOf('=')
    if (equalIndex <= 0) {
      continue
    }

    const key = withoutExport.slice(0, equalIndex).trim()
    let value = withoutExport.slice(equalIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

export function findSocialClawEnvPath(startDir: string = __dirname): string | null {
  if (cachedEnvPath !== undefined) {
    return cachedEnvPath
  }

  const visited = new Set<string>()
  const preferredMatches: string[] = []
  const fallbackMatches: string[] = []
  const startCandidates = [resolve(startDir), process.cwd()]

  for (const candidate of startCandidates) {
    let current = candidate
    while (!visited.has(current)) {
      visited.add(current)
      const envPath = join(current, '.env')
      if (existsSync(envPath)) {
        if (looksLikeSocialClawRoot(current)) {
          preferredMatches.push(envPath)
        } else {
          fallbackMatches.push(envPath)
        }
      }

      const parent = dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
  }

  cachedEnvPath = preferredMatches[0] ?? fallbackMatches[0] ?? null
  return cachedEnvPath
}

export function ensureSocialClawEnvLoaded(startDir: string = __dirname): string | null {
  if (loaded) {
    return cachedEnvPath ?? null
  }

  const envPath = findSocialClawEnvPath(startDir)
  if (!envPath) {
    loaded = true
    return null
  }

  const raw = readFileSync(envPath, 'utf-8')
  const values = parseEnvFile(raw)
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) {
      process.env[key] = value
    }
  }

  loaded = true
  return envPath
}
