import process from 'node:process'
import { blue, green, red, yellow } from 'kolorist'
import type { Browser, Page } from 'puppeteer'
import puppeteer from 'puppeteer'
import type { Ora } from 'ora'
import ora from 'ora'
import prompts from 'prompts'
import { ACTION, VIEWPORT, WEIXIN_URL, __DEV__ } from '../constants'
import { onCancel, pathResolve, showQrCodeToTerminal, sleep } from '../utils'

let browser: Browser
let page: Page

let spinner: Ora
let options: InputOptions

/**
 * 通用重试机制
 */
async function retryOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = 3,
  delayMs = 2000,
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        spinner.info(`重试第 ${attempt - 1} 次: ${operationName}`)
        await sleep(delayMs)
      }
      return await operation()
    }
    catch (error) {
      lastError = error as Error
      const errorMessage = (error as { message: string })?.message || '未知错误'

      if (attempt === maxRetries) {
        spinner.fail(`${operationName} 失败 (已重试 ${maxRetries} 次): ${errorMessage}`)
        break
      }

      spinner.warn(`${operationName} 失败 (尝试 ${attempt}/${maxRetries}): ${errorMessage}`)
    }
  }

  throw lastError || new Error(`${operationName} 失败`)
}

/**
 * 检查页面是否有效
 */
function isPageValid(): boolean {
  try {
    return page && !page.isClosed()
  }
  catch {
    return false
  }
}

/**
 * 安全地导航到指定 URL
 */
async function safeGoto(url: string, description = '页面导航'): Promise<void> {
  try {
    // 首先尝试使用 domcontentloaded，更快
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  }
  catch (error) {
    const errorMessage = (error as { message: string })?.message || ''
    if (errorMessage.includes('timeout')) {
      // 如果超时，尝试使用更宽松的策略
      spinner.warn(`${description}超时，尝试继续...`)
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 })
      }
      catch {
        // 最后一招：不等待任何事件
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 })
      }
    }
    else {
      throw error
    }
  }
  // 给页面一些时间渲染
  await sleep(2000)
}

/**
 * 获取当前页面的token，支持多种场景
 */
async function getToken(): Promise<string> {
  // 验证页面状态
  if (!isPageValid())
    throw new Error('页面已关闭或无效')

  const currentUrl = page.url()

  // 场景1: URL中有token参数
  const urlToken = new URL(currentUrl).searchParams.get('token')
  if (urlToken)
    return urlToken

  // 场景2: 从页面元素中获取token（登录后的首页）
  try {
    const tokenFromPage = await page.evaluate(() => {
      // 尝试从页面的链接中提取token
      const links = document.querySelectorAll('a[href*="token="]')
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href
        const match = href.match(/token=([^&]+)/)
        if (match?.[1])
          return match[1]
      }
      return null
    })

    if (tokenFromPage)
      return tokenFromPage
  }
  catch (error) {
    // 继续尝试其他方法
  }

  // 场景3: 等待页面跳转到带token的页面
  spinner.info('等待页面跳转...')
  await sleep(3000)

  const newUrl = page.url()
  const newToken = new URL(newUrl).searchParams.get('token')
  if (newToken)
    return newToken

  // 场景4: 尝试从cookie或localStorage获取
  try {
    const tokenFromStorage = await page.evaluate((): string | null => {
      // 尝试从localStorage获取
      const localToken = localStorage.getItem('token')
      if (localToken)
        return localToken

      // 尝试从全局变量获取
      const win = window as Window & { token?: string }
      return win.token || null
    })

    if (tokenFromStorage)
      return tokenFromStorage
  }
  catch (error) {
    // 继续
  }

  throw new Error('无法获取token，请检查登录状态')
}

/**
 * 获取微信图片二维码
 */
