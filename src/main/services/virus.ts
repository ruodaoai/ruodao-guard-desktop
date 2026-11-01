import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ActionResult,
  ScanHistoryItem,
  ScanMode,
  ScanProgress,
  ScanState,
  ScanSummary,
  ThreatItem,
  VirusScanOptions
} from '@shared/types'
import { DEMO_MARKER, DEMO_SAMPLE_NAME, EICAR_PREFIX, SIGNATURES } from '../data/signatures'
import { quarantineFiles } from './quarantine'
import { getStartupFolderPaths } from './startup'
import { getSystemSnapshot } from './system'

export interface VirusScanContext {
  dataDir: string
  desktop: string
  downloads: string
}

interface CandidateFile {
  path: string
  size: number
  mtimeMs: number
}

interface ScanHandle {
  cancelled: boolean
  startedAt: number
  mode: ScanMode
}

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.sys',
  '.scr',
  '.com',
  '.pif',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.hta',
  '.msi',
  '.jar',
  '.lnk'
])

const DOUBLE_EXTENSION =
  /\.(doc|docx|xls|xlsx|ppt|pptx|pdf|jpg|jpeg|png|gif|txt|mp3|mp4|zip|rar)\.(exe|scr|com|pif|bat|cmd|js|vbs|wsf|hta)$/i

const SKIP_DIR_NAMES = new Set([
  'winsxs',
  'servicing',
  'driverstore',
  'system volume information',
  '$recycle.bin',
  'recovery',
  'windows.old'
])

const SKIP_FILE_NAMES = new Set([
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log',
  'dumpstack.log.tmp'
])

const SCAN_LIMITS: Record<ScanMode, number> = {
  quick: 20000,
  custom: 50000,
  full: 60000
}

const SIGNATURE_BY_HASH = new Map(SIGNATURES.map((signature) => [signature.sha256, signature]))

let activeScan: ScanHandle | null = null
let currentProgress: ScanProgress | null = null
let lastSummary: ScanSummary | null = null
const progressListeners = new Set<(progress: ScanProgress) => void>()

export function onScanProgress(listener: (progress: ScanProgress) => void): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

function emitProgress(progress: ScanProgress): void {
  currentProgress = progress
  for (const listener of progressListeners) listener(progress)
}

function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = path.resolve(child).toLowerCase()
  const normalizedParent = path.resolve(parent).toLowerCase()
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function makeThreatId(file: CandidateFile): string {
  return createHash('sha1').update(`${file.path}|${file.mtimeMs}|${file.size}`).digest('hex').slice(0, 16)
}

function dangerThreat(
  file: CandidateFile,
  spec: {
    name: string
    category: ThreatItem['category']
    severity: ThreatItem['severity']
    kind: ThreatItem['kind']
    description: string
    sha256?: string
  }
): ThreatItem {
  return {
    id: makeThreatId(file),
    path: file.path,
    name: spec.name,
    category: spec.category,
    severity: spec.severity,
    kind: spec.kind,
    description: spec.description,
    size: file.size,
    modifiedAt: Math.round(file.mtimeMs),
    sha256: spec.sha256
  }
}

function filenameHeuristic(file: CandidateFile): ThreatItem | null {
  const base = path.basename(file.path)
  if (!DOUBLE_EXTENSION.test(base)) return null
  return dangerThreat(file, {
    name: 'Heuristic.DoubleExtension',
    category: 'riskware',
    severity: 'high',
    kind: 'heuristic',
    description: '文件名使用了双重扩展名伪装成文档或图片，这是钓鱼木马的常见手法'
  })
}

function signatureThreat(file: CandidateFile, sha256: string): ThreatItem | null {
  const record = SIGNATURE_BY_HASH.get(sha256)
  if (!record) return null
  return dangerThreat(file, {
    name: record.name,
    category: record.category,
    severity: record.severity,
    kind: 'signature',
    description: record.description,
    sha256
  })
}

function testMarkerThreat(file: CandidateFile): ThreatItem {
  return dangerThreat(file, {
    name: DEMO_SAMPLE_NAME,
    category: 'test',
    severity: 'low',
    kind: 'test',
    description: '若道安全卫士演示测试样本，不包含可执行代码，用于验证查杀与隔离流程'
  })
}

