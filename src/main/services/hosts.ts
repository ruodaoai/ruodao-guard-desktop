import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface HostsEntry {
  line: number
  ip: string
  hosts: string[]
  raw: string
}

export interface HostsFile {
  path: string
  exists: boolean
  readable: boolean
  entries: HostsEntry[]
}

export function hostsFilePath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'drivers', 'etc', 'hosts')
}

export async function readHostsFile(): Promise<HostsFile> {
  const target = hostsFilePath()
  let text: string
  try {
    text = await fs.readFile(target, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { path: target, exists: code !== 'ENOENT', readable: false, entries: [] }
  }

  const entries: HostsEntry[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return
    const parts = line.split(/\s+/)
    if (parts.length < 2) return
    const [ip, ...hosts] = parts
    entries.push({ line: index + 1, ip, hosts, raw: raw.trim() })
  })

  return { path: target, exists: true, readable: true, entries }
}