export async function getLoginScanCode(opts: InputOptions = options) {
  spinner = ora('正在获取登录二维码...').start()
  browser = await puppeteer.launch({ headless: __DEV__ ? false : opts.headless })
  page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  await page.goto(WEIXIN_URL)
  const imgSelector = '.login_frame.input_login'
  const loginCode = await page.waitForSelector(imgSelector)
  // await page.evaluate(() => {
  //   return new Promise<void>((resolve, reject) => {
  //     const el = document.querySelector<HTMLImageElement>('.login__type__container__scan__qrcode')
  //     if (el) {
  //       el.onload = () => resolve()
  //       el.onerror = reject
  //     }
  //     else {
  //       reject(new Error('登录失败'))
  //     }
  //   })
  // })
  const loginCodeImagePath = pathResolve('../cache/login-qr.png')
  const getScanCode = async (): Promise<string> => {
    await loginCode?.screenshot({ path: loginCodeImagePath, type: 'png' })
    try {
      return await showQrCodeToTerminal(loginCodeImagePath)
    }
    catch (e) {
      await sleep()
      return getScanCode()
    }
  }
  const scanCode = await getScanCode()
  spinner.succeed(yellow('请使用微信扫描二维码登录微信公众平台'))
  console.log(scanCode)
  await page.waitForSelector('.weui-desktop-icon.weui-desktop-icon__success.weui-desktop-icon__large', { timeout: 0 })
  spinner.succeed('扫码成功')

  // 等待页面跳转到管理后台
  spinner.start('正在进入管理后台...')
  await sleep(5000) // 等待页面完全加载

  // 确保页面已经跳转到管理后台
  const currentUrl = page.url()
  if (!currentUrl.includes('mp.weixin.qq.com')) {
    spinner.info('等待页面跳转...')
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      // 忽略超时错误
    })
    await sleep(3000)
  }

  spinner.succeed('进入管理后台成功')
}

/**
 * 获取所有可用账号列表
 */
export async function getAllAvailableAccounts(): Promise<AccountInfo[]> {
  try {
    spinner.start('正在获取账号列表...')

    // 验证页面状态
    if (!isPageValid())
      throw new Error('页面已关闭或无效')

    // 等待页面加载完成
    await sleep(2000)

    // 检查是否存在切换账号按钮
    const switchAccountBtn = await page.$('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item')

    if (!switchAccountBtn) {
      // 尝试其他可能的选择器
      const altSwitchBtn = await page.$('.menu_box_account_info_item')
      if (!altSwitchBtn) {
        // 没有切换账号按钮，说明只有当前一个账号
        const currentAccountName = await page.evaluate(() => {
          const accountElement = document.querySelector('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item')
          return accountElement?.textContent?.trim() || '当前账号'
        })

        spinner.succeed('获取账号列表完成')
        return [{
          name: currentAccountName,
          email: '',
          index: 0,
          display: currentAccountName,
        }]
      }
    }

    // 获取当前账号信息
    const currentAccountName = await page.evaluate(() => {
      const accountElement = document.querySelector('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item')
      return accountElement?.textContent?.trim() || '当前账号'
    })

    // 点击切换账号按钮
    let clickSuccess = await page.evaluate(() => {
      const btn = document.querySelector('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item') as HTMLElement
      if (btn) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setTimeout(() => btn.click(), 300)
        return true
      }
      return false
    })

    // 如果主选择器失败，尝试备用选择器
    if (!clickSuccess) {
      clickSuccess = await page.evaluate(() => {
        const btn = document.querySelector('.menu_box_account_info_item') as HTMLElement
        if (btn) {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setTimeout(() => btn.click(), 300)
          return true
        }
        return false
      })
    }

    if (!clickSuccess)
      throw new Error('无法点击切换账号按钮')

    await sleep(1500)

    // 等待账号列表弹窗出现
    const accountList = await page.waitForSelector('#app > div.switch_account_dialog > div > div.account_list', { timeout: 10000 })
    if (!accountList)
      throw new Error('未找到账号列表')

    // 获取所有可切换的账号
    const accounts = await page.evaluate(() => {
      const accountItems = document.querySelectorAll('#app > div.switch_account_dialog > div > div.account_list > div.account_item')
      return Array.from(accountItems).map((item, index) => {
        const nameElement = item.querySelector('.account_name')
        const emailElement = item.querySelector('.account_email')
        const name = nameElement?.textContent?.trim() || `账号${index + 1}`
        const email = emailElement?.textContent?.trim() || ''
        return {
          name,
          email,
          index,
          display: email ? `${name} (${email})` : name,
        }
      })
    }, currentAccountName)

    // 关闭账号选择弹窗（点击取消或空白区域）
    await page.evaluate(() => {
      const cancelBtn = document.querySelector('#app > div.switch_account_dialog .weui-desktop-btn_default')
      if (cancelBtn) {
        (cancelBtn as HTMLElement).click()
      }
      else {
        // 如果没有取消按钮，点击遮罩层关闭
        const overlay = document.querySelector('#app > div.switch_account_dialog')
        if (overlay)
          (overlay as HTMLElement).click()
      }
    })

    // 等待弹窗关闭
    await page.waitForSelector('#app > div.switch_account_dialog', { hidden: true, timeout: 5000 }).catch(() => {
      // 如果等待失败，尝试按ESC键关闭
      return page.keyboard.press('Escape')
    })

    spinner.succeed('获取账号列表完成')
    return accounts
  }
  catch (error) {
    const errorMessage = (error as { message: string })?.message || '未知错误'
    spinner.fail(`获取账号列表失败: ${errorMessage}`)

    // 尝试记录更多调试信息
    if (__DEV__) {
      console.error('详细错误信息:', error)
      console.error('当前页面URL:', isPageValid() ? page.url() : '页面已关闭')
    }

    throw error
  }
}

