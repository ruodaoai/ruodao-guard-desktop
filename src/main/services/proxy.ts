import { promises as fs } from 'node:fs'
import path from 'node:path'
import { psJson, runPowerShell } from './powershell'

export interface ProxyState {
  enabled: boolean
  server: string
  pac: string
}

const PROXY_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

interface RawProxyState {
  enabled?: number
  server?: string
  pac?: string
}

export async function readProxyState(): Promise<ProxyState> {
  const script = `
$p = Get-ItemProperty -LiteralPath '${PROXY_KEY}' -ErrorAction SilentlyContinue
[PSCustomObject]@{
  enabled = $(if ($null -ne $p.ProxyEnable) { [int]$p.ProxyEnable } else { 0 })
  server = [string]$p.ProxyServer
  pac = [string]$p.AutoConfigURL
} | ConvertTo-Json -Compress`
  try {
    const raw = await psJson<RawProxyState>(script, 15000)
    return {
      enabled: (raw?.enabled ?? 0) === 1,
      server: raw?.server || '',
      pac: raw?.pac || ''
    }
  } catch {
    return { enabled: false, server: '', pac: '' }
  }
}

export async function disableProxy(dataDir: string): Promise<{ ok: boolean; message: string; changed: boolean }> {
  const state = await readProxyState()
  if (!state.enabled && !state.pac) {
    return { ok: true, message: '系统代理已处于关闭状态', changed: false }
  }

  const backupDir = path.join(dataDir, 'repair-backups')
  const backupPath = path.join(backupDir, `proxy-${Date.now()}.json`)
  try {
    await fs.mkdir(backupDir, { recursive: true })
    await fs.writeFile(
      backupPath,
      JSON.stringify({ capturedAt: Date.now(), proxyEnabled: state.enabled, proxyServer: state.server, pac: state.pac }, null, 2),
      'utf8'
    )
  } catch {
    return { ok: false, message: '无法写入代理设置备份，已取消修改', changed: false }
  }

  const script = `
Set-ItemProperty -LiteralPath '${PROXY_KEY}' -Name ProxyEnable -Value 0 -Type DWord -Force
$pac = (Get-ItemProperty -LiteralPath '${PROXY_KEY}' -Name AutoConfigURL -ErrorAction SilentlyContinue).AutoConfigURL
if ($null -ne $pac) { Remove-ItemProperty -LiteralPath '${PROXY_KEY}' -Name AutoConfigURL -Force -ErrorAction SilentlyContinue }
try {
  Add-Type -Namespace RuodaoWinInet -Name Native -MemberDefinition '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
  [RuodaoWinInet.Native]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
  [RuodaoWinInet.Native]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
} catch {}
'OK'`

  try {
    const output = await runPowerShell(script, 30000)
    if (!output.includes('OK')) throw new Error(output || '未知错误')
    return { ok: true, message: '已关闭系统代理与自动代理脚本，原配置已备份', changed: true }
  } catch (error) {
    return {
      ok: false,
      message: `关闭系统代理失败：${(error as Error).message}`,
      changed: false
    }
  }
}

export { PROXY_KEY }
