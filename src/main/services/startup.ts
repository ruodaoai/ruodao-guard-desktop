import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ActionResult,
  StartupItem,
  StartupOptimizeResult,
  StartupReport,
  StartupSource,
  StartupToggleResult
} from '@shared/types'
import { psJson, psPayloadScript, runPowerShell } from './powershell'

interface RawStartup {
  source?: string
  name?: string
  command?: string
  disabled?: boolean
}

interface DisabledFolderEntry {
  id: string
  fileName: string
  originalPath: string
  storedName: string
  disabledAt: number
}

const USER_RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const BACKUP_KEY = 'HKCU:\\Software\\RuodaoGuard\\StartupBackup\\user-run'

let storeDir = path.join(os.homedir(), 'AppData', 'Roaming', 'RuodaoGuard')
let manifestCache: DisabledFolderEntry[] | null = null

export function configureStartupStore(dataDir: string): void {
  storeDir = dataDir
  manifestCache = null
}

function itemId(source: StartupSource, name: string): string {
  return createHash('sha1').update(`${source}|${name}`).digest('hex').slice(0, 16)
}

function userStartupFolder(): string {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
  )
}

function commonStartupFolder(): string {
  return path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
  )
}

export function getStartupFolderPaths(): { user: string; common: string } {
  return { user: userStartupFolder(), common: commonStartupFolder() }
}

function sourceLabel(source: StartupSource): string {
  switch (source) {
    case 'user-run':
      return '当前用户注册表'
    case 'machine-run':
      return '系统注册表'
    case 'machine-run-32':
      return '系统注册表（32 位）'
    case 'user-startup':
      return '用户启动文件夹'
    case 'common-startup':
      return '公共启动文件夹'
  }
}

function canToggleSource(source: StartupSource): boolean {
  return source === 'user-run' || source === 'user-startup'
}

function evaluateImpact(command: string): { impact: 'low' | 'medium' | 'high'; tip: string } {
  const normalized = command.toLowerCase()
  if (!normalized.trim()) {
    return { impact: 'medium', tip: '启动命令为空，建议关闭该项' }
  }
  if (/(\\temp\\|appdata\\local\\temp|powershell|mshta|wscript|cscript|regsvr32|rundll32.*http)/.test(normalized)) {
    return { impact: 'high', tip: '启动命令指向临时目录或脚本宿主，建议确认来源后关闭' }
  }
  if (/(chrome|msedge|firefox|wechat|weixin|qq|dingtalk|teams|steam|spotify|onedrive|dropbox|update|updater|helper)/.test(normalized)) {
    return { impact: 'medium', tip: '该程序会在开机时自动运行，可能延长启动时间' }
  }
  return { impact: 'low', tip: '常规启动项，对开机速度影响较小' }
}

async function readManifest(): Promise<DisabledFolderEntry[]> {
  if (manifestCache) return manifestCache
  try {
    const text = await fs.readFile(path.join(storeDir, 'startup-disabled.json'), 'utf8')
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      manifestCache = parsed.filter(
        (entry): entry is DisabledFolderEntry =>
          !!entry && typeof entry.id === 'string' && typeof entry.storedName === 'string' && typeof entry.originalPath === 'string'
      )
      return manifestCache
    }
  } catch {
    // no manifest yet
  }
  manifestCache = []
  return manifestCache
}

async function writeManifest(entries: DisabledFolderEntry[]): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true })
  const target = path.join(storeDir, 'startup-disabled.json')
  const temp = `${target}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(entries, null, 2), 'utf8')
  await fs.rename(temp, target)
  manifestCache = entries
}

async function readRegistryItems(): Promise<RawStartup[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$list = New-Object System.Collections.ArrayList
function Add-RunValues($regPath, $sourceName) {
  if (Test-Path -LiteralPath $regPath) {
    $key = Get-Item -LiteralPath $regPath
    foreach ($valueName in $key.GetValueNames()) {
      $null = $list.Add([PSCustomObject]@{
        source = $sourceName
        name = $valueName
        command = [string]$key.GetValue($valueName)
        disabled = $false
      })
    }
  }
}
Add-RunValues '${USER_RUN_KEY}' 'user-run'
Add-RunValues 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' 'machine-run'
Add-RunValues 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run' 'machine-run-32'
if (Test-Path -LiteralPath '${BACKUP_KEY}') {
  $backupKey = Get-Item -LiteralPath '${BACKUP_KEY}'
  foreach ($valueName in $backupKey.GetValueNames()) {
    $null = $list.Add([PSCustomObject]@{
      source = 'user-run'
      name = $valueName
      command = [string]$backupKey.GetValue($valueName)
      disabled = $true
    })
  }
}
$list | ConvertTo-Json -Depth 3 -Compress
`
  const raw = await psJson<RawStartup | RawStartup[]>(script, 20000)
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