/**
 * 切换到指定账号
 */
export async function switchToAccount(account: AccountInfo): Promise<boolean> {
  return retryOperation(async () => {
    spinner.start('正在切换账号...')

    // 验证页面状态
    if (!isPageValid())
      throw new Error('页面已关闭或无效')

    // 点击切换账号按钮
    let clickSuccess = await page.evaluate(() => {
      const btn = document.querySelector('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item') as HTMLElement
      if (btn) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setTimeout(() => btn.click(), 300)
        return true
      }
      return false
    })

    // 如果主选择器失败，尝试备用选择器
    if (!clickSuccess) {
      clickSuccess = await page.evaluate(() => {
        const btn = document.querySelector('.menu_box_account_info_item') as HTMLElement
        if (btn) {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setTimeout(() => btn.click(), 300)
          return true
        }
        return false
      })
    }

    if (!clickSuccess)
      throw new Error('无法点击切换账号按钮')

    await sleep(1500)

    // 等待账号列表弹窗出现
    const accountList = await page.waitForSelector('#app > div.switch_account_dialog > div > div.account_list', { timeout: 10000 })
    if (!accountList)
      throw new Error('未找到账号列表')

    await sleep(1000)

    // 点击选中的账号
    await page.evaluate((index: number) => {
      const accountItems = document.querySelectorAll('#app > div.switch_account_dialog > div > div.account_list > div.account_item')
      const selectedItem = accountItems[index] as HTMLElement
      if (selectedItem) {
        selectedItem.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setTimeout(() => {
          selectedItem.click()
        }, 300)
      }
    }, account.index)

    // 等待账号切换弹窗消失
    try {
      await page.waitForSelector('#app > div.switch_account_dialog', { hidden: true, timeout: 15000 })
    }
    catch (error) {
      await page.waitForFunction(() => {
        const dialog = document.querySelector('#app > div.switch_account_dialog')
        const loadingElements = document.querySelectorAll('.loading')
        const hasVisibleLoading = Array.from(loadingElements).some(el =>
          (el as HTMLElement).style.display !== 'none' && (el as HTMLElement).offsetParent !== null,
        )
        return !dialog || !hasVisibleLoading
      }, { timeout: 30000 })
    }

    await sleep(3000)

    // 获取切换后的账号名称
    const newAccountName = account.display

    spinner.succeed(`账号切换成功: ${green(newAccountName)}`)
    return true
  }, `切换到账号 ${account.display}`, 2, 3000).catch((error) => {
    spinner.fail(`切换账号失败: ${(error as { message: string })?.message}`)
    return false
  })
}

