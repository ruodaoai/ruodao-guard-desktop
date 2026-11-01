import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  OptimizeStep,
  PerformanceOptimizeInput,
  PerformanceOptimizeResult,
  PerformanceStatus,
  PowerPlan,
  VisualEffectsMode
} from '@shared/types'
import { psJson, runPowerShell } from './powershell'

interface RawPerformanceState {
  isAdmin?: boolean
  plans?: Array<{ guid?: string; name?: string; active?: boolean }>
  visualEffects?: number
  processCount?: number
}

const VISUAL_LABELS: Record<number, string> = {
  0: '由 Windows 管理',
  1: '最佳外观',
  2: '最佳性能',
  3: '自定义'
}

const VISUAL_VALUES: Record<VisualEffectsMode, number> = {
  balanced: 0,
  appearance: 1,
  performance: 2
}

const VISUAL_MESSAGES: Record<VisualEffectsMode, string> = {
  balanced: '已恢复为由 Windows 管理视觉效果',
  appearance: '已切换为最佳外观，重新登录后完全生效',
  performance: '已切换为最佳性能，重新登录后完全生效'
}

function visualMode(value: number): PerformanceStatus['visualEffectsMode'] {
  if (value === 0) return 'balanced'
  if (value === 1) return 'appearance'
  if (value === 2) return 'performance'
  return 'custom'
}

function runPowerCfg(args: string[], timeout = 15000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'powercfg.exe',
      args,
      { windowsHide: true, timeout, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        resolve({
          code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          output: Buffer.isBuffer(stdout) ? stdout.toString('latin1') : String(stdout ?? '')
        })
      }
    )
  })
}

