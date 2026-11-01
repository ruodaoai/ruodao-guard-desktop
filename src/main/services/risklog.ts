import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RepairSeverity, RiskEvent } from '@shared/types'

const MAX_EVENTS = 120

function logPath(dataDir: string): string {
  return path.join(dataDir, 'risk-events.json')
}

function isRiskEvent(value: unknown): value is RiskEvent {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.at === 'number' &&
    (item.kind === 'process-end' || item.kind === 'network-change' || item.kind === 'system-repair') &&
    typeof item.title === 'string' &&
    typeof item.detail === 'string' &&
    (item.severity === 'high' || item.severity === 'medium' || item.severity === 'low')
  )
}

export async function listRiskEvents(dataDir: string, limit = 20): Promise<RiskEvent[]> {
  try {
    const text = await fs.readFile(logPath(dataDir), 'utf8')
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isRiskEvent)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, Math.min(limit, MAX_EVENTS)))
  } catch {
    return []
  }
}

export async function recordRiskEvent(
  dataDir: string,
  input: { kind: RiskEvent['kind']; title: string; detail: string; severity: RepairSeverity }
): Promise<void> {
  const event: RiskEvent = {
    id: randomUUID(),
    at: Date.now(),
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    severity: input.severity
  }
  const existing = await listRiskEvents(dataDir, MAX_EVENTS)
  const next = [event, ...existing].slice(0, MAX_EVENTS)
  await fs.mkdir(dataDir, { recursive: true })
  const target = logPath(dataDir)
  const temp = `${target}.${Date.now()}.tmp`
  await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(temp, target)
}