/**
 * 跳转到版本列表
 */
export async function jumpToVersions() {
  try {
    spinner.start('正在跳转到版本管理页面...')

    // 验证页面是否仍然打开
    if (page.isClosed())
      throw new Error('页面已关闭，无法跳转到版本管理')

    // 使用智能token获取函数
    const token = await getToken()

    // 使用安全导航函数跳转到版本管理页面
    const targetUrl = `https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=${token}&lang=zh_CN`
    await safeGoto(targetUrl, '跳转到版本管理页面')

    // 验证页面是否成功跳转
    if (!page.url().includes('wacodepage'))
      throw new Error('页面跳转失败')

    spinner.succeed('跳转到版本管理页面成功')
  }
  catch (error) {
    const errorMessage = (error as { message: string })?.message || '未知错误'
    spinner.fail(`跳转到版本管理页面失败: ${errorMessage}`)
    throw error
  }
}

async function getSubmitReviewButton() {
  const submitReviewBtnSelector = '.mod_default_box.code_version_dev .code_version_log .weui-desktop-btn.weui-desktop-btn_primary'
  let submitReviewBtn = await page.waitForSelector(submitReviewBtnSelector)
  const codeVersions = await page.$$('.mod_default_box.code_version_dev .code_version_log')
  // 优先选择体验版进行提交审核
  if (codeVersions.length > 0) {
    for await (const item of codeVersions) {
      const hasExpVersionTag = await item.evaluate(el => el.querySelector('.js_show_exp_version') !== null)
      if (hasExpVersionTag) {
        submitReviewBtn = await item.$('.weui-desktop-btn.weui-desktop-btn_primary')

        // 如果找到体验版，重新获取该版本的详细信息
        const expVersionInfo = await item.evaluate((el) => {
          const versionElements = el.querySelectorAll('.simple_preview_item')
          let versionNumber = ''

          for (const element of versionElements) {
            const label = element.querySelector('.simple_preview_label')
            if (label && label.textContent?.includes('版本号')) {
              const valueElement = element.querySelector('.simple_preview_value')
              if (valueElement) {
                const textContent = valueElement.textContent || ''
                versionNumber = textContent.trim().split('\n')[0].trim()
              }
              break
            }
          }

          return versionNumber
        })

        if (expVersionInfo)
          spinner.info(`选择体验版进行提审: ${green(expVersionInfo)} (${blue('体验版')})`)
      }
    }
  }

  return submitReviewBtn
}

/**
 * 跳转确认提交审核界面
 */
