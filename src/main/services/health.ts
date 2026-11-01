import type { HealthIssue, HealthProgress, HealthReport } from '@shared/types'
import { scanJunk } from './junk'
import { listStartup } from './startup'
import { getSystemSnapshot } from './system'
import { getLastScanSummary, readScanHistory } from './virus'

const listeners = new Set<(progress: HealthProgress) => void>()
let lastReport: HealthReport | null = null

export function onHealthProgress(listener: (progress: HealthProgress) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(stage: HealthProgress['stage'], label: string, percent: number): void {
  for (const listener of listeners) listener({ stage, label, percent })
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
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const

export async function runHealthCheck(dataDir: string): Promise<HealthReport> {
  emit('system', '正在读取系统状态…', 6)
  const snapshot = await getSystemSnapshot(true)

  emit('junk', '正在扫描垃圾文件…', 24)
  const junk = await scanJunk(30000)

  emit('startup', '正在检查开机启动项…', 60)
  const startup = await listStartup()

  emit('protection', '正在检查安全防护状态…', 78)
  const history = await readScanHistory(dataDir)
  const latestScan = history[0] ?? null
  const sessionScan = getLastScanSummary()
  const lastScanAt = sessionScan?.finishedAt ?? latestScan?.completedAt ?? null
  const threatCount = sessionScan?.threats.length ?? latestScan?.threats ?? 0
  const scanCancelled = sessionScan ? sessionScan.cancelled : latestScan?.cancelled === true

  emit('score', '正在计算健康评分…', 94)

  let score = 100
  const issues: HealthIssue[] = []

  const junkMb = junk.totalBytes / (1024 * 1024)
  if (junkMb >= 2048) {
    score -= 12
    issues.push({
      id: 'junk',
      title: '垃圾文件占用较多',
      detail: `检测到 ${formatBytes(junk.totalBytes)} 临时文件与缓存，可以安全清理`,
      severity: 'high',
      metric: formatBytes(junk.totalBytes),
      actionPage: 'junk',
      actionLabel: '立即清理'
    })
  } else if (junkMb >= 100) {
    score -= junkMb >= 500 ? 7 : 4
    issues.push({
      id: 'junk',
      title: '垃圾文件待清理',
      detail: `检测到 ${formatBytes(junk.totalBytes)} 临时文件，建议定期清理释放空间`,
      severity: junkMb >= 500 ? 'medium' : 'low',
      metric: formatBytes(junk.totalBytes),
      actionPage: 'junk',
      actionLabel: '去清理'
    })
  } else if (junkMb >= 10) {
    score -= 1
    issues.push({
      id: 'junk',
      title: '有少量临时文件',
      detail: `共 ${formatBytes(junk.totalBytes)}，空闲时可以顺手清理`,
      severity: 'low',
      metric: formatBytes(junk.totalBytes),
      actionPage: 'junk',
      actionLabel: '去清理'
    })
  }

  if (startup.enabledCount > 12) {
    score -= 10
    issues.push({
      id: 'startup',
      title: '开机启动项过多',
      detail: `${startup.enabledCount} 个程序会随系统启动，其中 ${startup.highImpactCount} 个建议重点关注`,
      severity: 'high',
      metric: `${startup.enabledCount} 项`,
      actionPage: 'startup',
      actionLabel: '去优化'
    })
  } else if (startup.enabledCount > 8) {
    score -= 6
    issues.push({
      id: 'startup',
      title: '开机启动项偏多',
      detail: `${startup.enabledCount} 个程序会随系统启动，可能拖慢开机速度`,
      severity: 'medium',
      metric: `${startup.enabledCount} 项`,
      actionPage: 'startup',
      actionLabel: '去优化'
    })
  } else if (startup.enabledCount > 5) {
    score -= 3
    issues.push({
      id: 'startup',
      title: '启动项略有富余',
      detail: `${startup.enabledCount} 个程序会随系统启动，可按需关闭不常用项`,
      severity: 'low',
      metric: `${startup.enabledCount} 项`,
      actionPage: 'startup',
      actionLabel: '查看'
    })
  }

  if (snapshot.memoryPercent >= 85) {
    score -= 10
    issues.push({
      id: 'memory',
      title: '内存占用偏高',
      detail: `当前内存占用 ${snapshot.memoryPercent}%，可能会影响程序响应速度`,
      severity: 'high',
      metric: `${snapshot.memoryPercent}%`,
      actionPage: null,
      actionLabel: null
    })
  } else if (snapshot.memoryPercent >= 70) {
    score -= 4
    issues.push({
      id: 'memory',
      title: '内存占用较高',
      detail: `当前内存占用 ${snapshot.memoryPercent}%，建议关闭暂时不用的程序`,
      severity: 'medium',
      metric: `${snapshot.memoryPercent}%`,
      actionPage: null,
      actionLabel: null
    })
  }

  const criticalDisk = snapshot.disks
    .filter((disk) => disk.total > 0)
    .map((disk) => ({ ...disk, freePercent: (disk.free / disk.total) * 100 }))
    .sort((a, b) => a.freePercent - b.freePercent)[0]
  if (criticalDisk && criticalDisk.freePercent < 15) {
    const deduction = criticalDisk.freePercent < 5 ? 12 : criticalDisk.freePercent < 10 ? 7 : 3
    score -= deduction
    issues.push({
      id: 'disk',
      title: criticalDisk.freePercent < 5 ? '磁盘空间严重不足' : '磁盘空间不足',
      detail: `${criticalDisk.id} 盘剩余 ${formatBytes(criticalDisk.free)}，可用比例 ${criticalDisk.freePercent.toFixed(0)}%`,
      severity: criticalDisk.freePercent < 10 ? 'high' : 'medium',
      metric: `${criticalDisk.freePercent.toFixed(0)}% 可用`,
      actionPage: null,
      actionLabel: null
    })
  }

  if (snapshot.defender.available) {
    if (!snapshot.defender.realtime) {
      score -= 12
      issues.push({
        id: 'protection',
        title: '系统实时防护未开启',
        detail: 'Windows Defender 实时保护处于关闭状态，建议在 Windows 安全中心开启',
        severity: 'high',
        metric: '未开启',
        actionPage: null,
        actionLabel: null
      })
    }
  } else {
    score -= 1
    issues.push({
      id: 'protection-status',
      title: '未能读取系统防护状态',
      detail: '无法获取 Windows Defender 状态，请在 Windows 安全中心确认实时保护已开启',
      severity: 'low',
      metric: '未知',
      actionPage: null,
      actionLabel: null
    })
  }

  if (threatCount > 0) {
    score -= 15
    issues.push({
      id: 'threats',
      title: `上次查杀发现 ${threatCount} 个风险项`,
      detail: '风险项目尚未处理，建议立即查杀并隔离',
      severity: 'high',
      metric: `${threatCount} 个`,
      actionPage: 'virus',
      actionLabel: '立即处理'
    })
  }

  if (!lastScanAt) {
    score -= 6
    issues.push({
      id: 'scan',
      title: '尚未进行过病毒查杀',
      detail: '建议完成一次全盘查杀，确认电脑没有安全风险',
      severity: 'medium',
      metric: '从未查杀',
      actionPage: 'virus',
      actionLabel: '去查杀'
    })
  } else {
    const days = Math.floor((Date.now() - lastScanAt) / 86400000)
    if (days > 30) {
      score -= 6
      issues.push({
        id: 'scan',
        title: '长时间未进行查杀',
        detail: `距离上次查杀已过去 ${days} 天，建议重新检查电脑`,
        severity: 'medium',
        metric: `${days} 天前`,
        actionPage: 'virus',
        actionLabel: '去查杀'
      })
    } else if (days > 7) {
      score -= 3
      issues.push({
        id: 'scan',
        title: '建议进行一次查杀',
        detail: `距离上次查杀已过去 ${days} 天`,
        severity: 'low',
        metric: `${days} 天前`,
        actionPage: 'virus',
        actionLabel: '去查杀'
      })
    }
    if (scanCancelled) {
      score -= 2
      issues.push({
        id: 'scan-cancelled',
        title: '上次查杀未完成',
        detail: '扫描被提前中止，结果可能不完整',
        severity: 'low',
        metric: '未完成',
        actionPage: 'virus',
        actionLabel: '重新查杀'
      })
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  const report: HealthReport = {
    score,
    verdict: score >= 90 ? 'excellent' : score >= 70 ? 'good' : 'poor',
    checkedAt: Date.now(),
    issues,
    junkBytes: junk.totalBytes,
    junkFiles: junk.totalFiles,
    startupCount: startup.enabledCount,
    threatCount,
    lastScanAt,
    snapshot
  }
  lastReport = report
  emit('score', '体检完成', 100)
  return report
}

export function getLastHealthReport(): HealthReport | null {
  return lastReport
}
