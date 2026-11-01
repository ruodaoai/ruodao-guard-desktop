import { CircuitBoard, Gauge, Package, Rocket, Settings, ShieldCheck, Sparkles, Trash2, Wrench } from 'lucide-react'
import type { PageId } from '@shared/types'
import { cx } from '../lib/format'

const NAV_ITEMS = [
  { id: 'home' as const, label: '首页体检', icon: Gauge },
  { id: 'virus' as const, label: '木马查杀', icon: ShieldCheck },
  { id: 'junk' as const, label: '垃圾清理', icon: Trash2 },
  { id: 'software' as const, label: '软件管家', icon: Package },
  { id: 'drivers' as const, label: '驱动管理', icon: CircuitBoard },
  { id: 'startup' as const, label: '加速中心', icon: Rocket },
  { id: 'repair' as const, label: '系统修复', icon: Wrench }
]

export function Sidebar({
  current,
  onNavigate,
  version
}: {
  current: PageId
  onNavigate: (page: PageId) => void
  version?: string
}): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-label">智能助手</div>
      <nav className="sidebar-nav" aria-label="智能助手导航">
        <button
          type="button"
          className={cx('nav-item', 'nav-item-ai', current === 'assistant' && 'nav-item-active')}
          onClick={() => onNavigate('assistant')}
        >
          <span className="nav-icon">
            <Sparkles size={19} strokeWidth={2} />
          </span>
          <span>AI 安全助手</span>
        </button>
      </nav>

      <div className="sidebar-label sidebar-label-spaced">安全防护</div>
      <nav className="sidebar-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={cx('nav-item', current === item.id && 'nav-item-active')}
              onClick={() => onNavigate(item.id)}
            >
              <span className="nav-icon">
                <Icon size={19} strokeWidth={2} />
              </span>
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-label sidebar-label-spaced">系统</div>
      <nav className="sidebar-nav" aria-label="系统导航">
        <button
          type="button"
          className={cx('nav-item', current === 'settings' && 'nav-item-active')}
          onClick={() => onNavigate('settings')}
        >
          <span className="nav-icon">
            <Settings size={19} strokeWidth={2} />
          </span>
          <span>设置中心</span>
        </button>
      </nav>

      <div className="sidebar-spacer" />

      <div className="security-card">
        <div className="security-card-head">
          <span className="security-card-icon">
            <ShieldCheck size={18} />
          </span>
          <span className="security-card-title">本地安全引擎</span>
        </div>
        <p>扫描全程在本机完成，不上传文件，不打扰使用。</p>
        <span className="security-card-foot">无广告 · 无捆绑</span>
      </div>

      <div className="sidebar-foot">
        <span>v{version || '1.0.0'}</span>
        <span>Windows</span>
      </div>
    </aside>
  )
}
