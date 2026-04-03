export interface ImportSelectionFileLike {
  path?: string
  name: string
  webkitRelativePath?: string
}

export function resolveImportPathFromFiles(files: ArrayLike<ImportSelectionFileLike>): string | null {
  const candidates = Array.from(files)
    .map((file) => normalizeImportPath(file.path ?? file.webkitRelativePath ?? ''))
    .filter((path) => path.length > 0)

  if (candidates.length === 0) {
    return null
  }

  if (candidates.length === 1) {
    return candidates[0]
  }

  const commonDirectory = findCommonDirectory(candidates)
  return commonDirectory || candidates[0]
}

function normalizeImportPath(value: string): string {
  return value.trim().replace(/\\/g, '/')
}

function findCommonDirectory(paths: string[]): string | null {
  const directoryParts = paths.map((path) => splitDirectory(path))
  if (directoryParts.length === 0) {
    return null
  }

  let sharedRoot = directoryParts[0].root
  let sharedSegments = [...directoryParts[0].segments]

  for (let index = 1; index < directoryParts.length; index += 1) {
    const next = directoryParts[index]
    if (next.root !== sharedRoot) {
      return null
    }

    let segmentCount = Math.min(sharedSegments.length, next.segments.length)
    while (segmentCount > 0) {
      const current = sharedSegments.slice(0, segmentCount).join('/')
      const candidate = next.segments.slice(0, segmentCount).join('/')
      if (current === candidate) {
        break
      }
      segmentCount -= 1
    }

    sharedSegments = sharedSegments.slice(0, segmentCount)
  }

  if (sharedSegments.length === 0) {
    return sharedRoot || null
  }

  return buildPath(sharedRoot, sharedSegments)
}

function splitDirectory(path: string): { root: string; segments: string[] } {
  const normalized = normalizeImportPath(path)
  const lastSlash = normalized.lastIndexOf('/')
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash) : normalized
  return splitPath(directory)
}

function splitPath(path: string): { root: string; segments: string[] } {
  const normalized = normalizeImportPath(path)
  if (!normalized) {
    return { root: '', segments: [] }
  }

  if (/^[A-Za-z]:\//.test(normalized)) {
    const root = normalized.slice(0, 3)
    const tail = normalized.slice(3)
    return { root, segments: tail.split('/').filter(Boolean) }
  }

  if (normalized.startsWith('/')) {
    return { root: '/', segments: normalized.slice(1).split('/').filter(Boolean) }
  }

  return { root: '', segments: normalized.split('/').filter(Boolean) }
}

function buildPath(root: string, segments: string[]): string {
  if (segments.length === 0) {
    return root
  }

  if (root === '/') {
    return `/${segments.join('/')}`
  }

  if (/^[A-Za-z]:\/$/.test(root)) {
    return `${root}${segments.join('/')}`
  }

  return [root, ...segments].filter(Boolean).join('/')
}
