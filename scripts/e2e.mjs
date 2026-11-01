import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'test-artifacts', 'ui')
const results = []
const errors = []
let appRef = null

function log(message) {
  console.log(message)
}

async function main() {
  await mkdir(artifacts, { recursive: true })

  const packagedExe = process.env.E2E_EXECUTABLE
  const electronApp = await electron.launch({
    executablePath: packagedExe
      ? path.resolve(root, packagedExe)
      : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: packagedExe ? [] : ['.'],
    cwd: root
  })
  appRef = electronApp

  const page = await electronApp.firstWindow()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  await page.waitForSelector('.titlebar', { timeout: 15000 })
  await page.waitForTimeout(1600)

  async function shot(name) {
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) })
    log(`[shot] ${name}`)
  }

  async function shotLower(name) {
    const scroller = page.locator('.page-scroll').last()
    if (!(await scroller.count())) return
    const scrollable = await scroller.evaluate(
      (element) => element.scrollHeight - element.clientHeight > 80
    )
    if (!scrollable) return
    await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight))
    await page.waitForTimeout(350)
    await page.screenshot({ path: path.join(artifacts, `${name}-lower.png`) })
    log(`[shot] ${name}-lower`)
    await scroller.evaluate((element) => element.scrollTo(0, 0))
    await page.waitForTimeout(200)
  }

  async function navigate(label) {
    await page.locator('.nav-item').filter({ hasText: label }).first().click()
    await page.waitForTimeout(500)
  }

  await shot('01-home')
  await shotLower('01-home')
  results.push({ page: 'home', title: await page.locator('.home-intro h1').innerText() })

  const score = await page.locator('.gauge-value').innerText().catch(() => 'n/a')
  log(`[check] home score gauge: ${score.replace(/\s+/g, ' ')}`)

  await page.getByRole('button', { name: /立即体检|重新体检/ }).first().click()
  await page.waitForSelector('.home-hero-running', { timeout: 5000 })
  await shot('02-home-checking')
  await page.waitForFunction(() => !document.querySelector('.home-hero-running'), { timeout: 60000 })
  await page.waitForTimeout(400)
  await shot('03-home-checked')
  await shotLower('03-home-checked')
  const checkedTitle = await page.locator('.hero-copy h2').innerText()
  results.push({ page: 'health', title: checkedTitle })

  await navigate('木马查杀')
  await shot('04-virus')
  await shotLower('04-virus')
  results.push({ page: 'virus', title: await page.locator('.page-title').innerText() })

  await navigate('垃圾清理')
  await page.waitForSelector('.junk-category, .junk-page .empty-state', { timeout: 35000 })
  await shot('05-junk')
  await shotLower('05-junk')
  results.push({ page: 'junk', title: await page.locator('.page-title').innerText() })

  await navigate('软件管家')
  await page.waitForSelector('.software-row, .software-page .empty-state', { timeout: 35000 })
  await page.waitForTimeout(500)
  await shot('06-software')
  await shotLower('06-software')
  results.push({ page: 'software', title: await page.locator('.page-title').innerText() })

  const search = page.locator('.software-search input')
  await search.fill('Microsoft')
  await page.waitForTimeout(400)
  const filteredCount = await page.locator('.software-row').count()
  log(`[check] software search "Microsoft" -> ${filteredCount} rows`)
  await search.fill('')
  await page.waitForTimeout(300)

  await page.getByRole('tab', { name: '最近安装' }).click()
  await page.waitForTimeout(350)
  const recentRows = await page.locator('.software-row').count()
  log(`[check] software recent tab -> ${recentRows} rows`)
  await page.getByRole('tab', { name: '全部软件' }).click()
  await page.waitForTimeout(300)

  const refreshButton = page.getByRole('button', { name: /^刷新$|刷新中|刷新列表/ }).first()
  if (await refreshButton.count()) {
    await refreshButton.click()
    await page.waitForSelector('.toast', { timeout: 15000 })
    await page.waitForTimeout(250)
    await shot('06b-software-toast')
    const toastBox = await page.locator('.toast').first().boundingBox()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    if (toastBox) {
      const lowerHalf = toastBox.y > viewport.height / 2
      const rightSide = toastBox.x > viewport.width / 2
      log(`[check] toast anchored bottom-right: ${lowerHalf && rightSide}`)
    }
    await page.locator('.toast-close').first().click()
    await page.waitForSelector('.toast', { state: 'detached', timeout: 5000 })
  }

  const uninstallButton = page.locator('.software-uninstall-btn:not([disabled])').first()
  if (await uninstallButton.count()) {
    await uninstallButton.click()
    await page.waitForSelector('.modal-panel', { timeout: 5000 })
    await page.waitForTimeout(350)
    await shot('07-software-uninstall-confirm')
    await page.locator('.modal-foot .btn-secondary').click()
    await page.waitForSelector('.modal-panel', { state: 'detached', timeout: 5000 })
    log('[check] uninstall confirmation opened and cancelled without action')
  }

  await navigate('驱动管理')
  await page.waitForSelector('.driver-row, .driver-page .empty-state', { timeout: 70000 })
  await page.waitForTimeout(500)
  await shot('08b-drivers')
  await shotLower('08b-drivers')
  results.push({ page: 'drivers', title: await page.locator('.page-title').innerText() })

  const driverRows = await page.locator('.driver-row').count()
  const driverNavVisible = await page.locator('.nav-item').filter({ hasText: '驱动管理' }).first().isVisible()
  const driverOverflow = await page.locator('.driver-shell').evaluate((element) => element.scrollWidth - element.clientWidth)
  log(`[check] driver devices -> ${driverRows} rows, nav visible: ${driverNavVisible}, overflow: ${driverOverflow}px`)
  if (driverOverflow > 1) errors.push(`driver shell horizontal overflow: ${driverOverflow}px`)

  await page.getByRole('tab', { name: /需要关注/ }).click()
  await page.waitForTimeout(350)
  const attentionRows = await page.locator('.driver-row').count()
  log(`[check] driver attention tab -> ${attentionRows} rows`)
  await page.getByRole('tab', { name: /全部设备/ }).click()
  await page.waitForTimeout(300)

  const driverSearch = page.locator('.driver-search input')
  await driverSearch.fill('Intel')
  await page.waitForTimeout(400)
  const driverFiltered = await page.locator('.driver-row').count()
  log(`[check] driver search "Intel" -> ${driverFiltered} rows`)
  await driverSearch.fill('')
  await page.waitForTimeout(300)

  if (driverRows > 0) {
    await page.locator('.driver-detail-btn').first().click()
    await page.waitForSelector('.modal-panel', { timeout: 5000 })
    await page.waitForTimeout(350)
    await shot('08c-driver-detail')
    await page.locator('.modal-foot .btn-secondary').click()
    await page.waitForSelector('.modal-panel', { state: 'detached', timeout: 5000 })
    log('[check] driver detail modal opened and closed')
  }

  if (process.env.E2E_DRIVER_UPDATES === '1') {
    await page.getByRole('button', { name: /检查更新|重新检查/ }).first().click()
    await page.waitForSelector('.driver-update-row, .driver-updates-empty, .driver-update-error', { timeout: 180000 })
    await page.waitForTimeout(400)
    await shot('08d-driver-updates')
    log('[check] driver online update check completed (no install triggered)')

    const installButton = page.getByRole('button', { name: '安装所选驱动' }).first()
    if ((await installButton.count()) && (await installButton.isEnabled())) {
      await installButton.click()
      await page.waitForSelector('.modal-panel', { timeout: 5000 })
      await page.waitForTimeout(300)
      await shot('08e-driver-install-confirm')
      await page.locator('.modal-foot .btn-secondary').click()
      await page.waitForSelector('.modal-panel', { state: 'detached', timeout: 5000 })
      log('[check] driver install confirmation opened and cancelled without action')
    }
  }

  await navigate('加速中心')
  await page.waitForSelector('.speed-tabs', { timeout: 25000 })
  await page.waitForTimeout(1200)
  await shot('08-speed-overview')
  await shotLower('08-speed-overview')
  results.push({ page: 'speed', title: await page.locator('.page-title').innerText() })

  await page.locator('.speed-tab').filter({ hasText: '启动项管理' }).click()
  await page.waitForSelector('.startup-row, .startup-page .empty-state', { timeout: 25000 })
  await page.waitForTimeout(400)
  await shot('08-startup')
  await shotLower('08-startup')

  await page.locator('.filter-tab').filter({ hasText: '高影响' }).click()
  await page.waitForTimeout(300)
  const highImpactRows = await page.locator('.startup-row').count()
  log(`[check] startup high-impact filter -> ${highImpactRows} rows`)
  await page.locator('.filter-tab').filter({ hasText: '全部' }).click()

  await navigate('设置中心')
  await page.waitForSelector('.quarantine-card .empty-state, .quarantine-row', { timeout: 20000 })
  await page.waitForTimeout(400)
  await shot('09-settings')
  await shotLower('09-settings')
  results.push({ page: 'settings', title: await page.locator('.page-title').innerText() })

  await page.locator('.page-scroll').evaluate((element) => element.scrollTo(0, element.scrollHeight))
  await page.waitForTimeout(300)
  await shot('10-settings-bottom')

  await navigate('首页体检')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1080, 700)
  })
  await page.waitForTimeout(800)
  await shot('11-home-1080x700')
  await shotLower('11-home-1080x700')
  log('[check] resized window to 1080x700')

  await navigate('软件管家')
  await page.waitForSelector('.software-row', { timeout: 20000 })
  await page.waitForTimeout(1500)
  await shot('12-software-1080x700')
  await shotLower('12-software-1080x700')
  log('[check] software manager captured at 1080x700')

  await page.locator('.software-disk-link').click()
  await page.waitForSelector('.junk-page', { timeout: 15000 })
  log('[check] software disk link opens junk page')

  await navigate('驱动管理')
  await page.waitForSelector('.driver-row', { timeout: 30000 })
  await page.waitForTimeout(500)
  await shot('13-drivers-1080x700')
  await shotLower('13-drivers-1080x700')
  const compactOverflow = await page.locator('.driver-shell').evaluate((element) => element.scrollWidth - element.clientWidth)
  const compactNavVisible = await page.locator('.nav-item').filter({ hasText: '驱动管理' }).first().isVisible()
  log(`[check] drivers at 1080x700 -> overflow: ${compactOverflow}px, nav visible: ${compactNavVisible}`)
  if (compactOverflow > 1) errors.push(`driver shell overflow at 1080x700: ${compactOverflow}px`)

  console.log('\nRESULTS')
  console.log(JSON.stringify({ results, errors }, null, 2))

  await electronApp.close()

  if (errors.length > 0) {
    process.exitCode = 1
  }
}

main().catch(async (error) => {
  console.error('E2E FAILED:', error)
  if (appRef) await appRef.close().catch(() => undefined)
  process.exitCode = 1
})