async function readStartupFolder(source: 'user-startup' | 'common-startup'): Promise<StartupItem[]> {
  const folder = source === 'user-startup' ? userStartupFolder() : commonStartupFolder()
  let entries
  try {
    entries = await fs.readdir(folder, { withFileTypes: true })
  } catch {
    return []
  }
  const items: StartupItem[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.toLowerCase() === 'desktop.ini') continue
    const fullPath = path.join(folder, entry.name)
    const impact = evaluateImpact(fullPath)
    items.push({
      id: itemId(source, entry.name),
      name: entry.name,
      command: fullPath,
      source,
      sourceLabel: sourceLabel(source),
      enabled: true,
      canToggle: canToggleSource(source),
      impact: impact.impact,
      tip: impact.tip
    })
  }
  return items
}

function registryItem(raw: RawStartup, disabled: boolean): StartupItem | null {
  const source = raw.source as StartupSource
  if (!['user-run', 'machine-run', 'machine-run-32'].includes(source)) return null
  const name = (raw.name || '').trim()
  if (!name) return null
  const command = raw.command || ''
  const impact = evaluateImpact(command)
  return {
    id: itemId(source, name),
    name,
    command,
    source,
    sourceLabel: sourceLabel(source),
    enabled: !disabled,
    canToggle: canToggleSource(source),
    impact: impact.impact,
    tip: impact.tip
  }
}

async function buildReport(): Promise<StartupReport> {
  const [registry, userFolder, commonFolder, manifest] = await Promise.all([
    readRegistryItems().catch(() => []),
    readStartupFolder('user-startup'),
    readStartupFolder('common-startup'),
    readManifest()
  ])

  const merged = new Map<string, StartupItem>()
  for (const raw of registry) {
    const item = registryItem(raw, raw.disabled === true)
    if (item && !merged.has(item.id)) merged.set(item.id, item)
  }
  for (const item of [...userFolder, ...commonFolder]) {
    if (!merged.has(item.id)) merged.set(item.id, item)
  }
  for (const entry of manifest) {
    const id = itemId('user-startup', entry.fileName)
    if (merged.has(id)) continue
    const impact = evaluateImpact(entry.originalPath)
    merged.set(id, {
      id,
      name: entry.fileName,
      command: entry.originalPath,
      source: 'user-startup',
      sourceLabel: sourceLabel('user-startup'),
      enabled: false,
      canToggle: true,
      impact: impact.impact,
      tip: impact.tip
    })
  }

  const items = [...merged.values()]
  const order = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    if (order[a.impact] !== order[b.impact]) return order[a.impact] - order[b.impact]
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  const enabled = items.filter((item) => item.enabled)
  return {
    items,
    enabledCount: enabled.length,
    disabledCount: items.length - enabled.length,
    highImpactCount: enabled.filter((item) => item.impact === 'high').length
  }
}

export async function listStartup(): Promise<StartupReport> {
  return buildReport()
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fs.copyFile(source, destination)
    await fs.unlink(source)
  }
}

async function toggleRegistry(name: string, enable: boolean): Promise<ActionResult> {
  const script = enable
    ? `
try {
  if (-not (Test-Path -LiteralPath '${BACKUP_KEY}')) { throw '未找到启动项备份' }
  $backupKey = Get-Item -LiteralPath '${BACKUP_KEY}'
  $command = $backupKey.GetValue($data.name, $null)
  if ($null -eq $command) { throw '未找到启动项备份' }
  if (-not (Test-Path -LiteralPath '${USER_RUN_KEY}')) { $null = New-Item -Path '${USER_RUN_KEY}' -Force }
  $runKey = Get-Item -LiteralPath '${USER_RUN_KEY}'
  if ($null -ne $runKey.GetValue($data.name, $null)) { throw '启动项中已存在同名项目' }
  $null = New-ItemProperty -LiteralPath '${USER_RUN_KEY}' -Name $data.name -Value ([string]$command) -PropertyType String -Force
  $backupKey.DeleteValue($data.name, $true)
  'OK'
} catch { 'ERR:' + $_.Exception.Message }`
    : `
try {
  if (-not (Test-Path -LiteralPath '${USER_RUN_KEY}')) { throw '启动项不存在' }
  $runKey = Get-Item -LiteralPath '${USER_RUN_KEY}'
  $command = $runKey.GetValue($data.name, $null)
  if ($null -eq $command) { throw '启动项不存在或已被移除' }
  if (-not (Test-Path -LiteralPath '${BACKUP_KEY}')) { $null = New-Item -Path '${BACKUP_KEY}' -Force }
  $backupKey = Get-Item -LiteralPath '${BACKUP_KEY}'
  if ($null -ne $backupKey.GetValue($data.name, $null)) { throw '备份中已存在同名启动项' }
  $null = New-ItemProperty -LiteralPath '${BACKUP_KEY}' -Name $data.name -Value ([string]$command) -PropertyType String -Force
  $runKey.DeleteValue($data.name, $true)
  'OK'
} catch { 'ERR:' + $_.Exception.Message }`

  try {
    const output = await runPowerShell(psPayloadScript({ name }, script), 20000)
    if (output.startsWith('ERR:')) {
      return { ok: false, message: output.slice(4).trim() || '操作失败' }
    }
    return { ok: true, message: enable ? '启动项已恢复' : '启动项已禁用，可随时重新启用' }
  } catch (error) {
    return { ok: false, message: `注册表操作失败：${(error as Error).message}` }
  }
}

