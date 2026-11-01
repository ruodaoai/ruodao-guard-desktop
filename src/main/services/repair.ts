import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  RepairCheck,
  RepairFixResult,
  RepairIssue,
  RepairReport,
  RepairSeverity,
  RiskEvent,
  StartupItem
} from '@shared/types'
import { hostsFilePath, readHostsFile, type HostsEntry } from './hosts'
import { psJson, psPayloadScript, runPowerShell } from './powershell'
import { disableProxy, readProxyState } from './proxy'
import { listRiskEvents, recordRiskEvent } from './risklog'
import { listStartup } from './startup'
import { getIsAdmin } from './system'

export interface RepairScanContext {
  dataDir: string
  desktop: string
}

interface RawSecurityState {
  isAdmin?: boolean
  uac?: number | null
  firewall?: Array<{ name?: string; enabled?: boolean }>
  policies?: Array<{ path?: string; name?: string; value?: number }>
  ifeo?: Array<{ name?: string; debugger?: string }>
  services?: Array<{ name?: string; status?: string; startType?: string; displayName?: string }>
  pending?: string[]
  defender?: { available?: boolean; realtime?: boolean; antivirus?: boolean } | null
}

interface BrokenShortcut {
  path: string
  target: string
}

interface ServiceSpec {
  name: string
  label: string
  severity: RepairSeverity
  startType: 'Automatic' | 'Manual'
  flagStopped: boolean
}

const SERVICE_SPECS: ServiceSpec[] = [
  { name: 'wuauserv', label: 'Windows Update', severity: 'medium', startType: 'Manual', flagStopped: false },
  { name: 'bits', label: '后台智能传输服务', severity: 'medium', startType: 'Manual', flagStopped: false },
  { name: 'CryptSvc', label: '加密服务', severity: 'high', startType: 'Automatic', flagStopped: true },
  { name: 'Dnscache', label: 'DNS 客户端', severity: 'high', startType: 'Automatic', flagStopped: true },
  { name: 'EventLog', label: 'Windows 事件日志', severity: 'medium', startType: 'Automatic', flagStopped: true },
  { name: 'LanmanWorkstation', label: '工作站服务', severity: 'medium', startType: 'Automatic', flagStopped: true },
  { name: 'Schedule', label: '任务计划程序', severity: 'medium', startType: 'Automatic', flagStopped: true },
  { name: 'Winmgmt', label: 'WMI 管理服务', severity: 'high', startType: 'Automatic', flagStopped: true },
  { name: 'w32time', label: 'Windows 时间同步', severity: 'low', startType: 'Manual', flagStopped: false },
  { name: 'Audiosrv', label: 'Windows 音频', severity: 'low', startType: 'Automatic', flagStopped: false },
  { name: 'Spooler', label: '打印后台处理', severity: 'low', startType: 'Automatic', flagStopped: false }
]

const IFEO_TARGETS = new Set([
  'explorer.exe',
  'taskmgr.exe',
  'cmd.exe',
  'regedit.exe',
  'msconfig.exe',
  'notepad.exe',
  'userinit.exe'
])

const POLICY_META: Record<string, { title: string; detail: string; severity: RepairSeverity }> = {
  DisableTaskMgr: {
    title: '任务管理器已被策略禁用',
    detail: '系统策略关闭了任务管理器，可能是恶意软件或他人的限制设置，建议确认来源后恢复。',
    severity: 'high'
  },
  DisableRegistryTools: {
    title: '注册表编辑器已被策略禁用',
    detail: '系统策略关闭了注册表编辑器，正常电脑通常不需要此限制。',
    severity: 'high'
  },
  NoAutoUpdate: {
    title: 'Windows 自动更新被关闭',
    detail: '更新策略被设置为关闭，系统可能长期缺少安全补丁。',
    severity: 'medium'
  },
  DisableWindowsUpdateAccess: {
    title: 'Windows 更新访问被限制',
    detail: '策略限制了用户访问 Windows 更新，可能影响补丁安装。',
    severity: 'medium'
  }
}

const UAC_PATH = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'
const SECURITY_DOMAINS =
  /(windowsupdate|update\.microsoft|definitionupdate|wdcp\.microsoft|smartscreen\.microsoft|windowsdefender|security\.microsoft|kaspersky|avast|huorong|360\.cn|rising\.com)/i
const POPULAR_DOMAINS = /(baidu\.com|taobao\.com|jd\.com|qq\.com|weibo\.com|google\.com|youtube\.com|github\.com)/i
const SUSPICIOUS_COMMAND =
  /(\\temp\\|\\appdata\\local\\temp\\|powershell(\.exe)?[^|;]*(encodedcommand|-enc\b|-e\s)|mshta(\.exe)?\s|wscript(\.exe)?\s|cscript(\.exe)?\s|regsvr32(\.exe)?[^|;]*https?:|rundll32(\.exe)?[^|;]*https?:|\\users\\public\\)/i

let lastReport: RepairReport | null = null

function severityOrder(severity: RepairSeverity): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2
}

function isLoopback(ip: string): boolean {
  return ['127.0.0.1', '0.0.0.0', '::1', '::', '255.255.255.255'].includes(ip)
}

