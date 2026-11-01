import {
  useEffect,
  type ButtonHTMLAttributes,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, ShieldCheck, X } from 'lucide-react'
import { clampPercent, cx } from '../lib/format'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={cx('btn', `btn-${variant}`, `btn-${size}`, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="spin" size={16} /> : icon ? <span className="btn-icon">{icon}</span> : null}
      {children}
    </button>
  )
}

export function Card({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cx('card', className)} {...rest}>
      {children}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet'

export function Chip({
  tone = 'gray',
  children,
  className
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <span className={cx('chip', `chip-${tone}`, className)}>{children}</span>
}

export function ProgressBar({
  value,
  tone = 'brand',
  size = 'md',
  striped = false,
  indeterminate = false
}: {
  value: number
  tone?: 'brand' | 'amber' | 'red' | 'blue' | 'gray'
  size?: 'sm' | 'md'
  striped?: boolean
  indeterminate?: boolean
}): React.JSX.Element {
  const percent = clampPercent(value)
  return (
    <div
      className={cx('progress', `progress-${size}`, striped && 'progress-striped', indeterminate && 'progress-indeterminate')}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={indeterminate ? '扫描进行中' : undefined}
    >
      <div
        className={cx('progress-fill', `progress-${tone}`)}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('toggle', checked && 'toggle-on', disabled && 'toggle-disabled')}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
    >
      <span className="toggle-knob" />
    </button>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {description ? <p className="empty-description">{description}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <span className={cx('skeleton', className)} />
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 520
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  width?: number
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {description ? <p>{description}</p> : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        {children ? <div className="modal-body">{children}</div> : null}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmText = '确认',
  cancelText = '取消',
  tone = 'brand',
  icon,
  busy = false,
  confirmDisabled = false
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  confirmText?: string
  cancelText?: string
  tone?: 'brand' | 'danger' | 'amber'
  icon?: ReactNode
  busy?: boolean
  confirmDisabled?: boolean
}): React.JSX.Element {
  const defaultIcon =
    tone === 'danger' ? <AlertTriangle size={22} /> : tone === 'amber' ? <AlertTriangle size={22} /> : <ShieldCheck size={22} />
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {cancelText}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={confirmDisabled}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className={cx('confirm-content', `confirm-${tone}`)}>
        <div className="confirm-icon">{icon ?? defaultIcon}</div>
        <div className="confirm-copy">
          {description}
          {children}
        </div>
      </div>
    </Modal>
  )
}
