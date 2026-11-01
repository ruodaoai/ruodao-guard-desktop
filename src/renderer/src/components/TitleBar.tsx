import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { Logo } from './Logo'

export function TitleBar(): React.JSX.Element {
  const api = window.ruodao
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!api) return
    let alive = true
    api.window
      .isMaximized()
      .then((value) => {
        if (alive) setMaximized(value)
      })
      .catch(() => undefined)
    const unsubscribe = api.window.onMaximizeChange(setMaximized)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])

  const toggleMaximize = (): void => {
    api?.window.toggleMaximize().catch(() => undefined)
  }

  return (
    <header className="titlebar" onDoubleClick={toggleMaximize}>
      <div className="titlebar-brand">
        <Logo size={26} />
        <div className="titlebar-titles">
          <span className="titlebar-name">若道安全卫士</span>
          <span className="titlebar-sub">Ruodao Guard</span>
        </div>
      </div>
      <div className="titlebar-right">
        <span className="titlebar-badge">
          <span className="live-dot" />
          本地防护引擎
        </span>
        <span className="titlebar-divider" />
        <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
          <button type="button" className="window-btn" onClick={() => api?.window.minimize()} aria-label="最小化" title="最小化">
            <Minus size={16} />
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={toggleMaximize}
            aria-label={maximized ? '还原' : '最大化'}
            title={maximized ? '还原' : '最大化'}
          >
            {maximized ? <Copy size={14} /> : <Square size={14} />}
          </button>
          <button
            type="button"
            className="window-btn window-close"
            onClick={() => api?.window.close()}
            aria-label="关闭"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </header>
  )
}
