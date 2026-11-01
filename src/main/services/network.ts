import { execFile } from 'node:child_process'
import type {
  NetworkAdapterInfo,
  NetworkOptimizeInput,
  NetworkOptimizeResult,
  NetworkPing,
  NetworkStatus,
  OptimizeStep
} from '@shared/types'
import { readHostsFile } from './hosts'
import { psJson } from './powershell'
import { disableProxy, readProxyState } from './proxy'
import { recordRiskEvent } from './risklog'
import { getIsAdmin } from './system'

interface RawNetworkState {
  isAdmin?: boolean
  adapters?: Array<{
    name?: string
    description?: string
    status?: string
    speedLabel?: string
    ipv4?: string[]
    dns?: string[]
    gateway?: string[]
  }>
}

const FALLBACK_DNS = ['223.5.5.5', '119.29.29.29']

function execBuffer(file: string, args: string[], timeout = 15000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        resolve({
          code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          stdout: String(stdout ?? '')
        })
      }
    )
  })
}

function pingTarget(target: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'ping.exe',
      ['-n', '2', '-w', '900', target],
      { windowsHide: true, timeout: 7000, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 },
      (_error, stdout) => {
        const text = Buffer.isBuffer(stdout) ? stdout.toString('latin1') : String(stdout ?? '')
        const lines = text.split(/\r?\n/)
        const replies = lines.filter((line) => /ttl/i.test(line))
        const source = replies.length
          ? replies
          : lines.filter((line) => /\bms\b/i.test(line) && !/minimum|maximum|average|最小|最大|平均/i.test(line))
        const values = source
          .map((line) => line.match(/[=<]\s*(\d+)\s*ms/i))
          .filter((match): match is RegExpMatchArray => Boolean(match))
          .map((match) => Number(match[1]))
          .filter((value) => Number.isFinite(value))
        if (values.length === 0) {
          resolve(null)
          return
        }
        resolve(Math.round(values.reduce((sum, value) => sum + value, 0) / values.length))
      }
    )
  })
}

