import { useEffect, useState } from 'react'
import type { PageId } from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { ToastProvider } from './components/Toast'
import { AssistantPage } from './pages/AssistantPage'
import { DriverPage } from './pages/DriverPage'
import { HomePage } from './pages/HomePage'
import { JunkPage } from './pages/JunkPage'
import { SettingsPage } from './pages/SettingsPage'
import { SoftwarePage } from './pages/SoftwarePage'
import { SpeedPage } from './pages/SpeedPage'
import { RepairPage } from './pages/RepairPage'
import { VirusPage } from './pages/VirusPage'

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('home')
  const [version, setVersion] = useState<string>()

  useEffect(() => {
    if (!window.ruodao) return
    window.ruodao.app
      .info()
      .then((info) => setVersion(info.version))
      .catch(() => undefined)
  }, [])

  if (!window.ruodao) {
    return (
      <div className="boot-error">
        <h1>未能加载安全引擎</h1>
        <p>预加载脚本没有正确运行，请重新启动若道安全卫士。</p>
      </div>
    )
  }

  return (
    <ToastProvider>
      <div className="app">
        <TitleBar />
        <div className="app-body">
          <Sidebar current={page} onNavigate={setPage} version={version} />
          <main className="main">
            <div className="page-scroll" key={page}>
              {page === 'home' ? <HomePage onNavigate={setPage} /> : null}
              {page === 'assistant' ? <AssistantPage onNavigate={setPage} /> : null}
              {page === 'virus' ? <VirusPage onNavigate={setPage} /> : null}
              {page === 'junk' ? <JunkPage onNavigate={setPage} /> : null}
              {page === 'software' ? <SoftwarePage onNavigate={setPage} /> : null}
              {page === 'drivers' ? <DriverPage /> : null}
              {page === 'startup' ? <SpeedPage /> : null}
              {page === 'repair' ? <RepairPage onNavigate={setPage} /> : null}
              {page === 'settings' ? <SettingsPage onNavigate={setPage} /> : null}
            </div>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