async function disableFolderItem(item: StartupItem): Promise<ActionResult> {
  const folder = userStartupFolder()
  const originalPath = path.resolve(folder, path.basename(item.name))
  if (path.dirname(originalPath).toLowerCase() !== path.resolve(folder).toLowerCase()) {
    return { ok: false, message: '启动项路径异常，已阻止操作' }
  }
  try {
    await fs.access(originalPath)
  } catch {
    return { ok: false, message: '启动项文件不存在，请刷新列表' }
  }

  const manifest = await readManifest()
  if (manifest.some((entry) => entry.originalPath.toLowerCase() === originalPath.toLowerCase())) {
    return { ok: false, message: '该启动项已被禁用' }
  }

  const backupDir = path.join(storeDir, 'startup-backup')
  await fs.mkdir(backupDir, { recursive: true })
  const storedName = `${item.id}-${item.name.replace(/[<>:"/\\|?*]/g, '_')}`
  const storedPath = path.join(backupDir, storedName)
  try {
    await moveFile(originalPath, storedPath)
    await writeManifest([
      ...manifest,
      {
        id: item.id,
        fileName: item.name,
        originalPath,
        storedName,
        disabledAt: Date.now()
      }
    ])
    return { ok: true, message: '启动项已禁用，文件已备份，可随时恢复' }
  } catch (error) {
    return { ok: false, message: `无法禁用启动项：${(error as Error).message}` }
  }
}

async function enableFolderItem(item: StartupItem): Promise<ActionResult> {
  const manifest = await readManifest()
  const entry = manifest.find((candidate) => candidate.id === item.id)
  if (!entry) return { ok: false, message: '未找到启动项备份' }

  const storedPath = path.join(storeDir, 'startup-backup', entry.storedName)
  try {
    await fs.access(storedPath)
  } catch {
    return { ok: false, message: '启动项备份文件已丢失' }
  }
  try {
    await fs.mkdir(path.dirname(entry.originalPath), { recursive: true })
    try {
      await fs.access(entry.originalPath)
      return { ok: false, message: '启动文件夹中已存在同名文件' }
    } catch {
      // destination is free
    }
    await moveFile(storedPath, entry.originalPath)
    await writeManifest(manifest.filter((candidate) => candidate.id !== item.id))
    return { ok: true, message: '启动项已恢复' }
  } catch (error) {
    return { ok: false, message: `无法恢复启动项：${(error as Error).message}` }
  }
}

export async function setStartupEnabled(id: string, enabled: boolean): Promise<StartupToggleResult> {
  const report = await listStartup()
  const item = report.items.find((candidate) => candidate.id === id)
  if (!item) {
    return { result: { ok: false, message: '未找到该启动项，请刷新后重试' }, report }
  }
  if (!item.canToggle) {
    return { result: { ok: false, message: '该系统级启动项需要管理员权限，暂不支持在此修改' }, report }
  }
  if (item.enabled === enabled) {
    return { result: { ok: true, message: '启动项状态未变化' }, report }
  }

  const result = await applyToggle(item, enabled)
  return { result, report: await buildReport() }
}

async function applyToggle(item: StartupItem, enabled: boolean): Promise<ActionResult> {
  if (item.source === 'user-run') return toggleRegistry(item.name, enabled)
  if (item.source === 'user-startup') return enabled ? enableFolderItem(item) : disableFolderItem(item)
  return { ok: false, message: '该启动项暂不支持修改' }
}

export async function optimizeStartup(): Promise<StartupOptimizeResult> {
  const report = await listStartup()
  const targets = report.items.filter((item) => item.enabled && item.canToggle && item.impact === 'high')

  if (targets.length === 0) {
    return {
      result: { ok: true, message: '当前没有需要一键优化的高影响启动项' },
      disabled: [],
      failed: [],
      report
    }
  }

  const disabled: string[] = []
  const failed: string[] = []
  for (const item of targets) {
    const result = await applyToggle(item, false)
    if (result.ok) disabled.push(item.name)
    else failed.push(`${item.name}：${result.message}`)
  }

  const message =
    failed.length === 0
      ? `已禁用 ${disabled.length} 个高影响启动项，可随时在启动项管理中恢复`
      : disabled.length > 0
        ? `已禁用 ${disabled.length} 个启动项，${failed.length} 个未能修改`
        : `优化未完成：${failed[0]}`

  return {
    result: { ok: failed.length === 0 || disabled.length > 0, message },
    disabled,
    failed,
    report: await buildReport()
  }
}
