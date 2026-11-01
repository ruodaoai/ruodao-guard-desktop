import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CleanCategoryResult,
  CleanResult,
  JunkCategory,
  JunkCategoryId,
  JunkReport
} from '@shared/types'

interface ScanRoot {
  path: string
  includeFile?: RegExp
}

interface CategorySpec {
  id: JunkCategoryId
  name: string
  description: string
  roots: ScanRoot[]
  note?: string
}

interface CollectedFile {
  path: string
  size: number
}

const MAX_FILES_PER_CATEGORY = 40000
const SCAN_DEADLINE_MS = 11000

let lastReport: { at: number; report: JunkReport } | null = null

function localAppData(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}

function exists(p: string): Promise<boolean> {
  return fs
    .access(p, constants.F_OK)
    .then(() => true)
    .catch(() => false)
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

async function chromiumCacheRoots(userDataDir: string): Promise<ScanRoot[]> {
  if (!(await exists(userDataDir))) return []
  const roots: ScanRoot[] = []
  const profiles = await listDirs(userDataDir)
  for (const profile of profiles) {
    for (const sub of ['Cache', 'Code Cache', 'GPUCache']) {
      const candidate = path.join(profile, sub)
      if (await exists(candidate)) roots.push({ path: candidate })
    }
  }
  for (const sub of ['ShaderCache', 'GrShaderCache']) {
    const candidate = path.join(userDataDir, sub)
    if (await exists(candidate)) roots.push({ path: candidate })
  }
  return roots
}

async function firefoxCacheRoots(): Promise<ScanRoot[]> {
  const base = path.join(localAppData(), 'Mozilla', 'Firefox', 'Profiles')
  const roots: ScanRoot[] = []
  for (const profile of await listDirs(base)) {
    const cache = path.join(profile, 'cache2')
    if (await exists(cache)) roots.push({ path: cache })
  }
  return roots
}

async function buildCategories(): Promise<CategorySpec[]> {
  const lad = localAppData()
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const userTemp = os.tmpdir()

  const browserRoots = [
    ...(await chromiumCacheRoots(path.join(lad, 'Google', 'Chrome', 'User Data'))),
    ...(await chromiumCacheRoots(path.join(lad, 'Microsoft', 'Edge', 'User Data'))),
    ...(await chromiumCacheRoots(path.join(lad, 'BraveSoftware', 'Brave-Browser', 'User Data'))),
    ...(await chromiumCacheRoots(path.join(lad, '360Chrome', 'Chrome', 'User Data'))),
    ...(await firefoxCacheRoots())
  ]
  const inetCache = path.join(lad, 'Microsoft', 'Windows', 'INetCache')
  if (await exists(inetCache)) browserRoots.push({ path: inetCache })

  const categories: CategorySpec[] = [
    {
      id: 'user-temp',
      name: '用户临时文件',
      description: '软件安装、运行过程中残留的临时数据，可以安全清理',
      roots: [{ path: userTemp }]
    },
    {
      id: 'system-temp',
      name: '系统临时文件',
      description: 'Windows 临时目录中的日志与安装残留',
      roots: [{ path: path.join(systemRoot, 'Temp') }],
      note: '部分系统文件受保护，清理时会自动跳过'
    },
    {
      id: 'browser-cache',
      name: '浏览器缓存',
      description: '网页图片、脚本与着色器缓存，清理后网页首次加载会稍慢',
      roots: browserRoots
    },
    {
      id: 'thumbnails',
      name: '缩略图缓存',
      description: '资源管理器缩略图数据库，删除后系统会自动重建',
      roots: [{ path: path.join(lad, 'Microsoft', 'Windows', 'Explorer'), includeFile: /^(thumbcache|iconcache).*\.db$/i }]
    },
    {
      id: 'crash-dumps',
      name: '崩溃转储文件',
      description: '程序异常退出时产生的转储与错误报告，不影响系统使用',
      roots: [
        { path: path.join(lad, 'CrashDumps') },
        { path: path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive') },
        { path: path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue') },
        { path: path.join(systemRoot, 'Minidump') }
      ]
    }
  ]

  for (const category of categories) {
    const alive: ScanRoot[] = []
    for (const root of category.roots) {
      if (root.path && (await exists(root.path))) alive.push(root)
    }
    category.roots = alive
  }
  return categories
}

interface CollectOutcome {
  files: CollectedFile[]
  bytes: number
  count: number
  accessErrors: number
  truncated: boolean
}

async function collectFiles(roots: ScanRoot[], deadline: number): Promise<CollectOutcome> {
  const files: CollectedFile[] = []
  let bytes = 0
  let accessErrors = 0
  let truncated = false
  const stack: Array<{ path: string; includeFile?: RegExp }> = roots.map((root) => ({ ...root }))

  while (stack.length > 0) {
    if (files.length >= MAX_FILES_PER_CATEGORY || Date.now() > deadline) {
      truncated = true
      break
    }
    const current = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(current.path, { withFileTypes: true })
    } catch {
      accessErrors++
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(current.path, entry.name)
      if (entry.isDirectory()) {
        try {
          const stat = await fs.lstat(fullPath)
          if (stat.isSymbolicLink()) continue
          stack.push({ path: fullPath })
        } catch {
          accessErrors++
        }
      } else if (entry.isFile()) {
        if (current.includeFile && !current.includeFile.test(entry.name)) continue
        try {
          const stat = await fs.stat(fullPath)
          files.push({ path: fullPath, size: stat.size })
          bytes += stat.size
        } catch {
          accessErrors++
        }
      }
    }
  }

  return { files, bytes, count: files.length, accessErrors, truncated }
}

function topItems(files: CollectedFile[], limit = 8) {
  return [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((file) => ({ path: file.path, bytes: file.size }))
}

async function scanCategory(spec: CategorySpec, deadline: number): Promise<JunkCategory> {
  const outcome = await collectFiles(spec.roots, deadline)
  const notes: string[] = []
  if (spec.note) notes.push(spec.note)
  if (spec.roots.length === 0) notes.push('未检测到对应缓存目录')
  if (outcome.truncated) notes.push('文件较多，仅统计了部分结果')
  if (outcome.accessErrors > 0) notes.push(`${outcome.accessErrors} 个文件或目录无权访问`)
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    bytes: outcome.bytes,
    files: outcome.count,
    items: topItems(outcome.files),
    available: spec.roots.length > 0,
    note: notes.length > 0 ? notes.join('；') : undefined
  }
}

export async function scanJunk(maxAgeMs = 0): Promise<JunkReport> {
  if (maxAgeMs > 0 && lastReport && Date.now() - lastReport.at < maxAgeMs) {
    return lastReport.report
  }
  const specs = await buildCategories()
  const deadline = Date.now() + SCAN_DEADLINE_MS
  const categories: JunkCategory[] = []
  for (const spec of specs) {
    categories.push(await scanCategory(spec, deadline))
  }
  const report: JunkReport = {
    scannedAt: Date.now(),
    totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
    totalFiles: categories.reduce((sum, c) => sum + c.files, 0),
    categories
  }
  lastReport = { at: Date.now(), report }
  return report
}

export function getLastJunkReport(): JunkReport | null {
  return lastReport?.report ?? null
}

async function deleteBatch(files: CollectedFile[], deadline: number) {
  let freedBytes = 0
  let deletedFiles = 0
  let skippedFiles = 0
  const errors: string[] = []
  let index = 0
  const workerCount = 6

  const worker = async (): Promise<void> => {
    while (index < files.length) {
      if (Date.now() > deadline) {
        skippedFiles += files.length - index
        index = files.length
        break
      }
      const file = files[index++]
      try {
        await fs.unlink(file.path)
        freedBytes += file.size
        deletedFiles++
      } catch (error) {
        skippedFiles++
        if (errors.length < 6) {
          const reason = (error as NodeJS.ErrnoException).code === 'EPERM' ? '正在被占用' : (error as Error).message
          errors.push(`${file.path}（${reason}）`)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return { freedBytes, deletedFiles, skippedFiles, errors }
}

export async function cleanJunk(ids: JunkCategoryId[]): Promise<CleanResult> {
  const wanted = new Set(ids)
  const specs = (await buildCategories()).filter((spec) => wanted.has(spec.id))
  const deadline = Date.now() + 25000
  const categoryResults: CleanCategoryResult[] = []
  const allErrors: string[] = []
  let totalFreed = 0
  let totalDeleted = 0
  let totalSkipped = 0

  for (const spec of specs) {
    const collected = await collectFiles(spec.roots, deadline)
    const outcome = await deleteBatch(collected.files, deadline)
    totalFreed += outcome.freedBytes
    totalDeleted += outcome.deletedFiles
    totalSkipped += outcome.skippedFiles
    allErrors.push(...outcome.errors)
    categoryResults.push({
      id: spec.id,
      name: spec.name,
      freedBytes: outcome.freedBytes,
      deletedFiles: outcome.deletedFiles,
      skippedFiles: outcome.skippedFiles
    })
  }

  lastReport = null
  const report = await scanJunk()
  return {
    freedBytes: totalFreed,
    deletedFiles: totalDeleted,
    skippedFiles: totalSkipped,
    errors: allErrors,
    categories: categoryResults,
    report
  }
}
