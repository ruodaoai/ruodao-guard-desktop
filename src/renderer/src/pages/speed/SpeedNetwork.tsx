import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Globe2,
  Loader2,
  Network,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  WifiOff,
  Zap
} from 'lucide-react'
import type { NetworkStatus, OptimizeStep } from '@shared/types'
import { Button, Card, Chip, ConfirmDialog, EmptyState, Skeleton } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { cx, errorMessage, timeAgo } from '../../lib/format'

function latencyTone(value: number | null): 'green' | 'amber' | 'red' | 'gray' {
  if (value === null) return 'gray'
  if (value <= 60) return 'green'
  if (value <= 150) return 'amber'
  return 'red'
}

function latencyLabel(value: number | null): string {
  return value === null ? '超时' : `${value} ms`
}

function stepTone(step: OptimizeStep): 'green' | 'amber' | 'gray' {
  if (step.ok) return 'green'
  return step.requiresAdmin ? 'amber' : 'gray'
}

export function SpeedNetwork(): React.JSX.Element {
  const api = window.ruodao
  const toast = useToast()
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flushDns, setFlushDns] = useState(true)
  const [resetProxy, setResetProxy] = useState(true)
  const [optimizeTcp, setOptimizeTcp] = useState(true)
  const [pending, setPending] = useState<'quick' | 'winsock' | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<OptimizeStep[]>([])
  const [relaunching, setRelaunching] = useState(false)

  const load = async (force: boolean): Promise<void> => {
    if (force) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      setStatus(await api.speed.network(force))
    } catch (loadError) {
      const message = errorMessage(loadError)
      setError(message)
      toast.push('error', message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load(false)
  }, [])

  const apply = async (kind: 'quick' | 'winsock'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const outcome =
        kind === 'quick'
          ? await api.speed.optimizeNetwork({
              flushDns,
              resetProxy,
              optimizeTcp,
              resetWinsock: false
            })
          : await api.speed.optimizeNetwork({
              flushDns: false,
              resetProxy: false,
              optimizeTcp: false,
              resetWinsock: true
            })
      setSteps(outcome.steps)
      setStatus(outcome.status)
      toast.push(outcome.result.ok ? 'success' : 'error', outcome.result.message)
    } catch (actionError) {
      toast.push('error', errorMessage(actionError))
    } finally {
      setBusy(false)
      setPending(null)
      setAck(false)
    }
  }

  const relaunch = async (): Promise<void> => {
    if (relaunching) return
    setRelaunching(true)
    try {
      const outcome = await api.app.relaunchAsAdmin()
      toast.push(outcome.ok ? 'success' : 'error', outcome.message)
    } catch (relaunchError) {
      toast.push('error', errorMessage(relaunchError))
    } finally {
      setRelaunching(false)
    }
  }

  const quickCount = [flushDns, resetProxy, optimizeTcp].filter(Boolean).length

  return (
    <div className="speed-panel">
      {status && !status.isAdmin ? (
        <div className="admin-banner">
          <span className="admin-banner-icon">
            <ShieldAlert size={18} />
          </span>
          <div>
            <b>当前不是管理员模式</b>
            <p>刷新 DNS、关闭代理可以直接执行；优化 TCP 参数需要管理员权限。建议以管理员身份重新启动后再优化网络。</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={relaunching ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
            onClick={() => void relaunch()}
            disabled={relaunching}
          >
            {relaunching ? '正在重启…' : '以管理员身份重启'}
          </Button>
        </div>
      ) : null}

      <Card className="speed-hero speed-network-hero">
        <div className="speed-network-main">
          <span className="speed-kicker">
            <Globe2 size={15} />
            网络加速
          </span>
          <div className="speed-network-title">
            {loading ? (
              <Skeleton className="skeleton-speed-count" />
            ) : status && status.adapters.length > 0 ? (
              <b>{status.adapters[0].name}</b>
            ) : (
              <b>未检测到已连接的网络</b>
            )}
            {status && status.adapters.length > 0 ? (
              <Chip tone="green">{status.adapters[0].status === 'Up' ? '已连接' : status.adapters[0].status}</Chip>
            ) : null}
          </div>
          <p className="speed-network-sub">
            {status && status.adapters.length > 0
              ? `${status.adapters[0].description || '网络适配器'}${status.adapters[0].speedLabel ? ` · ${status.adapters[0].speedLabel}` : ''}`
              : loading
                ? '正在读取网络适配器与延迟…'
                : '请检查网线、Wi-Fi 或网络服务状态'}
          </p>

          <div className="speed-ping-row">
            {loading ? (
              <Skeleton className="skeleton-ping" />
            ) : status && status.pings.length > 0 ? (
              status.pings.map((ping) => (
                <span className={cx('speed-ping', `speed-ping-${latencyTone(ping.latencyMs)}`)} key={`${ping.kind}-${ping.target}`}>
                  <span className="speed-ping-dot" />
                  <b>{ping.label}</b>
                  <span>{latencyLabel(ping.latencyMs)}</span>
                </span>
              ))
            ) : (
              <span className="speed-ping speed-ping-gray">
                <WifiOff size={13} />
                暂无延迟数据
              </span>
            )}
          </div>
        </div>
        <div className="speed-hero-actions">
          <Button
            variant="primary"
            icon={<Zap size={16} />}
            onClick={() => setPending('quick')}
            disabled={loading || busy || quickCount === 0}
          >
            一键网络优化
          </Button>
          <Button
            variant="secondary"
            icon={refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? '测速中…' : '重新检测'}
          </Button>
        </div>
      </Card>

      {error ? (
        <div className="inline-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => void load(true)}>
            重试
          </button>
        </div>
      ) : null}

      <div className="speed-network-grid">
        <Card className="speed-action-card">
          <div className="card-head">
            <div>
              <h3>网络设置检查</h3>
              <p>清理解析缓存与异常代理，恢复正常的网络访问路径</p>
            </div>
            <Chip tone={status?.proxyEnabled ? 'amber' : 'green'}>
              {status?.proxyEnabled ? '代理已开启' : '未使用代理'}
            </Chip>
          </div>
          <div className="speed-option-list">
            <label className={cx('speed-option', flushDns && 'is-checked')}>
              <input type="checkbox" checked={flushDns} onChange={(event) => setFlushDns(event.target.checked)} />
              <div>
                <b>刷新 DNS 缓存</b>
                <span>清除旧的域名解析记录，适合网页打不开或跳转异常时使用</span>
              </div>
              <Chip tone="green">可直接执行</Chip>
            </label>
            <label className={cx('speed-option', resetProxy && 'is-checked')}>
              <input type="checkbox" checked={resetProxy} onChange={(event) => setResetProxy(event.target.checked)} />
              <div>
                <b>关闭系统代理</b>
                <span>
                  {status?.proxyServer ? `当前代理：${status.proxyServer}` : '移除代理服务器与自动配置脚本，避免流量被劫持'}
                </span>
              </div>
              <Chip tone="green">可直接执行</Chip>
            </label>
            <label className={cx('speed-option', optimizeTcp && 'is-checked')}>
              <input type="checkbox" checked={optimizeTcp} onChange={(event) => setOptimizeTcp(event.target.checked)} />
              <div>
                <b>优化 TCP 参数</b>
                <span>将接收窗口自动调整级别恢复为系统默认值，改善网络吞吐</span>
              </div>
              <Chip tone="amber">需管理员</Chip>
            </label>
          </div>
          <div className="speed-info-strip">
            <span>DNS 服务器</span>
            <b>{status && status.dnsServers.length > 0 ? status.dnsServers.join(' / ') : '自动获取'}</b>
            <span>hosts 记录</span>
            <b>{status ? `${status.hostsEntries} 条` : '—'}</b>
            <span>检测时间</span>
            <b>{status ? timeAgo(status.capturedAt) : '—'}</b>
          </div>
        </Card>

        <Card className="speed-danger-card">
          <div className="speed-danger-head">
            <span className="speed-danger-icon">
              <ShieldAlert size={18} />
            </span>
            <div>
              <h3>高级网络重置</h3>
              <p>仅在网络完全异常、常规优化无效时使用</p>
            </div>
          </div>
          <div className="speed-danger-body">
            <b>重置 Winsock 网络组件</b>
            <p>
              将所有网络协议栈恢复为系统默认状态，会清除部分网络软件的 LSP 设置。操作完成后必须重启电脑才能恢复联网。
            </p>
            <div className="speed-danger-tags">
              <Chip tone="red">需要重启</Chip>
              <Chip tone="amber">可能影响 VPN / 加速器</Chip>
            </div>
            <Button variant="danger" size="sm" icon={<RotateCcw size={15} />} onClick={() => setPending('winsock')} disabled={busy}>
              重置 Winsock
            </Button>
          </div>
        </Card>
      </div>

      {status && status.adapters.length > 0 ? (
        <Card className="speed-adapter-card">
          <div className="card-head">
            <div>
              <h3>网络适配器</h3>
              <p>当前已连接的网络接口与地址</p>
            </div>
          </div>
          <div className="speed-adapter-list">
            {status.adapters.map((adapter) => (
              <div className="speed-adapter-row" key={`${adapter.name}-${adapter.ipv4.join('-')}`}>
                <span className="speed-adapter-icon">
                  <Network size={16} />
                </span>
                <div className="speed-adapter-copy">
                  <b>{adapter.name}</b>
                  <span>{adapter.description || '网络适配器'}</span>
                </div>
                <div className="speed-adapter-meta">
                  <span>IPv4</span>
                  <b>{adapter.ipv4.join(', ') || '—'}</b>
                </div>
                <div className="speed-adapter-meta">
                  <span>网关</span>
                  <b>{adapter.gateway.join(', ') || '—'}</b>
                </div>
                <div className="speed-adapter-meta">
                  <span>DNS</span>
                  <b>{adapter.dns.join(', ') || '自动'}</b>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : !loading ? (
        <Card className="speed-adapter-card">
          <EmptyState
            icon={<WifiOff size={26} />}
            title="没有检测到已连接的网络"
            description="连接 Wi-Fi 或插入网线后点击「重新检测」"
            action={
              <Button variant="secondary" size="sm" onClick={() => void load(true)} loading={refreshing}>
                重新检测
              </Button>
            }
          />
        </Card>
      ) : null}

      {steps.length > 0 ? (
        <Card className="speed-result-card">
          <div className="card-head">
            <div>
              <h3>最近一次优化结果</h3>
              <p>每一步的执行情况与权限提示</p>
            </div>
          </div>
          <div className="speed-result-list">
            {steps.map((step) => (
              <div className="speed-result-row" key={step.id}>
                {step.ok ? (
                  <CheckCircle2 size={16} className="speed-result-ok" />
                ) : (
                  <AlertTriangle size={16} className="speed-result-warn" />
                )}
                <b>{step.label}</b>
                <span>{step.message}</span>
                <Chip tone={stepTone(step)}>{step.ok ? '成功' : step.requiresAdmin ? '需管理员' : '未完成'}</Chip>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        open={pending === 'quick'}
        onClose={() => {
          if (!busy) setPending(null)
        }}
        onConfirm={() => void apply('quick')}
        title="执行一键网络优化？"
        confirmText="开始优化"
        tone="amber"
        busy={busy}
        icon={<Zap size={22} />}
      >
        <p>将依次执行以下操作，均不会删除个人文件：</p>
        <div className="confirm-list">
          {flushDns ? (
            <div className="confirm-list-item">
              <span>刷新 DNS 缓存</span>
              <b>可以直接执行</b>
            </div>
          ) : null}
          {resetProxy ? (
            <div className="confirm-list-item">
              <span>关闭系统代理</span>
              <b>会先备份原配置</b>
            </div>
          ) : null}
          {optimizeTcp ? (
            <div className="confirm-list-item">
              <span>优化 TCP 参数</span>
              <b>需要管理员权限</b>
            </div>
          ) : null}
        </div>
        <p className="modal-note">若当前正在使用公司代理或 VPN，请先确认关闭代理不会影响正常上网。</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending === 'winsock'}
        onClose={() => {
          if (!busy) {
            setPending(null)
            setAck(false)
          }
        }}
        onConfirm={() => void apply('winsock')}
        title="重置 Winsock 网络组件？"
        confirmText="确认重置"
        tone="danger"
        busy={busy}
        confirmDisabled={!ack}
        icon={<ShieldAlert size={22} />}
      >
        <p>
          这是高影响操作：重置后网络协议栈会恢复默认，部分 VPN、网游加速器或安全软件的联网组件可能需要重新安装或配置，电脑必须重启才能恢复联网。
        </p>
        <label className="danger-ack">
          <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
          我了解该操作需要重启，并确认现在执行
        </label>
        <p className="modal-note">该操作会写入「系统修复 · 危险操作日志」。</p>
      </ConfirmDialog>

      {status ? (
        <p className="speed-footnote">
          延迟结果来自本机对网关、DNS 与公共 DNS 的连通性测试，仅用于判断网络质量，不会上传任何数据。
        </p>
      ) : null}
    </div>
  )
}
