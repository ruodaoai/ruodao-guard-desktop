import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  push: (kind: ToastKind, message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast 必须在 ToastProvider 内使用')
  return context
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, number>())
  const counter = useRef(0)

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(id)
    setItems((previous) => previous.filter((item) => item.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = Date.now() + counter.current++
      setItems((previous) => [...previous.slice(-2), { id, kind, message }])
      const timer = window.setTimeout(() => dismiss(id), 4200)
      timers.current.set(id, timer)
    },
    [dismiss]
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])

  const api = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`}>
            <span className="toast-icon">
              {item.kind === 'success' ? (
                <CheckCircle2 size={18} />
              ) : item.kind === 'error' ? (
                <AlertCircle size={18} />
              ) : (
                <Info size={18} />
              )}
            </span>
            <span className="toast-message">{item.message}</span>
            <button className="toast-close" onClick={() => dismiss(item.id)} aria-label="关闭提示">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