export async function jumpToConfirmPage() {
  let submitReviewBtn = await getSubmitReviewButton()
  if (!submitReviewBtn) {
    spinner.fail('未找到提交审核按钮')
    throw new Error('未找到提交审核按钮')
  }
  const isSubmitReviewBtnDisabled = await submitReviewBtn.evaluate(btn => btn.classList.contains('weui-desktop-btn_disabled'))
  // 判断是否有提交审核中的版本
  const testVersion = await page.$('.mod_default_bd.default_box.test_version')
  if (testVersion && !await testVersion.evaluate(el => el.textContent?.includes('你暂无提交审核的版本或者版本已发布上线'))) {
    if (!options.forceSubmit) {
      spinner.stop()
      const result: prompts.Answers<'forceSubmit'> = await prompts([
        {
          type: 'confirm',
          name: 'forceSubmit',
          message: '当前已存在版本，是否继续强制提交审核？',
          initial: false,
        },
      ], {
        onCancel,
      })
      if (!result.forceSubmit) {
        spinner.info('用户取消提审操作')
        throw new Error('用户取消提审')
      }
      else {
        spinner.start()
      }
    }
  }
  if (isSubmitReviewBtnDisabled) {
    // 撤回
    await page.evaluate(() => {
      const el: HTMLButtonElement | null = document.querySelector('.mod_default_bd.default_box.test_version .weui-desktop-dropdown__list-ele__text')
      el!.click()
    })
    await sleep()
    const confirm = await page.$('body > div:nth-child(9) > div.weui-desktop-dialog__wrp.self-weui-modal > div > div.weui-desktop-dialog__ft > div > div:nth-child(2) > button')
    await confirm?.click()
    await sleep(2000)
    submitReviewBtn = await getSubmitReviewButton()
  }
  await submitReviewBtn!.click()
  spinner.start('正在提交审核中...')
  const agreeCheckbox = await page.waitForSelector('.weui-desktop-icon-checkbox', { visible: true })
  const nextStepBtn = await page.waitForSelector('.code_submit_dialog .weui-desktop-btn.weui-desktop-btn_primary', { visible: true })
  if (!agreeCheckbox || !nextStepBtn)
    throw new Error('未找阅读并了解平台审核规则')
  await agreeCheckbox.click()
  await nextStepBtn.click()

  // 代码审核进行安全测试提醒, 操作继续提交
  await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('.weui-desktop-dialog')].reverse()
    for (const dialog of dialogs) {
      if (dialog.querySelector('h4')?.textContent === '代码审核进行安全测试提醒') {
        dialog.querySelector<HTMLButtonElement>('.weui-desktop-btn_primary')?.click()
        break
      }
    }
  })

  // 关闭当前页面
  await sleep(2000)
  await page.close()
  await sleep(2000)
  // 切换提交审核页面
  const pages = await browser.pages()
  let flag = false
  for (const item of pages) {
    if (item.url().includes('wxamp/wadevelopcode/get_class')) {
      page = item
      flag = true
      break
    }
  }
  void page.setViewport(VIEWPORT)
  if (!flag)
    throw new Error('获取提交审核页面失败')
}

/**
 * 去提交审核
 */
export async function toSubmitAudit() {
  const submitBtn = await page.waitForSelector('.btn_primary')
  await sleep(200)
  if (!submitBtn)
    throw new Error('获取提交审核失败')
  await submitBtn.click()
  await page.waitForSelector('.msg_icon_wrp .icon_msg.success')
  const msg = await page.evaluate(() => {
    return document.querySelector('.msg_content')?.innerHTML
  })
  if (msg?.includes('已提交审核'))
    spinner.succeed('提交审核成功')
  else
    throw new Error('提交审核失败')
}

/**
 * 检查审核版本状态
 */
export async function checkReviewStatus(): Promise<{ version: string, status: string } | null> {
  try {
    spinner.start('正在检查审核版本状态...')

    // 等待页面加载
    await sleep(5000)

    // 检查是否存在审核版本
    const reviewVersionElement = await page.$('#js_container_box > div.col_main > div > div:nth-child(4) > div.main_bd > span > div.code_mod.mod_default_box.code_version_test > div.mod_default_bd.default_box.test_version > div > div > div.code_version_log_hd > div > p.simple_preview_value')

    if (!reviewVersionElement) {
      spinner.info('当前没有审核版本')
      return null
    }

    // 获取版本号
    const version = await page.evaluate((el) => {
      return el?.textContent?.trim() || ''
    }, reviewVersionElement)

    // 获取状态
    const statusElement = await page.$('#js_container_box > div.col_main > div > div:nth-child(4) > div.main_bd > span > div.code_mod.mod_default_box.code_version_test > div.mod_default_bd.default_box.test_version > div > div > div.code_version_log_hd > div > p:nth-child(3) > span.status_tag')

    let status = '未知状态'
    if (statusElement) {
      status = await page.evaluate((el) => {
        return el?.textContent?.trim() || '未知状态'
      }, statusElement)
    }

    spinner.succeed(`审核版本检查完成`)
    return { version, status }
  }
  catch (error) {
    spinner.fail(`检查审核版本状态失败: ${(error as { message: string })?.message}`)
    return null
  }
}

/**
 * 去发布
 */
