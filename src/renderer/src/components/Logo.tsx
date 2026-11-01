import { useId } from 'react'

export function Logo({ size = 28 }: { size?: number }): React.JSX.Element {
  const gradientId = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" className="brand-logo">
      <defs>
        <linearGradient id={gradientId} x1="140" y1="90" x2="900" y2="940" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1ee0a1" />
          <stop offset="0.48" stopColor="#08bd82" />
          <stop offset="1" stopColor="#009468" />
        </linearGradient>
      </defs>
      <rect x="72" y="64" width="880" height="880" rx="214" fill={`url(#${gradientId})`} />
      <path
        d="M512 236C590 274 672 292 744 296C750 404 740 514 700 608C662 696 594 754 512 794C430 754 362 696 324 608C284 514 274 404 280 296C352 292 434 274 512 236Z"
        fill="#ffffff"
        fillOpacity="0.97"
      />
      <path
        d="M416 508L486 578L626 426"
        fill="none"
        stroke="#00a874"
        strokeWidth="62"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
