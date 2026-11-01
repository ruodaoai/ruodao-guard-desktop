import os from 'node:os'
import type { DiskInfo, DefenderStatus, SystemSnapshot } from '@shared/types'
import { psJson } from './powershell'

interface RawSystemInfo {
  osName?: string
  osVersion?: string
  isAdmin?: boolean
  disks?: Array<{ id?: string; label?: string; total?: number; free?: number }>
}

interface RawDefenderStatus {
  realtime?: boolean
  antivirusEnabled?: boolean
  signatureVersion?: string
  signatureUpdatedAt?: string | null
}

let cached: { at: number; snapshot: SystemSnapshot } | null = null
let inflight: Promise<SystemSnapshot> | null = null

async function sampleCpuUsage(ms = 320): Promise<number> {
  const start = os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }))
  await new Promise((resolve) => setTimeout(resolve, ms))
  const end = os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }))
  let idleDelta = 0
  let totalDelta = 0
  for (let i = 0; i < Math.min(start.length, end.length); i++) {
    idleDelta += end[i].idle - start[i].idle
    totalDelta += end[i].total - start[i].total
  }
  if (totalDelta <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((1 - idleDelta / totalDelta) * 100)))
}

async function readSystemInfo(): Promise<RawSystemInfo | null> {
  const script = `
$os = Get-CimInstance Win32_OperatingSystem
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
[PSCustomObject]@{
  osName = [string]$os.Caption
  osVersion = [string]$os.Version
  isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  disks = @($disks | ForEach-Object {
    [PSCustomObject]@{
      id = [string]$_.DeviceID
      label = [string]$_.VolumeName
      total = [double]$_.Size
      free = [double]$_.FreeSpace
    }
  })
} | ConvertTo-Json -Depth 4 -Compress`
  return psJson<RawSystemInfo>(script, 15000)
}

async function readDefender(): Promise<DefenderStatus> {
  const script = `
$status = Get-MpComputerStatus
[PSCustomObject]@{
  realtime = [bool]$status.RealTimeProtectionEnabled
  antivirusEnabled = [bool]$status.AntivirusEnabled
  signatureVersion = [string]$status.AntivirusSignatureVersion
  signatureUpdatedAt = $(if ($status.AntivirusSignatureLastUpdated) { $status.AntivirusSignatureLastUpdated.ToString('yyyy-MM-dd HH:mm') } else { $null })
} | ConvertTo-Json -Compress`
  try {
    const raw = await psJson<RawDefenderStatus>(script, 15000)
    if (!raw) {
      return { available: false, realtime: false, antivirusEnabled: false, signatureVersion: '', signatureUpdatedAt: null }
    }
    return {
      available: true,
      realtime: raw.realtime === true,
      antivirusEnabled: raw.antivirusEnabled === true,
      signatureVersion: raw.signatureVersion || '',
      signatureUpdatedAt: raw.signatureUpdatedAt || null
    }
  } catch {
    return { available: false, realtime: false, antivirusEnabled: false, signatureVersion: '', signatureUpdatedAt: null }
  }
}

function fallbackDisks(): DiskInfo[] {
  return [
    {
      id: 'C:',
      label: '',
      total: 0,
      free: 0
    }
  ]
}

function cleanOsName(name?: string): string {
  if (!name) return 'Windows'
  return name.replace(/^Microsoft\s+/, '').trim()
}

async function buildSnapshot(): Promise<SystemSnapshot> {
  const [cpuUsage, info, defender] = await Promise.all([sampleCpuUsage(), readSystemInfo().catch(() => null), readDefender()])
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const cpus = os.cpus()
  const rawDisks = info?.disks?.filter((d) => (d.total || 0) > 0) ?? []
  const disks: DiskInfo[] = rawDisks.length
    ? rawDisks.map((d) => ({
        id: d.id || 'C:',
        label: d.label || '',
        total: Math.round(d.total || 0),
        free: Math.round(d.free || 0)
      }))
    : fallbackDisks()

  return {
    hostname: os.hostname(),
    osName: cleanOsName(info?.osName),
    osVersion: info?.osVersion || os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || '未知处理器',
    cpuCores: cpus.length,
    cpuUsage,
    memoryTotal: totalMem,
    memoryUsed: totalMem - freeMem,
    memoryPercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
    uptimeSec: Math.round(os.uptime()),
    isAdmin: info?.isAdmin === true,
    disks,
    defender,
    capturedAt: Date.now()
  }
}

export async function getIsAdmin(): Promise<boolean> {
  return (await getSystemSnapshot()).isAdmin
}

export async function getSystemSnapshot(force = false): Promise<SystemSnapshot> {
  if (!force && cached && Date.now() - cached.at < 5000) return cached.snapshot
  if (inflight) return inflight
  inflight = buildSnapshot()
    .then((snapshot) => {
      cached = { at: Date.now(), snapshot }
      return snapshot
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