export async function toRelease() {
  const statusEle = await page.waitForSelector('#js_container_box > div.col_main > div > div:nth-child(4) > div.main_bd > span > div.code_mod.mod_default_box.code_version_test > div.mod_default_bd.default_box.test_version > div > div > div.code_version_log_hd > div > p:nth-child(3) > span')
  // 检查审核状态
  const statusText = await page.evaluate((el) => {
    return el?.innerHTML
  }, statusEle)
  if (statusText !== '审核通过待发布') {
    spinner.fail(statusText)
    throw new Error(statusText)
  }
  const submitBtn = await page.waitForSelector('#js_container_box > div.col_main > div > div:nth-child(4) > div.main_bd > span > div.code_mod.mod_default_box.code_version_test > div.mod_default_bd.default_box.test_version > div > div > div.code_version_log_ft > div > div.weui-desktop-popover__wrp > span > div > button')
  // 点击提交审核
  await submitBtn?.click()
  const submitConfirm = await page.waitForSelector('#js_container_box > div.col_main > div > div:nth-child(4) > div:nth-child(9) > div.weui-desktop-dialog__wrp.self-weui-modal > div > div.weui-desktop-dialog__ft > div > div:nth-child(1) > button')
  await submitConfirm?.click()

  const releaseCodeImagePath = pathResolve('../cache/release.png')
  const codeEle = await page.waitForSelector('#js_container_box > div.col_main > div > div:nth-child(4) > div.qrcheck_dialog_simple > div.weui-desktop-dialog__wrp.self-weui-modal > div > div.weui-desktop-dialog__bd > div > div > div > div.weui-desktop-qrcheck__qrcode-area > div > img')
  await page.evaluate((el) => {
    return new Promise((resolve, reject) => {
      if (el) {
        el.onload = resolve
        el.onerror = reject
      }
      else {
        reject(new Error('获取发布二维码失败'))
      }
    })
  }, codeEle)
  await codeEle?.screenshot({ path: releaseCodeImagePath, type: 'png' })
  spinner.clear()
  console.clear()
  spinner.succeed(yellow('请使用微信扫描二维码发布'))
  console.log(await showQrCodeToTerminal(releaseCodeImagePath))
  const result = await page.waitForSelector('#js_container_box > div.col_main > div > div:nth-child(4) > div.main_bd > span > div.code_mod.mod_default_box.code_version_test > div.mod_default_bd.default_box.test_version > div > div > p')
  if (result)
    spinner.succeed('发布成功')
}

/**
 * 对单个账号执行操作
 */
async function performOperationForAccount(account: AccountInfo, actionType: ACTION): Promise<boolean | { version: string, status: string } | null> {
  try {
    spinner.info(`开始处理账号: ${green(account.display)}`)

    // 验证页面状态
    if (!isPageValid())
      throw new Error('页面已关闭或无效，无法继续操作')

    await jumpToVersions()

    // 第一个为当前账户，无需切换
    if (account.index > 0) {
      const switchSuccess = await switchToAccount(account)
      if (!switchSuccess) {
        spinner.warn(`切换到账号 ${account.display} 失败，跳过该账号`)
        return false
      }
      await jumpToVersions()
    }

    if (actionType === ACTION.REVIEW) {
      await jumpToConfirmPage()
      await toSubmitAudit()
      spinner.succeed(`✅ 账号 ${green(account.display)} 提审操作完成`)

      // 跳转回版本管理页面，为下一个账号做准备
      await retryOperation(async () => {
        if (!isPageValid())
          throw new Error('页面已关闭')

        const token = await getToken()
        await safeGoto(`https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=${token}&lang=zh_CN`, '返回版本管理页面')
      }, '返回版本管理页面', 2, 2000)

      return true
    }
    else if (actionType === ACTION.RELEASE) {
      await toRelease()
      spinner.succeed(`✅ 账号 ${green(account.display)} 发布操作完成`)

      // 跳转回版本管理页面，为下一个账号做准备
      await retryOperation(async () => {
        if (!isPageValid())
          throw new Error('页面已关闭')

        const token = await getToken()
        await safeGoto(`https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=${token}&lang=zh_CN`, '返回版本管理页面')
      }, '返回版本管理页面', 2, 2000)

      return true
    }
    else if (actionType === ACTION.INSPECT) {
      const reviewStatus = await checkReviewStatus()
      spinner.succeed(`✅ 账号 ${green(account.display)} 自检操作完成`)

      // 跳转回版本管理页面，为下一个账号做准备
      await retryOperation(async () => {
        if (!isPageValid())
          throw new Error('页面已关闭')

        const token = await getToken()
        await safeGoto(`https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=${token}&lang=zh_CN`, '返回版本管理页面')
      }, '返回版本管理页面', 2, 2000)

      return reviewStatus
    }

    // 跳转回版本管理页面，为下一个账号做准备
    await retryOperation(async () => {
      if (!isPageValid())
        throw new Error('页面已关闭')

      const token = new URL(page.url()).searchParams.get('token')
      if (!token)
        throw new Error('无法获取token')

      await safeGoto(`https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=${token}&lang=zh_CN`, '返回版本管理页面')
    }, '返回版本管理页面', 2, 2000)

    return true
  }
  catch (error) {
    const errorMessage = (error as { message: string })?.message || '未知错误'

    if (errorMessage.includes('用户取消')) {
      spinner.warn(`账号 ${account.display} 操作被用户取消`)
      return false
    }

    spinner.fail(`账号 ${account.display} 操作失败: ${errorMessage}`)

    // 尝试记录更多调试信息
    if (__DEV__) {
      console.error('详细错误信息:', error)
      console.error('当前页面URL:', isPageValid() ? page.url() : '页面已关闭')
    }

    return false
  }
}

