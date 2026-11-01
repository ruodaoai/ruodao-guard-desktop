import os from 'node:os'
import type { EndProcessResult, ProcessKind, ProcessReport, SpeedProcess } from '@shared/types'
import { psJson, psPayloadScript } from './powershell'
import { recordRiskEvent } from './risklog'

interface RawProcess {
  pid?: number
  name?: string
  memory?: number
  cpu?: number
  hasWindow?: boolean
  windowTitle?: string
  path?: string
  company?: string
}

interface KillOutcome {
  ended?: number[]
  failed?: Array<{ pid?: number; message?: string }>
}

const CRITICAL_NAMES = new Set([
  'system',
  'registry',
  'memory compression',
  'idle',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'lsaiso',
  'svchost',
  'dwm',
  'fontdrvhost',
  'spoolsv',
  'audiodg',
  'conhost',
  'sihost',
  'taskhostw',
  'explorer',
  'runtimebroker',
  'startmenuexperiencehost',
  'shellexperiencehost',
  'searchhost',
  'searchapp',
  'textinputhost',
  'ctfmon',
  'dllhost',
  'wmiprvse',
  'logonui',
  'userinit',
  'applicationframehost',
  'backgroundtaskhost',
  'lockapp',
  'wudfhost',
  'searchprotocolhost',
  'searchfilterhost',
  'usoclient',
  'msdtc',
  'trustedinstaller',
  'tiworker',
  'sgrmbroker',
  'securityhealthsystray'
])

const SECURITY_PATTERN =
  /^(msmpeng|nisrv|mpdefendercoreservice|securityhealthservice|sense|smartscreen|wscsvc|windefend|huorong|hips|qqpc|kaspersky|avp|avast|avg|bitdefender|mcafee|nod32|ekrn|eset|sophos|symantec|trendmicro|rising|jiangmin|360.*|.*safedog.*)$/i

const PROTECTED_NOTE = 'Windows 系统进程，受保护，不能结束'
const SECURITY_NOTE = '安全防护进程，受保护，不能结束'
const UNKNOWN_NOTE = '无法确认程序来源，已保护'
const BACKGROUND_NOTE = '后台常驻程序，结束后需要时手动重新打开'
const APP_NOTE = '正在运行的应用，结束可能丢失未保存的数据'

function isOurProcess(raw: RawProcess): boolean {
  if (raw.pid === process.pid) return true
  if (!raw.path) return false
  return raw.path.toLowerCase() === process.execPath.toLowerCase()
}

function classify(raw: RawProcess, group: { name: string; path: string; hasWindow: boolean }): {
  kind: ProcessKind
  canEnd: boolean
  note: string
} {
  const name = group.name.toLowerCase()
  const path = group.path.toLowerCase()
  const own =
    isOurProcess(raw) ||
    path === process.execPath.toLowerCase() ||
    /^(ruodao|ruodao-guard)/i.test(group.name)
  if (own) {
    return { kind: 'security', canEnd: false, note: '若道安全卫士自身进程，受保护' }
  }
  if (SECURITY_PATTERN.test(name)) {
    return { kind: 'security', canEnd: false, note: SECURITY_NOTE }
  }
  if (CRITICAL_NAMES.has(name) || path.startsWith('c:\\windows\\')) {
    return { kind: 'system', canEnd: false, note: PROTECTED_NOTE }
  }
  if (!group.path) {
    return { kind: 'system', canEnd: false, note: UNKNOWN_NOTE }
  }
  if (!group.hasWindow) {
    return { kind: 'background', canEnd: true, note: BACKGROUND_NOTE }
  }
  return { kind: 'app', canEnd: true, note: APP_NOTE }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[index]}`
}

async function sampleProcesses(): Promise<RawProcess[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$cores = [int]$env:NUMBER_OF_PROCESSORS
if ($cores -lt 1) { $cores = 1 }
$snap = @{}
foreach ($p in Get-Process) { $snap[[int]$p.Id] = [double]$p.TotalProcessorTime.TotalMilliseconds }
Start-Sleep -Milliseconds 420
$elapsed = 420.0
$items = New-Object System.Collections.ArrayList
foreach ($p in Get-Process) {
  $cpu = 0.0
  if ($snap.ContainsKey([int]$p.Id)) {
    $delta = [double]$p.TotalProcessorTime.TotalMilliseconds - [double]$snap[[int]$p.Id]
    if ($delta -lt 0) { $delta = 0 }
    $cpu = [math]::Round(($delta / ($elapsed * $cores)) * 100, 1)
  }
  $company = ''
  try { $company = [string]$p.Company } catch {}
  $title = ''
  try { $title = [string]$p.MainWindowTitle } catch {}
  $path = ''
  try { $path = [string]$p.Path } catch {}
  $null = $items.Add([PSCustomObject]@{
    pid = [int]$p.Id
    name = [string]$p.ProcessName
    memory = [double]$p.WorkingSet64
    cpu = [double]$cpu
    hasWindow = [bool]($p.MainWindowHandle -ne 0)
    windowTitle = $title
    path = $path
    company = $company
  })
}
$items | ConvertTo-Json -Depth 3 -Compress`
  const raw = await psJson<RawProcess | RawProcess[]>(script, 30000)
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

