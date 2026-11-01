import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ActionResult, SoftwareItem, SoftwareReport } from '@shared/types'
import { psJson } from './powershell'

interface RawSoftware {
  key?: string
  source?: string
  name?: string
  version?: string
  publisher?: string
  installDate?: string
  location?: string
  estimatedKb?: number
  uninstall?: string
  quietUninstall?: string
  displayIcon?: string
  systemComponent?: number
  releaseType?: string
  parentKey?: string
}

const REGISTRY_QUERY = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(
  @{ Path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Source = 'machine' },
  @{ Path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Source = 'machine32' },
  @{ Path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Source = 'user' }
)
$items = @()
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root.Path)) { continue }
  Get-ChildItem -LiteralPath $root.Path -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p -or [string]::IsNullOrWhiteSpace([string]$p.DisplayName)) { return }
    $items += [PSCustomObject]@{
      key = [string]$_.PSChildName
      source = [string]$root.Source
      name = [string]$p.DisplayName
      version = [string]$p.DisplayVersion
      publisher = [string]$p.Publisher
      installDate = [string]$p.InstallDate
      location = [string]$p.InstallLocation
      estimatedKb = [int64]$(if ($p.EstimatedSize) { $p.EstimatedSize } else { 0 })
      uninstall = [string]$p.UninstallString
      quietUninstall = [string]$p.QuietUninstallString
      displayIcon = [string]$p.DisplayIcon
      systemComponent = [int]$(if ($null -ne $p.SystemComponent) { $p.SystemComponent } else { 0 })
      releaseType = [string]$p.ReleaseType
      parentKey = [string]$p.ParentKeyName
    }
  }
}
$items | ConvertTo-Json -Depth 3 -Compress
`

let cache: { at: number; report: SoftwareReport; items: Map<string, SoftwareItem> } | null = null
let inflight: Promise<SoftwareReport> | null = null

function stableId(source: string, key: string): string {
  return createHash('sha1').update(`${source}|${key}`).digest('hex').slice(0, 16)
}

function formatInstallDate(raw: string): string {
  if (!/^\d{8}$/.test(raw)) return ''
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
}

function isHiddenComponent(raw: RawSoftware): boolean {
  if ((raw.systemComponent ?? 0) === 1) return true
  if (raw.parentKey) return true
  if (raw.releaseType && /update|hotfix|rollup|security/i.test(raw.releaseType)) return true
  const name = (raw.name || '').trim()
  if (/^(update for|security update for|hotfix for|update rollup|kb\d{6,})/i.test(name)) return true
  return false
}

function toSoftwareItem(raw: RawSoftware): SoftwareItem | null {
  const name = (raw.name || '').trim()
  if (!name || isHiddenComponent(raw)) return null
  const source = raw.source === 'user' ? 'user' : raw.source === 'machine32' ? 'machine32' : 'machine'
  const location = (raw.location || '').replace(/^"|"$/g, '').trim()
  const uninstall = (raw.uninstall || '').trim()
  return {
    id: stableId(source, raw.key || name),
    name,
    version: (raw.version || '').trim(),
    publisher: (raw.publisher || '').trim(),
    installDate: formatInstallDate((raw.installDate || '').trim()),
    installLocation: location,
    estimatedBytes: Math.max(0, Number(raw.estimatedKb || 0) * 1024),
    source,
    hasUninstall: uninstall.length > 0,
    displayIcon: (raw.displayIcon || '').trim()
  }
}

async function buildReport(): Promise<SoftwareReport> {
  const raw = await psJson<RawSoftware | RawSoftware[]>(REGISTRY_QUERY, 30000)
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : []
  const seen = new Set<string>()
  const items: SoftwareItem[] = []
  const itemMap = new Map<string, SoftwareItem>()
  for (const entry of list) {
    const item = toSoftwareItem(entry)
    if (!item) continue
    const dedupeKey = `${item.name.toLowerCase()}::${item.version.toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    items.push(item)
    itemMap.set(item.id, item)
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const report: SoftwareReport = {
    scannedAt: Date.now(),
    items,
    totalBytes: items.reduce((sum, item) => sum + item.estimatedBytes, 0),
    userCount: items.filter((item) => item.source === 'user').length
  }
  cache = { at: Date.now(), report, items: itemMap }
  return report
}

export async function listSoftware(force = false): Promise<SoftwareReport> {
  if (!force && cache && Date.now() - cache.at < 60000) return cache.report
  if (inflight) return inflight
  inflight = buildReport().finally(() => {
    inflight = null
  })
  return inflight
}

function parseUninstallCommand(raw: string): { file: string; args: string } | null {
  const command = raw.trim()
  if (!command) return null
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1)
    if (end === -1) return null
    return { file: command.slice(1, end), args: command.slice(end + 1).trim() }
  }
  const msi = /^(msiexec(?:\.exe)?)\s+(.*)$/i.exec(command)
  if (msi) return { file: msi[1], args: msi[2] }
  const firstSpace = command.search(/\s/)
  if (firstSpace === -1) return { file: command, args: '' }
  return { file: command.slice(0, firstSpace), args: command.slice(firstSpace + 1).trim() }
}

async function resolveItem(id: string): Promise<SoftwareItem | null> {
  let current = cache
  if (!current) {
    await listSoftware(true)
    current = cache
  }
  const cached = current?.items.get(id)
  if (cached) return cached
  await listSoftware(true)
  return cache?.items.get(id) ?? null
}

export async function uninstallSoftware(id: string): Promise<ActionResult> {
  const item = await resolveItem(id)
  if (!item) return { ok: false, message: '未找到该软件，列表可能已过期，请刷新后重试' }
  if (!item.hasUninstall) return { ok: false, message: '该软件未注册卸载程序，请前往其安装目录手动卸载' }

  const raw = await psJson<RawSoftware | RawSoftware[]>(REGISTRY_QUERY, 30000)
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : []
  const source = item.source
  const match = list.find((entry) => {
    const entrySource = entry.source === 'user' ? 'user' : entry.source === 'machine32' ? 'machine32' : 'machine'
    return entrySource === source && toSoftwareItem(entry)?.id === item.id
  })
  if (!match || !match.uninstall) return { ok: false, message: '未找到有效的卸载命令' }

  const parsed = parseUninstallCommand(match.uninstall)
  if (!parsed) return { ok: false, message: '卸载命令格式异常，无法执行' }

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', match.uninstall!.trim()], {
        windowsHide: false,
        detached: true,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    return { ok: true, message: `已调起「${item.name}」的卸载程序，请按向导完成卸载` }
  } catch (error) {
    return { ok: false, message: `无法启动卸载程序：${(error as Error).message}` }
  }
}

export async function openSoftwareLocation(id: string): Promise<ActionResult> {
  const item = await resolveItem(id)
  if (!item) return { ok: false, message: '未找到该软件' }

  const candidates: string[] = []
  if (item.installLocation) candidates.push(item.installLocation)
  if (item.displayIcon) {
    const iconPath = item.displayIcon.replace(/^"|"$/g, '').replace(/,\d+$/, '').trim()
    if (iconPath) candidates.push(path.dirname(iconPath))
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (!stat.isDirectory()) continue
      const child = spawn('explorer.exe', [candidate], { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, message: '已在资源管理器中打开安装目录' }
    } catch {
      // try next candidate
    }
  }
  return { ok: false, message: '该软件未提供可访问的安装目录' }
}