async function readRawNetworkState(): Promise<RawNetworkState | null> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$adapters = @()
foreach ($cfg in (Get-NetIPConfiguration)) {
  if (-not $cfg.NetAdapter -or $cfg.NetAdapter.Status -ne 'Up') { continue }
  $dns = @()
  foreach ($server in @($cfg.DNSServer)) {
    if ($server -and $server.ServerAddresses) { $dns += @($server.ServerAddresses) }
  }
  $adapters += [PSCustomObject]@{
    name = [string]$cfg.InterfaceAlias
    description = [string]$cfg.InterfaceDescription
    status = [string]$cfg.NetAdapter.Status
    speedLabel = [string]$cfg.NetAdapter.LinkSpeed
    ipv4 = @($cfg.IPv4Address | ForEach-Object { [string]$_.IPAddress })
    dns = @($dns | Select-Object -Unique)
    gateway = @($cfg.IPv4DefaultGateway | ForEach-Object { [string]$_.NextHop })
  }
}
[PSCustomObject]@{ isAdmin = [bool]$isAdmin; adapters = @($adapters) } | ConvertTo-Json -Depth 5 -Compress`
  return psJson<RawNetworkState>(script, 20000)
}

export async function getNetworkStatus(): Promise<NetworkStatus> {
  const [raw, proxy, hosts] = await Promise.all([
    readRawNetworkState().catch(() => null),
    readProxyState(),
    readHostsFile().catch(() => null)
  ])

  const adapters: NetworkAdapterInfo[] = (raw?.adapters ?? [])
    .filter((adapter) => (adapter.ipv4 ?? []).length > 0)
    .map((adapter) => ({
      name: adapter.name || '网络连接',
      description: adapter.description || '',
      status: adapter.status || 'Unknown',
      speedLabel: adapter.speedLabel || '',
      ipv4: adapter.ipv4 ?? [],
      dns: adapter.dns ?? [],
      gateway: adapter.gateway ?? []
    }))

  const dnsServers = [...new Set(adapters.flatMap((adapter) => adapter.dns))].slice(0, 3)
  const gateways = [...new Set(adapters.flatMap((adapter) => adapter.gateway))].slice(0, 1)

  const targets: Array<{ target: string; label: string; kind: NetworkPing['kind'] }> = []
  for (const gateway of gateways) targets.push({ target: gateway, label: `网关 ${gateway}`, kind: 'gateway' })
  for (const dns of dnsServers) targets.push({ target: dns, label: `DNS ${dns}`, kind: 'dns' })
  for (const dns of FALLBACK_DNS) {
    if (!dnsServers.includes(dns) && !gateways.includes(dns)) {
      targets.push({ target: dns, label: `公共 DNS ${dns}`, kind: 'internet' })
    }
  }

  const pingResults = await Promise.all(targets.slice(0, 5).map((item) => pingTarget(item.target)))
  const pings: NetworkPing[] = targets.slice(0, 5).map((item, index) => ({
    ...item,
    latencyMs: pingResults[index] ?? null
  }))

  return {
    capturedAt: Date.now(),
    adapters,
    dnsServers,
    proxyEnabled: proxy.enabled,
    proxyServer: proxy.server,
    hostsEntries: hosts?.entries.length ?? 0,
    pings,
    isAdmin: raw?.isAdmin === true
  }
}

async function flushDns(): Promise<OptimizeStep> {
  const result = await execBuffer('ipconfig.exe', ['/flushdns'], 20000)
  return {
    id: 'flush-dns',
    label: '刷新 DNS 缓存',
    ok: result.code === 0,
    message: result.code === 0 ? 'DNS 缓存已清空，新的域名解析将重新获取' : '刷新 DNS 缓存失败，请稍后重试',
    requiresAdmin: false,
    risky: false
  }
}

async function runNetsh(id: string, args: string[], label: string, risky: boolean): Promise<OptimizeStep> {
  const result = await execBuffer('netsh.exe', args, 30000)
  return {
    id,
    label,
    ok: result.code === 0,
    message: result.code === 0 ? `${label}已执行` : `${label}执行失败，请确认管理员权限或稍后重试`,
    requiresAdmin: true,
    risky
  }
}

export async function optimizeNetwork(dataDir: string, input: NetworkOptimizeInput): Promise<NetworkOptimizeResult> {
  const steps: OptimizeStep[] = []
  const admin = await getIsAdmin()

  if (input.flushDns) {
    steps.push(await flushDns())
  }

  if (input.resetProxy) {
    const outcome = await disableProxy(dataDir)
    steps.push({
      id: 'reset-proxy',
      label: '关闭系统代理',
      ok: outcome.ok,
      message: outcome.message,
      requiresAdmin: false,
      risky: false
    })
  }

  if (input.optimizeTcp) {
    if (!admin) {
      steps.push({
        id: 'optimize-tcp',
        label: '优化 TCP 参数',
        ok: false,
        message: '需要管理员权限，请重新以管理员身份启动后再试',
        requiresAdmin: true,
        risky: false
      })
    } else {
      steps.push(await runNetsh('optimize-tcp', ['int', 'tcp', 'set', 'global', 'autotuninglevel=normal'], '优化 TCP 参数', false))
    }
  }

  let rebootRequired = false
  if (input.resetWinsock) {
    if (!admin) {
      steps.push({
        id: 'reset-winsock',
        label: '重置 Winsock',
        ok: false,
        message: '需要管理员权限，请重新以管理员身份启动后再试',
        requiresAdmin: true,
        risky: true
      })
    } else {
      const step = await runNetsh('reset-winsock', ['winsock', 'reset'], '重置 Winsock', true)
      steps.push(step)
      rebootRequired = step.ok
      if (step.ok) {
        try {
          await recordRiskEvent(dataDir, {
            kind: 'network-change',
            title: '重置了 Winsock 网络组件',
            detail: '重置网络协议栈，需要重启电脑后生效',
            severity: 'high'
          })
        } catch {
          // 日志失败不影响操作结果
        }
      }
    }
  } else if (input.optimizeTcp && steps.some((step) => step.id.includes('optimize-tcp') && step.ok)) {
    try {
      await recordRiskEvent(dataDir, {
        kind: 'network-change',
        title: '调整了 TCP 全局参数',
        detail: '已将 TCP 接收窗口自动调整级别恢复为系统默认值',
        severity: 'medium'
      })
    } catch {
      // 日志失败不影响操作结果
    }
  }

  const succeeded = steps.filter((step) => step.ok).length
  const failed = steps.length - succeeded
  const message =
    steps.length === 0
      ? '请选择要执行的网络优化项目'
      : failed === 0
        ? `网络优化完成，共执行 ${succeeded} 项${rebootRequired ? '，重启后生效' : ''}`
        : succeeded > 0
          ? `已完成 ${succeeded} 项，${failed} 项未能执行${rebootRequired ? '，重启后生效' : ''}`
          : `网络优化未完成：${steps.find((step) => !step.ok)?.message ?? '未知错误'}`

  return {
    result: { ok: succeeded > 0, message },
    steps,
    rebootRequired,
    status: await getNetworkStatus()
  }
}