async function analyzeFile(file: CandidateFile): Promise<ThreatItem | null> {
  const extension = path.extname(file.path).toLowerCase()
  const executable = EXECUTABLE_EXTENSIONS.has(extension)
  const heuristic = filenameHeuristic(file)
  const bufferLimit = executable ? 32 * 1024 * 1024 : 128 * 1024

  if (file.size <= bufferLimit) {
    const buffer = await fs.readFile(file.path)
    const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8')
    if (head.includes(DEMO_MARKER)) return testMarkerThreat(file)
    if (head.startsWith(EICAR_PREFIX)) {
      return dangerThreat(file, {
        name: 'EICAR-Test-File',
        category: 'test',
        severity: 'medium',
        kind: 'signature',
        description: 'EICAR 标准防病毒测试文件，不含恶意代码，用于验证查杀引擎'
      })
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const matched = signatureThreat(file, sha256)
    if (matched) return matched
    return heuristic
  }

  if (executable && file.size <= 128 * 1024 * 1024) {
    const sha256 = await hashFile(file.path)
    return signatureThreat(file, sha256) || heuristic
  }

  return heuristic
}

function shouldSkipDirectory(fullPath: string, excludedRoots: string[]): boolean {
  const name = path.basename(fullPath).toLowerCase()
  if (SKIP_DIR_NAMES.has(name)) return true
  return excludedRoots.some((root) => isPathInside(fullPath, root))
}

async function resolveTargets(
  options: VirusScanOptions,
  context: VirusScanContext
): Promise<{ targets: string[]; label: string }> {
  const existingDirs = async (candidates: string[]): Promise<string[]> => {
    const unique = [...new Set(candidates.filter(Boolean))]
    const result: string[] = []
    for (const candidate of unique) {
      try {
        const stat = await fs.stat(candidate)
        if (stat.isDirectory()) result.push(candidate)
      } catch {
        // ignore inaccessible or missing folders
      }
    }
    return result
  }

  if (options.mode === 'custom') {
    const target = (options.target || '').trim()
    if (!target) throw new Error('请先选择要查杀的文件夹')
    const resolved = path.resolve(target)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new Error('所选路径不是有效文件夹')
    return { targets: [resolved], label: resolved }
  }

  if (options.mode === 'full') {
    const snapshot = await getSystemSnapshot()
    const roots = snapshot.disks.map((disk) => `${disk.id}\\`)
    const targets = await existingDirs(roots)
    if (targets.length === 0) throw new Error('未能读取本地磁盘信息')
    return { targets, label: '全部本地磁盘' }
  }

  const startup = getStartupFolderPaths()
  const targets = await existingDirs([
    startup.user,
    startup.common,
    context.desktop,
    context.downloads,
    os.tmpdir()
  ])
  if (targets.length === 0) throw new Error('未能定位常用扫描目录')
  return { targets, label: '桌面、下载、临时目录与启动项' }
}

async function enumerateFiles(
  targets: string[],
  limit: number,
  excludedRoots: string[],
  scan: ScanHandle,
  onProgress: (count: number, currentPath: string) => void
): Promise<{ files: CandidateFile[]; skipped: number; truncated: boolean }> {
  const files: CandidateFile[] = []
  let skipped = 0
  let truncated = false
  let lastEmit = 0
  // 每个扫描根目录至少分到一份配额，避免临时目录耗尽上限后漏扫桌面与下载
  const perTarget = Math.max(1500, Math.floor(limit / Math.max(1, targets.length)))

  const emitProgress = (currentPath: string, force = false): void => {
    if (!force && Date.now() - lastEmit <= 250) return
    lastEmit = Date.now()
    onProgress(files.length, currentPath)
  }

  for (let index = 0; index < targets.length; index++) {
    if (scan.cancelled) break
    if (files.length >= limit) {
      truncated = true
      break
    }
    const target = targets[index]
    const cap = index === targets.length - 1 ? limit - files.length : Math.min(perTarget, limit - files.length)
    const targetStart = files.length
    const stack = [target]

    while (stack.length > 0) {
      if (scan.cancelled) break
      if (files.length - targetStart >= cap) {
        truncated = true
        break
      }
      const dir = stack.pop()!
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        skipped++
        continue
      }
      for (const entry of entries) {
        if (scan.cancelled) break
        if (files.length - targetStart >= cap) {
          truncated = true
          break
        }
        if (entry.isSymbolicLink()) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (shouldSkipDirectory(fullPath, excludedRoots)) continue
          try {
            const stat = await fs.lstat(fullPath)
            if (stat.isSymbolicLink()) continue
          } catch {
            skipped++
            continue
          }
          stack.push(fullPath)
        } else if (entry.isFile()) {
          if (SKIP_FILE_NAMES.has(entry.name.toLowerCase())) continue
          if (excludedRoots.some((root) => isPathInside(fullPath, root))) continue
          try {
            const stat = await fs.stat(fullPath)
            files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs })
          } catch {
            skipped++
          }
          emitProgress(fullPath)
        }
      }
    }
    emitProgress(target, true)
  }

  return { files, skipped, truncated }
}