function isPrivateIp(ip: string): boolean {
  return (
    isLoopback(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    ip.includes(':')
  )
}

function shorten(value: string, max = 96): string {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function startMenuFolders(desktop: string): string[] {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const publicDir = process.env.PUBLIC || 'C:\\Users\\Public'
  return [
    desktop,
    path.join(publicDir, 'Desktop'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ]
}

async function readSecurityState(): Promise<RawSecurityState | null> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uac = $null
$uacValue = (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name EnableLUA -ErrorAction SilentlyContinue).EnableLUA
if ($null -ne $uacValue) { $uac = [int]$uacValue }

$firewall = @()
foreach ($profile in (Get-NetFirewallProfile -ErrorAction SilentlyContinue)) {
  $firewall += [PSCustomObject]@{ name = [string]$profile.Name; enabled = [bool]$profile.Enabled }
}

$policySpecs = @(
  [PSCustomObject]@{ path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'; name = 'DisableTaskMgr' },
  [PSCustomObject]@{ path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'; name = 'DisableRegistryTools' },
  [PSCustomObject]@{ path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'; name = 'DisableTaskMgr' },
  [PSCustomObject]@{ path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'; name = 'DisableRegistryTools' },
  [PSCustomObject]@{ path = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'; name = 'NoAutoUpdate' },
  [PSCustomObject]@{ path = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate'; name = 'DisableWindowsUpdateAccess' }
)
$policies = @()
foreach ($spec in $policySpecs) {
  $item = Get-ItemProperty -LiteralPath $spec.path -Name $spec.name -ErrorAction SilentlyContinue
  if ($null -ne $item) {
    $value = $item.($spec.name)
    if ($null -ne $value -and [int]$value -ne 0) {
      $policies += [PSCustomObject]@{ path = $spec.path; name = $spec.name; value = [int]$value }
    }
  }
}

$ifeo = @()
foreach ($exe in @('explorer.exe','taskmgr.exe','cmd.exe','regedit.exe','msconfig.exe','notepad.exe','userinit.exe')) {
  $dbg = (Get-ItemProperty -LiteralPath "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\$exe" -Name Debugger -ErrorAction SilentlyContinue).Debugger
  if ($dbg) { $ifeo += [PSCustomObject]@{ name = $exe; debugger = [string]$dbg } }
}

$services = @()
foreach ($name in @('wuauserv','bits','CryptSvc','Dnscache','EventLog','LanmanWorkstation','Schedule','Winmgmt','w32time','Audiosrv','Spooler')) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($svc) {
    $startType = ''
    try { $startType = [string]$svc.StartType } catch {}
    $services += [PSCustomObject]@{ name = $name; status = [string]$svc.Status; startType = $startType; displayName = [string]$svc.DisplayName }
  }
}

$pending = @()
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') { $pending += 'CBS' }
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { $pending += 'WindowsUpdate' }
if ($null -ne (Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations) { $pending += 'FileRename' }

$defender = $null
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  $defender = [PSCustomObject]@{ available = $true; realtime = [bool]$mp.RealTimeProtectionEnabled; antivirus = [bool]$mp.AntivirusEnabled }
} catch {
  $defender = [PSCustomObject]@{ available = $false; realtime = $false; antivirus = $false }
}

[PSCustomObject]@{
  isAdmin = [bool]$isAdmin
  uac = $uac
  firewall = @($firewall)
  policies = @($policies)
  ifeo = @($ifeo)
  services = @($services)
  pending = @($pending)
  defender = $defender
} | ConvertTo-Json -Depth 6 -Compress`
  return psJson<RawSecurityState>(script, 30000)
}

async function scanBrokenShortcuts(context: RepairScanContext): Promise<BrokenShortcut[] | null> {
  const folders = [...new Set(startMenuFolders(context.desktop))]
  const script = psPayloadScript(
    { folders },
    `
$shell = New-Object -ComObject WScript.Shell
$list = New-Object System.Collections.ArrayList
foreach ($folder in @($data.folders)) {
  if (-not (Test-Path -LiteralPath $folder)) { continue }
  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue | ForEach-Object {
    $target = ''
    try { $target = [string]$shell.CreateShortcut($_.FullName).TargetPath } catch {}
    if ($target -and -not (Test-Path -LiteralPath $target)) {
      $null = $list.Add([PSCustomObject]@{ path = [string]$_.FullName; target = $target })
    }
  }
}
$list | ConvertTo-Json -Depth 3 -Compress`
  )
  try {
    const raw = await psJson<BrokenShortcut | BrokenShortcut[]>(script, 40000)
    if (!raw) return []
    return Array.isArray(raw) ? raw : [raw]
  } catch {
    return null
  }
}

function suspiciousStartup(items: StartupItem[]): StartupItem[] {
  return items.filter((item) => item.enabled && SUSPICIOUS_COMMAND.test(item.command))
}

function hostsAnalysis(entries: HostsEntry[]): { level: RepairSeverity; evidence: string[]; customCount: number } {
  const evidence: string[] = []
  let level: RepairSeverity | null = null
  for (const entry of entries) {
    for (const host of entry.hosts) {
      if (SECURITY_DOMAINS.test(host) && isLoopback(entry.ip)) {
        level = 'high'
        if (evidence.length < 5) evidence.push(`第 ${entry.line} 行：${entry.ip} ${host}`)
      } else if (POPULAR_DOMAINS.test(host) && !isPrivateIp(entry.ip)) {
        if (!level) level = 'medium'
        if (evidence.length < 5) evidence.push(`第 ${entry.line} 行：${entry.ip} ${host}`)
      }
    }
  }
  return { level: level ?? 'low', evidence, customCount: entries.length }
}

function buildCheck(id: string, label: string, detail: string, status: RepairCheck['status']): RepairCheck {
  return { id, label, detail, status }
}

export async function scanRepair(context: RepairScanContext): Promise<RepairReport> {
  const [security, hosts, proxy, shortcuts, startup] = await Promise.all([
    readSecurityState().catch(() => null),
    readHostsFile(),
    readProxyState(),
    scanBrokenShortcuts(context),
    listStartup().catch(() => null)
  ])

  const isAdmin = security?.isAdmin === true || (await getIsAdmin().catch(() => false))
  const issues: RepairIssue[] = []
  const checks: RepairCheck[] = []
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const keySystemFiles = [
    'System32\\kernel32.dll',
    'System32\\user32.dll',
    'System32\\advapi32.dll',
    'System32\\ntdll.dll',
    'System32\\svchost.exe',
    'System32\\explorer.exe',
    'System32\\services.exe',
    'explorer.exe'
  ]

  if (security) {
    if (security.defender?.available) {
      if (security.defender.realtime) {
        checks.push(buildCheck('defender', '实时防护', 'Windows Defender 实时保护正在运行', 'ok'))
      } else {
        checks.push(buildCheck('defender', '实时防护', '实时保护未开启，电脑可能暴露在风险中', 'danger'))
        issues.push({
          id: 'defender-realtime',
          category: 'security',
          title: 'Windows 实时防护未开启',
          detail: 'Defender 实时保护处于关闭状态，下载或打开文件时不会自动拦截威胁。',
          severity: 'high',
          metric: '未开启',
          evidence: ['RealTimeProtectionEnabled=False'],
          fixId: 'defender-enable',
          fixLabel: '尝试开启防护',
          fixTarget: null,
          requiresAdmin: true,
          risky: false,
          needsReboot: false,
          note: '若安装了第三方安全软件，Defender 可能由其接管。',
          page: null
        })
      }
    } else {
      checks.push(buildCheck('defender', '实时防护', '无法读取 Defender 状态，可能由第三方安全软件接管', 'skipped'))
    }

    const disabledProfiles = (security.firewall ?? []).filter((profile) => profile.enabled === false)
    if ((security.firewall ?? []).length === 0) {
      checks.push(buildCheck('firewall', '防火墙', '未能读取防火墙配置文件状态', 'skipped'))
    } else if (disabledProfiles.length > 0) {
      checks.push(buildCheck('firewall', '防火墙', `${disabledProfiles.length} 个网络配置文件未启用防火墙`, 'danger'))
      issues.push({
        id: 'firewall-disabled',
        category: 'security',
        title: 'Windows 防火墙未完全启用',
        detail: '部分网络配置文件的防火墙处于关闭状态，局域网或公共网络中的连接缺少拦截。',
        severity: 'high',
        metric: `${disabledProfiles.length} 个配置未启用`,
        evidence: disabledProfiles.map((profile) => `${profile.name || '网络配置文件'}：已关闭`),
        fixId: 'firewall-enable',
        fixLabel: '启用防火墙',
        fixTarget: null,
        requiresAdmin: true,
        risky: false,
        needsReboot: false,
        note: '修复会启用域、专用和公用三种网络配置文件的防火墙。',
        page: null
      })
    } else {
      checks.push(buildCheck('firewall', '防火墙', '域、专用与公用网络防火墙均已启用', 'ok'))
    }

    if (security.uac === 0) {
      checks.push(buildCheck('uac', '账户控制', 'UAC 已被关闭，程序可在无提示下修改系统', 'danger'))
      issues.push({
        id: 'uac-disabled',
        category: 'security',
        title: '用户账户控制（UAC）已关闭',
        detail: '关闭 UAC 后，恶意程序或脚本可以在没有提示的情况下修改系统设置。',
        severity: 'high',
        metric: 'EnableLUA=0',
        evidence: [`${UAC_PATH} · EnableLUA=0`],
        fixId: 'uac-enable',
        fixLabel: '恢复 UAC',
        fixTarget: null,
        requiresAdmin: true,
        risky: true,
        needsReboot: true,
        note: '修复前会备份原注册表值，重启后生效。',
        page: null
      })
    } else if (security.uac === null || security.uac === undefined) {
      checks.push(buildCheck('uac', '账户控制', '未能读取 UAC 状态', 'skipped'))
    } else {
      checks.push(buildCheck('uac', '账户控制', 'UAC 已启用，敏感操作会请求确认', 'ok'))
    }

    const policyIssues = security.policies ?? []
    if (policyIssues.length > 0) {
      checks.push(buildCheck('policies', '安全策略', `${policyIssues.length} 项策略限制需要确认`, 'issue'))
      for (const policy of policyIssues) {
        const meta = POLICY_META[policy.name || '']
        if (!meta || !policy.path) continue
        const requiresAdmin = /^HKLM:/i.test(policy.path)
        issues.push({
          id: `policy:${policy.path}:${policy.name}`,
          category: 'security',
          title: meta.title,
          detail: meta.detail,
          severity: meta.severity,
          metric: `${policy.name}=${policy.value ?? '启用'}`,
          evidence: [`${policy.path} · ${policy.name}=${policy.value ?? '启用'}`],
          fixId: 'policy-reset',
          fixLabel: '移除此限制',
          fixTarget: `${policy.path}|${policy.name}`,
          requiresAdmin,
          risky: true,
          needsReboot: false,
          note: '修复前会备份原策略值，仅移除这一项限制。',
          page: null
        })
      }
    } else {
      checks.push(buildCheck('policies', '安全策略', '未发现任务管理器、注册表或更新被策略限制', 'ok'))
    }

    const ifeo = security.ifeo ?? []
    if (ifeo.length > 0) {
      checks.push(buildCheck('ifeo', '映像劫持', `发现 ${ifeo.length} 个可疑调试器绑定`, 'danger'))
      for (const item of ifeo) {
        if (!item.name || !IFEO_TARGETS.has(item.name.toLowerCase())) continue
        issues.push({
          id: `ifeo:${item.name}`,
          category: 'security',
          title: `发现「${item.name}」映像劫持`,
          detail: '系统关键程序的启动入口被绑定到其他程序，恶意软件常用这种方式劫持或隐藏运行。',
          severity: 'high',
          metric: shorten(item.debugger || '', 36),
          evidence: [`${item.name} → ${item.debugger || '未知程序'}`],
          fixId: 'ifeo-clean',
          fixLabel: '解除劫持',
          fixTarget: item.name,
          requiresAdmin: true,
          risky: true,
          needsReboot: false,
          note: '修复前会备份原调试器路径，仅移除 Debugger 值。',
          page: null
        })
      }
    } else {
      checks.push(buildCheck('ifeo', '映像劫持', '未发现系统程序被调试器劫持', 'ok'))
    }

    const serviceIssues = security.services ?? []
    let serviceProblem = 0
    for (const spec of SERVICE_SPECS) {
      const raw = serviceIssues.find((item) => (item.name || '').toLowerCase() === spec.name.toLowerCase())
      if (!raw) continue
      const disabled = (raw.startType || '').toLowerCase() === 'disabled'
      const stopped = (raw.status || '').toLowerCase() === 'stopped'
      if (!disabled && !(spec.flagStopped && stopped)) continue
      serviceProblem++
      issues.push({
        id: `service:${spec.name}`,
        category: 'service',
        title: disabled ? `${spec.label} 已被禁用` : `${spec.label} 未运行`,
        detail: disabled
          ? '关键系统服务被设置为禁用，相关功能可能无法正常工作。'
          : '该服务通常应保持运行，停止后可能影响系统功能或安全更新。',
        severity: spec.severity,
        metric: disabled ? '已禁用' : '已停止',
        evidence: [`${raw.displayName || spec.label} · ${raw.status || '未知'} / ${raw.startType || '未知'}`],
        fixId: 'service-start',
        fixLabel: '恢复服务',
        fixTarget: `${spec.name}|${spec.startType}`,
        requiresAdmin: true,
        risky: false,
        needsReboot: false,
        note: `修复会将启动类型恢复为 ${spec.startType}${spec.flagStopped ? ' 并尝试立即启动' : ''}。`,
        page: null
      })
    }
    if (serviceProblem > 0) {
      checks.push(buildCheck('services', '关键服务', `${serviceProblem} 个关键服务需要恢复`, 'issue'))
    } else {
      checks.push(buildCheck('services', '关键服务', '关键系统服务启动状态正常', 'ok'))
    }

    const pending = security.pending ?? []
    if (pending.length > 0) {
      checks.push(buildCheck('pending-reboot', '更新重启', '有系统更新等待重启完成', 'issue'))
      issues.push({
        id: 'pending-reboot',
        category: 'system',
        title: '有系统更新等待重启完成',
        detail: '部分更新或文件替换需要重启电脑后才能生效，重启前建议保存正在处理的工作。',
        severity: 'low',
        metric: '待重启',
        evidence: pending.map((item) => `待处理标记：${item}`),
        fixId: null,
        fixLabel: null,
        fixTarget: null,
        requiresAdmin: false,
        risky: false,
        needsReboot: true,
        note: '请自行重启电脑，本工具不会强制重启。',
        page: null
      })
    } else {
      checks.push(buildCheck('pending-reboot', '更新重启', '没有等待重启的更新', 'ok'))
    }
  } else {
    checks.push(buildCheck('security', '安全配置', '未能读取系统安全配置', 'skipped'))
  }

  const hostsResult = hostsAnalysis(hosts.entries)
  if (!hosts.readable) {
    checks.push(buildCheck('hosts', 'hosts 文件', '无法读取 hosts 文件，可能需要管理员权限', 'skipped'))
  } else if (hostsResult.level === 'high' || hostsResult.level === 'medium') {
    checks.push(buildCheck('hosts', 'hosts 文件', 'hosts 中存在可能劫持安全或常用域名的记录', hostsResult.level === 'high' ? 'danger' : 'issue'))
    issues.push({
      id: 'hosts-suspicious',
      category: 'network',
      title: hostsResult.level === 'high' ? 'hosts 文件可能屏蔽了安全更新' : 'hosts 文件存在异常域名解析',
      detail:
        hostsResult.level === 'high'
          ? '部分安全更新或杀毒软件域名被指向本机或其他地址，系统可能无法获取安全补丁。'
          : '常用网站的域名被解析到非常规地址，可能存在流量劫持或广告注入。',
      severity: hostsResult.level,
      metric: `${hostsResult.evidence.length} 条异常`,
      evidence: hostsResult.evidence,
      fixId: 'hosts-reset',
      fixLabel: '恢复默认 hosts',
      fixTarget: null,
      requiresAdmin: true,
      risky: true,
      needsReboot: false,
      note: '修复前会完整备份现有 hosts 文件，自定义解析会被移除。',
      page: null
    })
  } else {
    checks.push(
      buildCheck(
        'hosts',
        'hosts 文件',
        hostsResult.customCount > 0 ? `包含 ${hostsResult.customCount} 条自定义解析，未发现安全域名被劫持` : '未发现异常解析记录',
        'ok'
      )
    )
  }

  if (proxy.enabled || proxy.pac) {
    checks.push(buildCheck('proxy', '系统代理', proxy.enabled ? '系统代理已开启' : '检测到自动代理脚本', 'issue'))
    issues.push({
      id: 'proxy-enabled',
      category: 'network',
      title: proxy.enabled ? '系统代理已开启' : '系统启用了自动代理脚本',
      detail: proxy.enabled
        ? '所有网络请求可能经过代理服务器，若非本人设置，可能存在流量劫持风险。'
        : '自动代理脚本（PAC）可能改变浏览器和应用的访问路径，请确认来源。',
      severity: 'medium',
      metric: shorten(proxy.server || proxy.pac || '已开启', 32),
      evidence: [
        proxy.enabled ? `ProxyEnable=1` : 'ProxyEnable=0',
        proxy.server ? `代理服务器：${proxy.server}` : '',
        proxy.pac ? `自动配置脚本：${proxy.pac}` : ''
      ].filter(Boolean),
      fixId: 'proxy-reset',
      fixLabel: '关闭系统代理',
      fixTarget: null,
      requiresAdmin: false,
      risky: false,
      needsReboot: false,
      note: '修复前会备份当前代理配置，可在数据目录中查看。',
      page: null
    })
  } else {
    checks.push(buildCheck('proxy', '系统代理', '未启用系统代理或自动代理脚本', 'ok'))
  }

  if (shortcuts === null) {
    checks.push(buildCheck('shortcuts', '快捷方式', '未能检查桌面与开始菜单快捷方式', 'skipped'))
  } else if (shortcuts.length > 0) {
    checks.push(buildCheck('shortcuts', '快捷方式', `发现 ${shortcuts.length} 个失效快捷方式`, 'issue'))
    issues.push({
      id: 'shortcuts-broken',
      category: 'shortcut',
      title: `发现 ${shortcuts.length} 个失效快捷方式`,
      detail: '快捷方式指向的程序已被卸载或移动，双击后无法打开。',
      severity: 'low',
      metric: `${shortcuts.length} 个`,
      evidence: shortcuts.slice(0, 5).map((item) => `${shorten(item.path, 64)} → ${shorten(item.target, 48)}`),
      fixId: 'shortcut-clean',
      fixLabel: '清理失效快捷方式',
      fixTarget: null,
      requiresAdmin: false,
      risky: false,
      needsReboot: false,
      note: '快捷方式会移入本地备份目录，不会被直接删除。',
      page: null
    })
  } else {
    checks.push(buildCheck('shortcuts', '快捷方式', '桌面与开始菜单快捷方式均可正常使用', 'ok'))
  }

  const missingFiles: string[] = []
  await Promise.all(
    keySystemFiles.map(async (relative) => {
      const target = path.join(systemRoot, relative)
      try {
        await fs.access(target)
      } catch {
        missingFiles.push(relative)
      }
    })
  )
  if (missingFiles.length > 0) {
    checks.push(buildCheck('system-files', '系统文件', `${missingFiles.length} 个关键系统文件缺失`, 'danger'))
    issues.push({
      id: 'system-files-missing',
      category: 'system',
      title: '发现关键系统文件缺失',
      detail: '部分 Windows 核心文件不存在，系统功能可能异常，也可能被恶意程序替换或删除。',
      severity: 'high',
      metric: `${missingFiles.length} 个缺失`,
      evidence: missingFiles.map((file) => path.join(systemRoot, file)),
      fixId: 'sfc-scan',
      fixLabel: '运行系统文件检查',
      fixTarget: null,
      requiresAdmin: true,
      risky: false,
      needsReboot: false,
      note: 'SFC 扫描可能需要数分钟，期间请保持程序运行。',
      page: null
    })
  } else {
    checks.push(buildCheck('system-files', '系统文件', '关键系统文件完整', 'ok'))
  }

  if (!startup) {
    checks.push(buildCheck('startup-watch', '自启动', '未能读取启动项进行安全检查', 'skipped'))
  } else {
    const suspect = suspiciousStartup(startup.items)
    if (suspect.length > 0) {
      checks.push(buildCheck('startup-watch', '自启动', `发现 ${suspect.length} 个可疑自启动命令`, 'danger'))
      issues.push({
        id: 'startup-suspicious',
        category: 'security',
        title: `发现 ${suspect.length} 个可疑自启动项`,
        detail: '启动命令指向临时目录、脚本宿主或远程下载地址，建议确认来源后禁用。',
        severity: 'high',
        metric: `${suspect.length} 项`,
        evidence: suspect.slice(0, 5).map((item) => `${item.name} · ${shorten(item.command, 88)}`),
        fixId: null,
        fixLabel: '去启动项管理',
        fixTarget: null,
        requiresAdmin: false,
        risky: false,
        needsReboot: false,
        note: '请在启动项管理中逐项确认来源，必要时禁用。',
        page: 'startup'
      })
    } else {
      checks.push(buildCheck('startup-watch', '自启动', '未发现临时目录、脚本宿主等可疑自启动项', 'ok'))
    }
  }

  issues.sort((a, b) => {
    const severity = severityOrder(a.severity) - severityOrder(b.severity)
    if (severity !== 0) return severity
    return a.title.localeCompare(b.title, 'zh-CN')
  })

  const deduction = issues.reduce(
    (sum, issue) => sum + (issue.severity === 'high' ? 12 : issue.severity === 'medium' ? 6 : 2),
    0
  )
  const riskEvents = await listRiskEvents(context.dataDir, 6)

  const report: RepairReport = {
    scannedAt: Date.now(),
    isAdmin,
    score: Math.max(0, Math.min(100, 100 - deduction)),
    checks,
    issues,
    riskEvents
  }
  lastReport = report
  return report
}

export function getLastRepairReport(): RepairReport | null {
  return lastReport
}

export async function listRepairRiskLog(dataDir: string, limit = 20): Promise<RiskEvent[]> {
  return listRiskEvents(dataDir, limit)
}

interface FixOutcome {
  ok: boolean
  message: string
  rebootRequired: boolean
}

function failure(message: string): FixOutcome {
  return { ok: false, message, rebootRequired: false }
}

async function writeBackup(dataDir: string, label: string, payload: unknown): Promise<string> {
  const backupDir = path.join(dataDir, 'repair-backups')
  await fs.mkdir(backupDir, { recursive: true })
  const target = path.join(backupDir, `${label}-${Date.now()}.json`)
  await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8')
  return target
}

async function readRegistryValue(regPath: string, valueName: string): Promise<string | null> {
  const script = psPayloadScript(
    { path: regPath, valueName },
    `
$item = Get-ItemProperty -LiteralPath $data.path -Name $data.valueName -ErrorAction SilentlyContinue
if ($null -eq $item) { Write-Output 'NULL' } else { [PSCustomObject]@{ value = [string]$item.($data.valueName) } | ConvertTo-Json -Compress }`
  )
  const output = await runPowerShell(script, 15000)
  if (!output || output === 'NULL') return null
  try {
    const parsed = JSON.parse(output) as { value?: string }
    return parsed.value ?? null
  } catch {
    return null
  }
}

async function fixHosts(dataDir: string): Promise<FixOutcome> {
  const target = hostsFilePath()
  let original = ''
  try {
    original = await fs.readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return failure('无法读取 hosts 文件，可能需要管理员权限')
    }
  }

  let backupPath = ''
  try {
    backupPath = await writeBackup(dataDir, 'hosts', { capturedAt: Date.now(), path: target, content: original })
  } catch {
    return failure('无法写入 hosts 备份，已取消修复')
  }

  const content = [
    '# Copyright (c) 1993-2009 Microsoft Corp.',
    '#',
    '# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.',
    '#',
    '127.0.0.1 localhost',
    '::1 localhost',
    ''
  ].join('\r\n')

  try {
    await fs.writeFile(target, content, 'utf8')
  } catch (error) {
    return failure(`写入 hosts 失败：${(error as Error).message}`)
  }
  return {
    ok: true,
    message: `hosts 已恢复默认，原文件备份在 ${backupPath}`,
    rebootRequired: false
  }
}

async function fixService(target: string): Promise<FixOutcome> {
  const [name, requestedType] = target.split('|')
  const spec = SERVICE_SPECS.find((item) => item.name.toLowerCase() === (name || '').toLowerCase())
  if (!spec) return failure('未知的系统服务')
  const startType = requestedType === 'Manual' ? 'Manual' : spec.startType
  const script = psPayloadScript(
    { name: spec.name, startType, startNow: spec.flagStopped },
    `
try {
  $svc = Get-Service -Name $data.name -ErrorAction Stop
  $changed = $false
  if ($svc.StartType -eq 'Disabled') {
    Set-Service -Name $data.name -StartupType $data.startType -ErrorAction Stop
    $changed = $true
  }
  if ($data.startNow -and $svc.Status -ne 'Running') {
    Start-Service -Name $data.name -ErrorAction Stop
    $changed = $true
  }
  if ($changed) { 'OK' } else { 'NOCHANGE' }
} catch { 'ERR:' + $_.Exception.Message }`
  )
  try {
    const output = await runPowerShell(script, 30000)
    if (output.startsWith('ERR:')) return failure(output.slice(4).trim() || '服务恢复失败')
    return {
      ok: true,
      message: output.includes('NOCHANGE') ? `${spec.label} 当前状态无需修改` : `${spec.label} 已恢复并尝试启动`,
      rebootRequired: false
    }
  } catch (error) {
    return failure(`服务恢复失败：${(error as Error).message}`)
  }
}

async function fixRegistryValue(
  dataDir: string,
  regPath: string,
  valueName: string,
  setValue: string | null,
  label: string,
  valueType: 'String' | 'DWord' = 'String'
): Promise<FixOutcome> {
  const oldValue = await readRegistryValue(regPath, valueName)
  try {
    await writeBackup(dataDir, label, {
      capturedAt: Date.now(),
      path: regPath,
      name: valueName,
      value: oldValue,
      action: setValue === null ? 'remove' : 'set',
      target: setValue
    })
  } catch {
    return failure('无法写入注册表备份，已取消修复')
  }

  const script =
    setValue === null
      ? psPayloadScript(
          { path: regPath, name: valueName },
          `
if (Test-Path -LiteralPath $data.path) {
  Remove-ItemProperty -LiteralPath $data.path -Name $data.name -Force -ErrorAction Stop
}
'OK'`
        )
      : psPayloadScript(
          { path: regPath, name: valueName, value: setValue, valueType },
          `
if (-not (Test-Path -LiteralPath $data.path)) { throw '注册表路径不存在' }
Set-ItemProperty -LiteralPath $data.path -Name $data.name -Value $data.value -Type $data.valueType -Force -ErrorAction Stop
'OK'`
        )

  try {
    const output = await runPowerShell(script, 20000)
    if (!output.includes('OK')) throw new Error(output || '未知错误')
    return { ok: true, message: `${label}已修复`, rebootRequired: false }
  } catch (error) {
    return failure(`${label}修复失败：${(error as Error).message}`)
  }
}

async function fixDefender(): Promise<FixOutcome> {
  const script = `
try {
  Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction Stop
} catch {}
Start-Sleep -Milliseconds 600
try {
  $status = Get-MpComputerStatus -ErrorAction Stop
  if ($status.RealTimeProtectionEnabled) { 'OK' } else { 'OFF' }
} catch { 'ERR:' + $_.Exception.Message }`
  try {
    const output = await runPowerShell(script, 40000)
    if (output.includes('OK')) {
      return { ok: true, message: 'Windows 实时防护已开启', rebootRequired: false }
    }
    if (output.startsWith('ERR:')) {
      return failure(`无法开启实时防护：${output.slice(4).trim()}`)
    }
    return failure('实时防护仍处于关闭状态，可能被系统策略或第三方安全软件接管')
  } catch (error) {
    return failure(`开启实时防护失败：${(error as Error).message}`)
  }
}

async function fixFirewall(): Promise<FixOutcome> {
  const script = `
try {
  Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -ErrorAction Stop
  $off = @(Get-NetFirewallProfile -ErrorAction Stop | Where-Object { -not $_.Enabled })
  if ($off.Count -eq 0) { 'OK' } else { 'OFF' }
} catch { 'ERR:' + $_.Exception.Message }`
  try {
    const output = await runPowerShell(script, 30000)
    if (output.includes('OK')) {
      return { ok: true, message: 'Windows 防火墙已全部启用', rebootRequired: false }
    }
    if (output.startsWith('ERR:')) return failure(`启用防火墙失败：${output.slice(4).trim()}`)
    return failure('部分防火墙配置文件仍处于关闭状态，可能被系统策略限制')
  } catch (error) {
    return failure(`启用防火墙失败：${(error as Error).message}`)
  }
}

async function fixIfeo(dataDir: string, target: string): Promise<FixOutcome> {
  if (!IFEO_TARGETS.has(target.toLowerCase())) return failure('未知的系统程序')
  const regPath = `HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\${target}`
  return fixRegistryValue(dataDir, regPath, 'Debugger', null, '映像劫持')
}

async function fixPolicy(dataDir: string, target: string): Promise<FixOutcome> {
  const separator = target.indexOf('|')
  if (separator <= 0) return failure('策略修复目标无效')
  const regPath = target.slice(0, separator)
  const valueName = target.slice(separator + 1)
  if (!/^HK(LM|CU):\\/i.test(regPath)) return failure('策略注册表路径无效')
  if (!POLICY_META[valueName]) return failure('未知的安全策略')
  return fixRegistryValue(dataDir, regPath, valueName, null, POLICY_META[valueName].title)
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

async function fixShortcuts(context: RepairScanContext): Promise<FixOutcome> {
  const broken = await scanBrokenShortcuts(context)
  if (broken === null) return failure('无法重新检查快捷方式，请稍后重试')
  if (broken.length === 0) return { ok: true, message: '未发现需要清理的失效快捷方式', rebootRequired: false }

  const backupDir = path.join(context.dataDir, 'repair-backups', `shortcuts-${Date.now()}`)
  try {
    await fs.mkdir(backupDir, { recursive: true })
  } catch {
    return failure('无法创建快捷方式备份目录，已取消清理')
  }

  const moved: string[] = []
  const failed: string[] = []
  for (const shortcut of broken) {
    try {
      const baseName = path.basename(shortcut.path).replace(/[<>:"/\\|?*]/g, '_')
      let destination = path.join(backupDir, baseName)
      let index = 1
      while (true) {
        try {
          await fs.access(destination)
          destination = path.join(backupDir, `${index}-${baseName}`)
          index++
        } catch {
          break
        }
      }
      await moveFile(shortcut.path, destination)
      moved.push(shortcut.path)
    } catch {
      failed.push(shortcut.path)
    }
  }

  try {
    await fs.writeFile(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify({ capturedAt: Date.now(), moved, failed }, null, 2),
      'utf8'
    )
  } catch {
    // 清单写入失败不影响已完成的移动
  }

  if (moved.length === 0) return failure('快捷方式移动失败，可能没有访问权限')
  return {
    ok: true,
    message:
      failed.length === 0
        ? `已清理 ${moved.length} 个失效快捷方式，备份在 ${backupDir}`
        : `已清理 ${moved.length} 个快捷方式，${failed.length} 个未能移动`,
    rebootRequired: false
  }
}

async function fixSfc(): Promise<FixOutcome> {
  let output: string
  try {
    output = await runPowerShell('& sfc.exe /scannow | Out-String', 900000)
  } catch (error) {
    return failure(`系统文件检查未能完成：${(error as Error).message}`)
  }
  if (!output.trim()) return failure('系统文件检查没有返回结果，请稍后重试')
  if (/未找到任何完整性冲突|未发现完整性冲突|did not find any integrity violations/i.test(output)) {
    return { ok: true, message: '系统文件检查完成：未发现完整性冲突', rebootRequired: false }
  }
  if (/成功修复|successfully repaired/i.test(output)) {
    return { ok: true, message: '系统文件检查完成：已修复损坏的系统文件', rebootRequired: false }
  }
  if (/无法修复|could not perform|unable to fix/i.test(output)) {
    return failure('系统文件检查发现损坏，但部分文件无法修复，建议运行 DISM 后再试')
  }
  return { ok: true, message: '系统文件检查已完成，请查看 CBS 日志获取详细结果', rebootRequired: false }
}

async function executeFix(context: RepairScanContext, issue: RepairIssue): Promise<FixOutcome> {
  switch (issue.fixId) {
    case 'hosts-reset':
      return fixHosts(context.dataDir)
    case 'proxy-reset': {
      const outcome = await disableProxy(context.dataDir)
      return { ok: outcome.ok, message: outcome.message, rebootRequired: false }
    }
    case 'service-start':
      return fixService(issue.fixTarget || '')
    case 'uac-enable':
      return fixRegistryValue(context.dataDir, UAC_PATH, 'EnableLUA', '1', '用户账户控制', 'DWord')
    case 'defender-enable':
      return fixDefender()
    case 'firewall-enable':
      return fixFirewall()
    case 'ifeo-clean':
      return fixIfeo(context.dataDir, issue.fixTarget || '')
    case 'policy-reset':
      return fixPolicy(context.dataDir, issue.fixTarget || '')
    case 'shortcut-clean':
      return fixShortcuts(context)
    case 'sfc-scan':
      return fixSfc()
    default:
      return failure('该问题暂不支持自动修复')
  }
}

export async function fixRepairIssues(context: RepairScanContext, issueIds: string[]): Promise<RepairFixResult> {
  const report = lastReport ?? (await scanRepair(context))
  const requested = new Set(issueIds)
  const issues = report.issues.filter((issue) => requested.has(issue.id) && issue.fixId)
  if (issues.length === 0) {
    return {
      result: { ok: false, message: '没有可修复的项目，请重新检测后重试' },
      fixed: [],
      failed: [],
      rebootRequired: false,
      report
    }
  }

  const admin = await getIsAdmin().catch(() => report.isAdmin)
  const fixed: string[] = []
  const failed: Array<{ id: string; title: string; message: string }> = []
  let rebootRequired = false
  const riskyFixed: RepairIssue[] = []

  for (const issue of issues) {
    if (issue.requiresAdmin && !admin) {
      failed.push({ id: issue.id, title: issue.title, message: '需要管理员权限，请重新以管理员身份启动后再试' })
      continue
    }
    const outcome = await executeFix(context, issue).catch((error) => failure((error as Error).message))
    if (outcome.ok) {
      fixed.push(issue.id)
      rebootRequired = rebootRequired || outcome.rebootRequired || issue.needsReboot
      if (issue.risky || issue.fixId === 'sfc-scan') riskyFixed.push(issue)
    } else {
      failed.push({ id: issue.id, title: issue.title, message: outcome.message })
    }
  }

  if (riskyFixed.length > 0) {
    try {
      await recordRiskEvent(context.dataDir, {
        kind: 'system-repair',
        title: `执行了 ${riskyFixed.length} 项系统级修复`,
        detail: riskyFixed.map((issue) => issue.title).join('、'),
        severity: riskyFixed.some((issue) => issue.severity === 'high') ? 'high' : 'medium'
      })
    } catch {
      // 风险记录失败不影响修复结果
    }
  }

  const nextReport = await scanRepair(context)
  const message =
    fixed.length === 0
      ? `修复未完成：${failed[0]?.message ?? '未知错误'}`
      : failed.length === 0
        ? `已完成 ${fixed.length} 项修复${rebootRequired ? '，部分设置重启后生效' : ''}`
        : `已完成 ${fixed.length} 项修复，${failed.length} 项失败`

  return {
    result: { ok: fixed.length > 0, message },
    fixed,
    failed,
    rebootRequired,
    report: nextReport
  }
}
