import type { AiProvider, ScanMode } from '@shared/types'

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  if (index === 0) return `${Math.round(value)} B`
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : fractionDigits
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[index]}`
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${formatDate(timestamp)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function timeAgo(timestamp: number | null): string {
  if (!timestamp) return '暂无记录'
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatDate(timestamp)
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 秒'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

export function shortPath(value: string, head = 22, tail = 34): string {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function scanModeLabel(mode: ScanMode): string {
  if (mode === 'quick') return '快速查杀'
  if (mode === 'full') return '全盘查杀'
  return '自定义查杀'
}

export function usagePercent(free: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round(((total - free) / total) * 100)))
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '操作失败，请稍后重试'
}

export function aiProviderLabel(provider: AiProvider): string {
  return provider === 'ruodao' ? '若道云' : '自定义服务'
}