export default async function weixinRobot(opts: InputOptions) {
  options = opts
  try {
    // 1. 登录
    await getLoginScanCode()
    await jumpToVersions()

    // 2. 获取所有可用账号
    const allAccounts = await getAllAvailableAccounts()

    if (allAccounts.length === 0) {
      spinner.fail('未找到任何可用账号')
      process.exit(1)
    }

    // 3. 让用户选择要操作的账号（多选）
    spinner.stop()
    const actionText = options.action === ACTION.REVIEW ? '提审' : options.action === ACTION.RELEASE ? '发布' : '自检'
    const selectedAccounts: prompts.Answers<'accounts'> = await prompts([
      {
        type: 'multiselect',
        name: 'accounts',
        message: `请选择要进行${actionText}操作的账号 (使用空格键选择/取消选择，回车确认):`,
        choices: allAccounts.map(account => ({
          title: blue(account.display),
          description: account.email ? `邮箱: ${account.email}` : '',
          value: account.index,
        })),
        min: 1, // 至少选择一个账号
        hint: '- 使用方向键移动, 空格键选择/取消选择, 回车确认',
      },
    ], {
      onCancel,
    })

    if (!selectedAccounts.accounts || (selectedAccounts.accounts as number[]).length === 0) {
      spinner.info('未选择任何账号，程序退出')
      process.exit(0)
    }

    // 4. 获取选中的账号信息
    const selectedAccountInfos = allAccounts.filter(account =>
      (selectedAccounts.accounts as number[]).includes(account.index),
    )

    // 5. 确认操作
    const confirmResult: prompts.Answers<'confirm'> = await prompts([
      {
        type: 'confirm',
        name: 'confirm',
        message: `确认对以下 ${selectedAccountInfos.length} 个账号执行${actionText}操作吗？\n${selectedAccountInfos.map(acc => `  • ${acc.display}`).join('\n')}`,
        initial: true,
      },
    ], {
      onCancel,
    })

    if (!confirmResult.confirm) {
      spinner.info('操作已取消，程序退出')
      process.exit(0)
    }

    // 6. 按顺序执行操作
    spinner.info(`开始批量${actionText}操作，共 ${selectedAccountInfos.length} 个账号`)

    const results = {
      success: [] as AccountInfo[],
      failed: [] as AccountInfo[],
      skipped: [] as AccountInfo[],
      inspectResults: [] as Array<{ account: AccountInfo, version: string, status: string }>,
    }

    for (let i = 0; i < selectedAccountInfos.length; i++) {
      const account = selectedAccountInfos[i]
      spinner.info(`正在处理第 ${i + 1}/${selectedAccountInfos.length} 个账号...`)

      try {
        const result = await performOperationForAccount(account, options.action)

        if (options.action === ACTION.INSPECT) {
          // 自检模式的特殊处理
          if (result && typeof result === 'object' && 'version' in result) {
            results.inspectResults.push({
              account,
              version: result.version,
              status: result.status,
            })
            results.success.push(account)
          }
          else if (result === null) {
            // 没有审核版本，也算成功
            results.inspectResults.push({
              account,
              version: '无',
              status: '无审核版本',
            })
            results.success.push(account)
          }
          else {
            results.failed.push(account)
          }
        }
        else {
          // 提审和发布模式的处理
          if (result === true)
            results.success.push(account)
          else
            results.failed.push(account)
        }
      }
      catch (error) {
        const errorMessage = (error as { message: string })?.message || '未知错误'

        if (errorMessage.includes('用户取消')) {
          // 用户取消了当前账号的操作，询问是否继续处理其他账号
          spinner.stop()
          const continueResult: prompts.Answers<'continue'> = await prompts([
            {
              type: 'confirm',
              name: 'continue',
              message: `账号 ${account.display} 操作被取消，是否继续处理剩余的 ${selectedAccountInfos.length - i - 1} 个账号？`,
              initial: true,
            },
          ], {
            onCancel,
          })

          if (!continueResult.continue) {
            results.skipped.push(...selectedAccountInfos.slice(i))
            break
          }
          else {
            results.failed.push(account)
            continue
          }
        }
        else {
          spinner.fail(`账号 ${account.display} 处理失败: ${errorMessage}`)
          results.failed.push(account)

          // 如果还有剩余账号，询问是否继续
          if (i < selectedAccountInfos.length - 1) {
            spinner.stop()
            const continueResult: prompts.Answers<'continue'> = await prompts([
              {
                type: 'confirm',
                name: 'continue',
                message: `是否继续处理剩余的 ${selectedAccountInfos.length - i - 1} 个账号？`,
                initial: true,
              },
            ], {
              onCancel,
            })

            if (!continueResult.continue) {
              results.skipped.push(...selectedAccountInfos.slice(i + 1))
              break
            }
          }
        }
      }
    }

    // 7. 显示操作结果汇总
    spinner.stop()
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 批量${actionText}操作完成！`)
    console.log('='.repeat(50))

    if (options.action === ACTION.INSPECT && results.inspectResults.length > 0) {
      console.log(`\n🔍 自检结果 (${results.inspectResults.length}个):`)
      results.inspectResults.forEach((item) => {
        const statusColor = item.status === '审核通过待发布'
          ? green
          : item.status === '审核中'
            ? yellow
            : item.status === '审核不通过' ? red : blue
        console.log(`  • ${blue(item.account.display)}`)
        console.log(`    版本号: ${item.version}`)
        console.log(`    状态: ${statusColor(item.status)}`)
        console.log('')
      })
    }
    else {
      if (results.success.length > 0) {
        console.log(`\n✅ 成功 (${results.success.length}个):`)
        results.success.forEach((account) => {
          console.log(`  • ${green(account.display)}`)
        })
      }

      if (results.failed.length > 0) {
        console.log(`\n❌ 失败 (${results.failed.length}个):`)
        results.failed.forEach((account) => {
          console.log(`  • ${red(account.display)}`)
        })
      }

      if (results.skipped.length > 0) {
        console.log(`\n⏭️  跳过 (${results.skipped.length}个):`)
        results.skipped.forEach((account) => {
          console.log(`  • ${yellow(account.display)}`)
        })
      }
    }

    console.log(`\n${'='.repeat(50)}`)
    console.log('感谢使用！')

    process.exit(0)
  }
  catch (err) {
    if (__DEV__) {
      console.error(err)
      return
    }
    process.exit(1)
  }
}