export async function startVirusScan(options: VirusScanOptions, context: VirusScanContext): Promise<ScanSummary> {
  if (activeScan) throw new Error('已有查杀任务正在进行中，请先停止当前任务')
  if (!['quick', 'full', 'custom'].includes(options.mode)) throw new Error('未知的查杀模式')

  const scan: ScanHandle = { cancelled: false, startedAt: Date.now(), mode: options.mode }
  activeScan = scan

  const baseProgress = (): ScanProgress => ({
    running: true,
    mode: options.mode,
    phase: 'preparing',
    percent: 1,
    filesScanned: 0,
    filesTotal: 0,
    currentPath: '',
    threatsFound: 0,
    elapsedMs: Date.now() - scan.startedAt,
    bytesScanned: 0
  })
  emitProgress(baseProgress())

  try {
    const { targets, label } = await resolveTargets(options, context)
    const excludedRoots = [context.dataDir]
    let filesTotal = 0

    emitProgress({
      ...baseProgress(),
      phase: 'preparing',
      percent: 2,
      currentPath: '正在建立文件索引…'
    })

    const enumeration = await enumerateFiles(targets, SCAN_LIMITS[options.mode], excludedRoots, scan, (count, currentPath) => {
      filesTotal = count
      emitProgress({
        ...baseProgress(),
        percent: Math.min(8, 2 + Math.floor(count / 3000)),
        filesTotal: count,
        currentPath,
        elapsedMs: Date.now() - scan.startedAt
      })
    })
    filesTotal = enumeration.files.length

    let processed = 0
    let skipped = enumeration.skipped
    let bytesScanned = 0
    const threats: ThreatItem[] = []
    let nextIndex = 0
    let lastEmit = 0

    const emitScanning = (currentPath: string): void => {
      emitProgress({
        running: true,
        mode: options.mode,
        phase: 'scanning',
        percent: filesTotal === 0 ? 95 : 8 + Math.floor((processed / filesTotal) * 88),
        filesScanned: processed,
        filesTotal,
        currentPath,
        threatsFound: threats.length,
        elapsedMs: Date.now() - scan.startedAt,
        bytesScanned
      })
    }

    const worker = async (): Promise<void> => {
      while (!scan.cancelled) {
        const index = nextIndex++
        if (index >= enumeration.files.length) break
        const file = enumeration.files[index]
        try {
          const threat = await analyzeFile(file)
          if (threat) threats.push(threat)
        } catch {
          skipped++
        }
        processed++
        bytesScanned += file.size
        if (Date.now() - lastEmit > 120) {
          lastEmit = Date.now()
          emitScanning(file.path)
        }
      }
    }

    emitScanning(enumeration.files[0]?.path || '')
    await Promise.all(Array.from({ length: 4 }, () => worker()))

    emitProgress({
      running: true,
      mode: options.mode,
      phase: 'finalizing',
      percent: 99,
      filesScanned: processed,
      filesTotal,
      currentPath: '正在整理查杀结果…',
      threatsFound: threats.length,
      elapsedMs: Date.now() - scan.startedAt,
      bytesScanned
    })

    const finishedAt = Date.now()
    const summary: ScanSummary = {
      id: `scan_${finishedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      mode: options.mode,
      target: label,
      startedAt: scan.startedAt,
      finishedAt,
      scannedFiles: processed,
      skippedFiles: skipped,
      threats,
      cancelled: scan.cancelled
    }
    lastSummary = summary

    emitProgress({
      running: false,
      mode: options.mode,
      phase: scan.cancelled ? 'cancelled' : 'done',
      percent: 100,
      filesScanned: processed,
      filesTotal,
      currentPath: '',
      threatsFound: threats.length,
      elapsedMs: finishedAt - scan.startedAt,
      bytesScanned
    })

    await appendScanHistory(context.dataDir, summary).catch(() => undefined)
    return summary
  } finally {
    activeScan = null
  }
}

export async function cancelVirusScan(): Promise<void> {
  if (activeScan) activeScan.cancelled = true
}

export function getScanState(): ScanState {
  return {
    active: activeScan !== null,
    progress: activeScan ? currentProgress : null,
    last: lastSummary
  }
}

export function getLastScanSummary(): ScanSummary | null {
  return lastSummary
}

export async function quarantineScanThreats(
  threatIds: string[],
  dataDir: string
): Promise<{ quarantined: number; failed: Array<{ path: string; error: string }> }> {
  if (!lastSummary) return { quarantined: 0, failed: [] }
  const wanted = new Set(threatIds)
  const targets = lastSummary.threats.filter((threat) => wanted.has(threat.id))
  if (targets.length === 0) return { quarantined: 0, failed: [] }

  const result = await quarantineFiles(dataDir, targets)
  const failedPaths = new Set(result.failed.map((entry) => entry.path))
  const removedIds = new Set(targets.filter((threat) => !failedPaths.has(threat.path)).map((threat) => threat.id))

  if (removedIds.size > 0) {
    lastSummary = {
      ...lastSummary,
      threats: lastSummary.threats.filter((threat) => !removedIds.has(threat.id))
    }
  }
  return result
}

async function appendScanHistory(dataDir: string, summary: ScanSummary): Promise<void> {
  const file = path.join(dataDir, 'scan-history.json')
  let items: ScanHistoryItem[] = []
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (Array.isArray(parsed)) items = parsed
  } catch {
    // start fresh
  }
  items.unshift({
    id: summary.id,
    mode: summary.mode,
    target: summary.target,
    completedAt: summary.finishedAt,
    scannedFiles: summary.scannedFiles,
    threats: summary.threats.length,
    durationMs: summary.finishedAt - summary.startedAt,
    cancelled: summary.cancelled
  })
  items = items.slice(0, 20)
  await fs.mkdir(dataDir, { recursive: true })
  const temp = `${file}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(items, null, 2), 'utf8')
  await fs.rename(temp, file)
}

export async function readScanHistory(dataDir: string): Promise<ScanHistoryItem[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataDir, 'scan-history.json'), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item.id === 'string')
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, 20)
  } catch {
    return []
  }
}

export async function createTestSample(downloadsDir: string): Promise<ActionResult & { path?: string }> {
  try {
    await fs.mkdir(downloadsDir, { recursive: true })
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
    const filePath = path.join(downloadsDir, `若道安全卫士-测试样本-${stamp}.txt`)
    const content = [
      DEMO_MARKER,
      '',
      '这是若道安全卫士生成的测试样本，用于验证查杀与隔离流程。',
      '文件内容仅为纯文本，不包含任何可执行代码，可放心删除。',
      '',
      `生成时间：${new Date().toLocaleString('zh-CN')}`
    ].join('\r\n')
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
    return { ok: true, message: '测试样本已生成，使用“快速查杀”即可检测到它', path: filePath }
  } catch (error) {
    return { ok: false, message: `生成测试样本失败：${(error as Error).message}` }
  }
}
