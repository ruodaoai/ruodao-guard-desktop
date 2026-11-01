import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listSoftware } from '../src/main/services/software'
import { configureStartupStore, listStartup } from '../src/main/services/startup'
import { getSystemSnapshot } from '../src/main/services/system'
import { scanJunk } from '../src/main/services/junk'
import {
  createTestSample,
  getScanState,
  quarantineScanThreats,
  readScanHistory,
  startVirusScan
} from '../src/main/services/virus'
import { deleteQuarantine, listQuarantine, restoreQuarantine } from '../src/main/services/quarantine'

function log(title: string, value: unknown): void {
  console.log(`\n== ${title} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const workDir = path.join(os.tmpdir(), `ruodao-smoke-${Date.now()}`)
  const scanDir = path.join(workDir, 'scan-target')
  const dataDir = path.join(workDir, 'appdata')
  await fs.mkdir(scanDir, { recursive: true })
  configureStartupStore(dataDir)

  try {
    const snapshot = await getSystemSnapshot(true)
    log('系统信息', {
      os: `${snapshot.osName} ${snapshot.osVersion}`,
      cpu: `${snapshot.cpuModel} / ${snapshot.cpuCores} cores / ${snapshot.cpuUsage}%`,
      memory: `${snapshot.memoryPercent}%`,
      disks: snapshot.disks.map((disk) => `${disk.id} ${disk.free}/${disk.total}`),
      defender: snapshot.defender,
      admin: snapshot.isAdmin
    })

    const software = await listSoftware(true)
    log('软件列表', {
      count: software.items.length,
      totalBytes: software.totalBytes,
      sample: software.items.slice(0, 6).map((item) => `${item.name} ${item.version} [${item.source}]`)
    })

    const startup = await listStartup()
    log('启动项', {
      enabled: startup.enabledCount,
      disabled: startup.disabledCount,
      highImpact: startup.highImpactCount,
      sample: startup.items.slice(0, 6).map((item) => `${item.name} (${item.sourceLabel}) ${item.command.slice(0, 60)}`)
    })

    const junk = await scanJunk()
    log('垃圾扫描', {
      totalBytes: junk.totalBytes,
      totalFiles: junk.totalFiles,
      categories: junk.categories.map((category) => `${category.name}: ${category.bytes} bytes / ${category.files} files`)
    })

    const sample = await createTestSample(scanDir)
    log('生成测试样本', sample)
    if (!sample.path) throw new Error('样本创建失败')

    const summary = await startVirusScan({ mode: 'custom', target: scanDir }, {
      dataDir,
      desktop: path.join(os.homedir(), 'Desktop'),
      downloads: scanDir
    })
    log('自定义查杀', {
      scanned: summary.scannedFiles,
      threats: summary.threats.map((threat) => ({ name: threat.name, path: threat.path, kind: threat.kind })),
      cancelled: summary.cancelled
    })
    if (summary.threats.length === 0) throw new Error('演示样本未被检出')

    const state = getScanState()
    log('扫描状态', { active: state.active, lastThreats: state.last?.threats.length ?? null })

    const quarantineResult = await quarantineScanThreats(
      summary.threats.map((threat) => threat.id),
      dataDir
    )
    log('隔离结果', quarantineResult)
    const quarantined = await listQuarantine(dataDir)
    log('隔离区', quarantined.map((item) => `${item.threatName} <- ${item.originalPath}`))
    if (quarantined.length !== 1) throw new Error('隔离区记录异常')

    const restored = await restoreQuarantine(dataDir, [quarantined[0].id])
    log('恢复隔离文件', restored)
    await fs.access(sample.path)

    const summary2 = await startVirusScan({ mode: 'custom', target: scanDir }, {
      dataDir,
      desktop: path.join(os.homedir(), 'Desktop'),
      downloads: scanDir
    })
    if (summary2.threats.length === 0) throw new Error('恢复后的样本未被再次检出')
    const quarantineResult2 = await quarantineScanThreats(
      summary2.threats.map((threat) => threat.id),
      dataDir
    )
    const quarantined2 = await listQuarantine(dataDir)
    const removed = await deleteQuarantine(dataDir, [quarantined2[0].id])
    log('二次隔离并永久删除', { quarantineResult2, removed })

    const history = await readScanHistory(dataDir)
    log('查杀历史', history)
    console.log('\nSMOKE OK')
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error('\nSMOKE FAILED')
  console.error(error)
  process.exitCode = 1
})