async function readRawPerformanceState(): Promise<RawPerformanceState | null> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$plans = @()
foreach ($plan in (Get-CimInstance -Namespace 'root\\cimv2\\power' -ClassName 'Win32_PowerPlan')) {
  $instance = [string]$plan.InstanceID
  $guid = $instance.Substring($instance.LastIndexOf('{') + 1).TrimEnd('}')
  $plans += [PSCustomObject]@{ guid = $guid; name = [string]$plan.ElementName; active = [bool]$plan.IsActive }
}
if ($plans.Count -eq 0) {
  # Win32_PowerPlan 在远程会话中被禁用，回退到 powercfg 文本输出
  foreach ($line in (& powercfg.exe -list 2>$null)) {
    if ($line -match 'GUID:\\s*([0-9a-fA-F-]{36})\\s*\\(([^)]*)\\)\\s*(\\*)?') {
      $plans += [PSCustomObject]@{
        guid = $matches[1]
        name = $matches[2].Trim()
        active = ($matches[3] -eq '*')
      }
    }
  }
}
$vfx = 0
$value = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting -ErrorAction SilentlyContinue).VisualFXSetting
if ($null -ne $value) { $vfx = [int]$value }
$count = @(Get-Process).Count
[PSCustomObject]@{
  isAdmin = [bool]$isAdmin
  plans = @($plans)
  visualEffects = [int]$vfx
  processCount = [int]$count
} | ConvertTo-Json -Depth 4 -Compress`
  return psJson<RawPerformanceState>(script, 20000)
}

export async function getPerformanceStatus(): Promise<PerformanceStatus> {
  const raw = await readRawPerformanceState().catch(() => null)
  const plans: PowerPlan[] = (raw?.plans ?? [])
    .filter((plan) => typeof plan.guid === 'string' && !!plan.name)
    .map((plan) => ({ guid: plan.guid!, name: plan.name!, active: plan.active === true }))
  const active = plans.find((plan) => plan.active)
  const visualEffects = raw?.visualEffects ?? 0
  const totalMem = os.totalmem()
  const freeMem = os.freemem()

  return {
    capturedAt: Date.now(),
    plans,
    activePlan: active?.name || '未知电源计划',
    visualEffects,
    visualEffectsLabel: VISUAL_LABELS[visualEffects] ?? '自定义',
    visualEffectsMode: visualMode(visualEffects),
    memoryUsed: totalMem - freeMem,
    memoryTotal: totalMem,
    memoryPercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
    processCount: raw?.processCount ?? 0,
    uptimeSec: Math.round(os.uptime()),
    isAdmin: raw?.isAdmin === true
  }
}

async function applyPowerPlan(guid: string, name: string, active: boolean): Promise<OptimizeStep> {
  if (active) {
    return {
      id: 'power-plan',
      label: '切换电源计划',
      ok: true,
      message: `当前已在使用「${name}」电源计划`,
      requiresAdmin: false,
      risky: false
    }
  }
  const result = await runPowerCfg(['/setactive', guid])
  return {
    id: 'power-plan',
    label: '切换电源计划',
    ok: result.code === 0,
    message:
      result.code === 0
        ? `已切换到「${name}」电源计划`
        : '电源计划切换失败，请尝试以管理员身份启动后重试',
    requiresAdmin: false,
    risky: false
  }
}

async function applyVisualEffects(dataDir: string, mode: VisualEffectsMode): Promise<OptimizeStep> {
  const target = VISUAL_VALUES[mode]
  const backupDir = path.join(dataDir, 'repair-backups')
  try {
    await fs.mkdir(backupDir, { recursive: true })
    const current = await readRawPerformanceState().catch(() => null)
    await fs.writeFile(
      path.join(backupDir, `visual-effects-${Date.now()}.json`),
      JSON.stringify({ capturedAt: Date.now(), previous: current?.visualEffects ?? 0, applied: target }, null, 2),
      'utf8'
    )
  } catch {
    return {
      id: 'visual-effects',
      label: '调整视觉效果',
      ok: false,
      message: '无法保存原有视觉效果设置，已取消修改',
      requiresAdmin: false,
      risky: false
    }
  }

  const script = `
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects'
if (-not (Test-Path -LiteralPath $key)) { $null = New-Item -Path $key -Force }
Set-ItemProperty -LiteralPath $key -Name VisualFXSetting -Value ${target} -Type DWord -Force
'OK'`
  try {
    const output = await runPowerShell(script, 20000)
    return {
      id: 'visual-effects',
      label: '调整视觉效果',
      ok: output.includes('OK'),
      message: output.includes('OK') ? VISUAL_MESSAGES[mode] : '视觉效果设置失败',
      requiresAdmin: false,
      risky: false
    }
  } catch (error) {
    return {
      id: 'visual-effects',
      label: '调整视觉效果',
      ok: false,
      message: `视觉效果设置失败：${(error as Error).message}`,
      requiresAdmin: false,
      risky: false
    }
  }
}

export async function optimizePerformance(
  dataDir: string,
  input: PerformanceOptimizeInput
): Promise<PerformanceOptimizeResult> {
  const status = await getPerformanceStatus()
  const steps: OptimizeStep[] = []

  const planGuid = input.planGuid
  if (planGuid) {
    const plan = status.plans.find((candidate) => candidate.guid.toLowerCase() === planGuid.toLowerCase())
    if (!plan) {
      steps.push({
        id: 'power-plan',
        label: '切换电源计划',
        ok: false,
        message: '未找到指定的电源计划，请刷新后重试',
        requiresAdmin: false,
        risky: false
      })
    } else {
      steps.push(await applyPowerPlan(plan.guid, plan.name, plan.active))
    }
  }

  if (input.visualEffects) {
    steps.push(await applyVisualEffects(dataDir, input.visualEffects))
  }

  if (steps.length === 0) {
    return {
      result: { ok: false, message: '请选择要应用的性能优化项目' },
      steps,
      status
    }
  }

  const succeeded = steps.filter((step) => step.ok).length
  const failed = steps.length - succeeded
  const message =
    failed === 0
      ? `性能优化完成，共应用 ${succeeded} 项设置`
      : succeeded > 0
        ? `已完成 ${succeeded} 项，${failed} 项未生效`
        : `性能优化未完成：${steps.find((step) => !step.ok)?.message ?? '未知错误'}`

  return {
    result: { ok: succeeded > 0, message },
    steps,
    status: await getPerformanceStatus()
  }
}
