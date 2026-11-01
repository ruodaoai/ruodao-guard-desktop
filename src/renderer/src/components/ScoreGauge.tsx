import { useId } from 'react'
import { clampPercent, cx } from '../lib/format'

type GaugeTone = 'green' | 'amber' | 'red' | 'brand' | 'idle'

const COLORS: Record<GaugeTone, [string, string]> = {
  green: ['#20dea0', '#04a46d'],
  amber: ['#ffcb66', '#f0a020'],
  red: ['#ff9a88', '#e9503f'],
  brand: ['#1ee0a1', '#039e6c'],
  idle: ['#d8e4de', '#c3d4cc']
}

function resolveTone(value: number | null, mode: 'score' | 'progress'): GaugeTone {
  if (mode === 'progress') return 'brand'
  if (value === null) return 'idle'
  if (value >= 90) return 'green'
  if (value >= 70) return 'amber'
  return 'red'
}

export function ScoreGauge({
  value,
  mode = 'score',
  caption
}: {
  value: number | null
  mode?: 'score' | 'progress'
  caption?: string
}): React.JSX.Element {
  const gradientId = useId().replace(/:/g, '')
  const tone = resolveTone(value, mode)
  const [startColor, endColor] = COLORS[tone]
  const radius = 79
  const circumference = 2 * Math.PI * radius
  const percent = value === null ? 0 : clampPercent(value)
  const offset = circumference * (1 - percent / 100)

  return (
    <div className={cx('gauge', `gauge-${tone}`)}>
      <svg viewBox="0 0 190 190" className="gauge-svg">
        <defs>
          <linearGradient id={gradientId} x1="20" y1="20" x2="170" y2="180" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={startColor} />
            <stop offset="1" stopColor={endColor} />
          </linearGradient>
        </defs>
        <circle cx="95" cy="95" r="89" fill="none" stroke="rgba(0, 158, 108, 0.05)" strokeWidth="1" />
        <circle cx="95" cy="95" r={radius} fill="none" stroke="#edf3f0" strokeWidth="14" />
        <circle
          cx="95"
          cy="95"
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 95 95)"
          className="gauge-progress"
        />
        <circle cx="95" cy="164" r="2.5" fill={startColor} opacity="0.5" />
      </svg>
      <div className="gauge-center">
        <div className="gauge-value">
          {value === null ? '—' : Math.round(value)}
          {value === null ? null : <span>{mode === 'progress' ? '%' : '分'}</span>}
        </div>
        <div className="gauge-caption">
          {caption ?? (value === null ? '待体检' : mode === 'progress' ? '体检进度' : '安全评分')}
        </div>
      </div>
    </div>
  )
}
