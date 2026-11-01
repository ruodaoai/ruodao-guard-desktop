import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { QuarantineItem, QuarantineResult, ThreatItem } from '@shared/types'

interface QuarantineRecord extends QuarantineItem {
  storedName: string
}

interface QuarantineIndex {
  items: QuarantineRecord[]
}

function basePaths(dataDir: string) {
  const root = path.join(dataDir, 'quarantine')
  return {
    root,
    files: path.join(root, 'files'),
    index: path.join(root, 'index.json')
  }
}

async function readIndex(dataDir: string): Promise<QuarantineRecord[]> {
  const paths = basePaths(dataDir)
  try {
    const text = await fs.readFile(paths.index, 'utf8')
    const parsed = JSON.parse(text) as QuarantineIndex
    if (!Array.isArray(parsed.items)) return []
    return parsed.items.filter(
      (item) =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.storedName === 'string' &&
        typeof item.originalPath === 'string'
    )
  } catch {
    return []
  }
}

async function writeIndex(dataDir: string, records: QuarantineRecord[]): Promise<void> {
  const paths = basePaths(dataDir)
  await fs.mkdir(paths.root, { recursive: true })
  const temp = `${paths.index}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify({ items: records } satisfies QuarantineIndex, null, 2), 'utf8')
  await fs.rename(temp, paths.index)
}

export async function listQuarantine(dataDir: string): Promise<QuarantineItem[]> {
  const records = await readIndex(dataDir)
  return records
    .map(({ storedName: _storedName, ...rest }) => rest)
    .sort((a, b) => b.quarantinedAt - a.quarantinedAt)
}

export async function quarantineFiles(dataDir: string, threats: ThreatItem[]): Promise<QuarantineResult> {
  const paths = basePaths(dataDir)
  await fs.mkdir(paths.files, { recursive: true })
  const records = await readIndex(dataDir)
  const failed: Array<{ path: string; error: string }> = []
  let quarantined = 0

  for (const threat of threats) {
    try {
      const stat = await fs.lstat(threat.path)
      if (!stat.isFile()) throw new Error('目标不是普通文件')
      const id = `q_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
      const storedName = `${id}.bin`
      const destination = path.join(paths.files, storedName)
      await fs.copyFile(threat.path, destination)
      try {
        await fs.unlink(threat.path)
      } catch (error) {
        await fs.unlink(destination).catch(() => undefined)
        throw error
      }
      records.push({
        id,
        storedName,
        threatName: threat.name,
        originalPath: threat.path,
        size: stat.size,
        quarantinedAt: Date.now()
      })
      quarantined++
    } catch (error) {
      failed.push({ path: threat.path, error: (error as Error).message })
    }
  }

  await writeIndex(dataDir, records)
  return { quarantined, failed }
}

export async function restoreQuarantine(dataDir: string, ids: string[]): Promise<{ restored: number; failed: string[] }> {
  const wanted = new Set(ids)
  const paths = basePaths(dataDir)
  const records = await readIndex(dataDir)
  const failed: string[] = []
  let restored = 0
  const remaining: QuarantineRecord[] = []

  for (const record of records) {
    if (!wanted.has(record.id)) {
      remaining.push(record)
      continue
    }
    const storedPath = path.join(paths.files, record.storedName)
    try {
      await fs.access(storedPath)
      const originalDir = path.dirname(record.originalPath)
      await fs.mkdir(originalDir, { recursive: true })
      let destination = record.originalPath
      try {
        await fs.access(destination)
        const ext = path.extname(destination)
        const base = path.basename(destination, ext)
        destination = path.join(originalDir, `${base}.restored-${Date.now()}${ext}`)
      } catch {
        // destination is free
      }
      await fs.copyFile(storedPath, destination)
      await fs.unlink(storedPath)
      restored++
    } catch (error) {
      failed.push(`${record.originalPath}：${(error as Error).message}`)
      remaining.push(record)
    }
  }

  await writeIndex(dataDir, remaining)
  return { restored, failed }
}

export async function deleteQuarantine(dataDir: string, ids: string[]): Promise<{ deleted: number; failed: string[] }> {
  const wanted = new Set(ids)
  const paths = basePaths(dataDir)
  const records = await readIndex(dataDir)
  const failed: string[] = []
  let deleted = 0
  const remaining: QuarantineRecord[] = []

  for (const record of records) {
    if (!wanted.has(record.id)) {
      remaining.push(record)
      continue
    }
    try {
      await fs.unlink(path.join(paths.files, record.storedName)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      deleted++
    } catch (error) {
      failed.push(`${record.originalPath}：${(error as Error).message}`)
      remaining.push(record)
    }
  }

  await writeIndex(dataDir, remaining)
  return { deleted, failed }
}
