import { execFile } from 'node:child_process'

export const POWERSHELL_PATH = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe'

const PREAMBLE = [
  '$ProgressPreference = "SilentlyContinue"',
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$OutputEncoding = [Console]::OutputEncoding'
].join('; ')

export function runPowerShell(script: string, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL_PATH,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${PREAMBLE}; ${script}`
      ],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
          if (killed) {
            reject(new Error('系统命令执行超时，请稍后重试'))
            return
          }
          reject(new Error((stderr || error.message || '系统命令执行失败').trim()))
          return
        }
        resolve(stdout.replace(/^\uFEFF/, '').trim())
      }
    )
  })
}

export async function psJson<T>(script: string, timeout = 30000): Promise<T | null> {
  const output = await runPowerShell(script, timeout)
  if (!output) return null
  try {
    return JSON.parse(output) as T
  } catch {
    throw new Error(`无法解析系统命令输出：${output.slice(0, 160)}`)
  }
}

export function psPayloadScript(payload: unknown, body: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return [
    `$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
    body
  ].join('; ')
}