export async function listProcesses(): Promise<ProcessReport> {
  const raws = await sampleProcesses()
  const groups = new Map<string, {
    name: string
    path: string
    company: string
    windowTitle: string
    memoryBytes: number
    cpuPercent: number
    pids: number[]
    hasWindow: boolean
  }>()

  for (const raw of raws) {
    const pid = raw.pid
    const name = (raw.name || '').trim()
    if (!pid || !name) continue
    const key = name.toLowerCase()
    const current = groups.get(key)
    if (!current) {
      groups.set(key, {
        name,
        path: raw.path || '',
        company: raw.company || '',
        windowTitle: raw.windowTitle || '',
        memoryBytes: raw.memory || 0,
        cpuPercent: raw.cpu || 0,
        pids: [pid],
        hasWindow: raw.hasWindow === true
      })
      continue
    }
    current.memoryBytes += raw.memory || 0
    current.cpuPercent += raw.cpu || 0
    current.pids.push(pid)
    current.hasWindow = current.hasWindow || raw.hasWindow === true
    if (!current.path && raw.path) current.path = raw.path
    if (!current.company && raw.company) current.company = raw.company
    if (!current.windowTitle && raw.windowTitle) current.windowTitle = raw.windowTitle
  }

  const processes: SpeedProcess[] = []
  for (const group of groups.values()) {
    const representative = raws.find((raw) => raw.pid === group.pids[0]) || {}
    const verdict = classify(representative, {
      name: group.name,
      path: group.path,
      hasWindow: group.hasWindow
    })
    const canEnd = verdict.canEnd && !group.pids.some((pid) => pid === process.pid)
    const recommended =
      canEnd && verdict.kind === 'background' && (group.memoryBytes >= 60 * 1024 * 1024 || group.cpuPercent >= 2)
    processes.push({
      id: group.name.toLowerCase(),
      name: group.name,
      label: group.name,
      company: group.company,
      path: group.path,
      memoryBytes: Math.round(group.memoryBytes),
      cpuPercent: Math.round(group.cpuPercent * 10) / 10,
      processCount: group.pids.length,
      pids: group.pids,
      background: !group.hasWindow,
      windowTitle: group.windowTitle,
      kind: verdict.kind,
      canEnd,
      recommended,
      note: verdict.note
    })
  }

  processes.sort((a, b) => {
    if (a.canEnd !== b.canEnd) return a.canEnd ? -1 : 1
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
    return b.memoryBytes - a.memoryBytes
  })

  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const recommended = processes.filter((item) => item.recommended)

  return {
    sampledAt: Date.now(),
    processes,
    processCount: raws.length,
    memoryTotal: totalMem,
    memoryUsed: totalMem - freeMem,
    memoryPercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
    recommendedCount: recommended.length,
    recommendedBytes: recommended.reduce((sum, item) => sum + item.memoryBytes, 0)
  }
}

export async function endProcesses(dataDir: string, requestedPids: number[]): Promise<EndProcessResult> {
  const report = await listProcesses()
  const requested = new Set(requestedPids)
  const targeted = report.processes.filter((item) => item.pids.some((pid) => requested.has(pid)))
  const allowed = targeted.filter((item) => item.canEnd)
  const protectedGroups = targeted.filter((item) => !item.canEnd)

  if (allowed.length === 0) {
    return {
      result: { ok: false, message: protectedGroups.length > 0 ? '所选进程均受系统保护，无法结束' : '未找到可结束的进程' },
      ended: [],
      failed: protectedGroups.map((item) => ({ name: item.label, message: '受系统保护' })),
      report
    }
  }

  const pids = allowed.flatMap((item) => item.pids)
  const script = `
$ended = @()
$failed = @()
foreach ($id in @($data.pids)) {
  try {
    $null = Get-Process -Id ([int]$id) -ErrorAction Stop
    Stop-Process -Id ([int]$id) -Force -ErrorAction Stop
    $ended += [int]$id
  } catch {
    $failed += [PSCustomObject]@{ pid = [int]$id; message = [string]$_.Exception.Message }
  }
}
[PSCustomObject]@{ ended = @($ended); failed = @($failed) } | ConvertTo-Json -Depth 3 -Compress`

  let outcome: KillOutcome = {}
  try {
    outcome = (await psJson<KillOutcome>(psPayloadScript({ pids }, script), 45000)) ?? {}
  } catch (error) {
    return {
      result: { ok: false, message: `结束进程失败：${(error as Error).message}` },
      ended: [],
      failed: allowed.map((item) => ({ name: item.label, message: (error as Error).message })),
      report
    }
  }

  const endedPids = new Set(outcome.ended ?? [])
  const ended = allowed.filter((item) => item.pids.some((pid) => endedPids.has(pid)))
  const failedMap = new Map((outcome.failed ?? []).map((item) => [item.pid ?? 0, item.message || '结束失败']))
  const failed = [
    ...protectedGroups.map((item) => ({ name: item.label, message: '受系统保护' })),
    ...allowed
      .filter((item) => !ended.some((candidate) => candidate.id === item.id))
      .map((item) => ({
        name: item.label,
        message: item.pids.map((pid) => failedMap.get(pid)).find(Boolean) || '进程可能已退出'
      }))
  ]

  const released = ended.reduce((sum, item) => sum + item.memoryBytes, 0)
  const message =
    ended.length > 0
      ? `已结束 ${ended.length} 个应用，释放约 ${formatBytes(released)} 内存${failed.length > 0 ? `，${failed.length} 项未处理` : ''}`
      : `未能结束所选进程${failed.length > 0 ? `：${failed[0].message}` : ''}`

  if (ended.length > 0) {
    try {
      await recordRiskEvent(dataDir, {
        kind: 'process-end',
        title: `结束 ${ended.length} 个后台进程`,
        detail: ended.map((item) => item.label).join('、'),
        severity: 'medium'
      })
    } catch {
      // 风险记录写入失败不影响结束进程
    }
  }

  return {
    result: { ok: ended.length > 0, message },
    ended: ended.map((item) => item.label),
    failed,
    report: await listProcesses()
  }
}
