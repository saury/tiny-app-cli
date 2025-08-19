import process from 'node:process'
import { blue, green, yellow } from 'kolorist'
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
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const el = document.querySelector<HTMLImageElement>('.login__type__container__scan__qrcode')
      if (el) {
        el.onload = () => resolve()
        el.onerror = reject
      }
      else {
        reject(new Error('登录失败'))
      }
    })
  })
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
}

/**
 * 操作完成后检查并切换账号
 */
export async function checkAndSwitchAccountAfterOperation(): Promise<boolean> {
  try {
    // 等待页面加载完成
    await sleep(2000)

    // 检查是否存在切换账号按钮
    const switchAccountBtn = await page.$('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item')

    if (!switchAccountBtn) {
      // 尝试其他可能的选择器
      const altSwitchBtn = await page.$('.menu_box_account_info_item')
      if (!altSwitchBtn) {
        spinner.stop()
        // 没有切换账号按钮，直接询问是否继续
        const shouldContinue: prompts.Answers<'continue'> = await prompts([
          {
            type: 'confirm',
            name: 'continue',
            message: '是否继续对当前账号进行其他操作？',
            initial: false,
          },
        ], {
          onCancel,
        })
        return shouldContinue.continue as boolean
      }
    }

    // 获取当前账号信息
    const currentAccountName = await page.evaluate(() => {
      const accountElement = document.querySelector('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item')
      return accountElement?.textContent?.trim() || '当前账号'
    })

    spinner.stop()

    // 询问用户下一步操作
    const nextAction: prompts.Answers<'action'> = await prompts([
      {
        type: 'select',
        name: 'action',
        message: `当前账号: ${green(currentAccountName)}，请选择下一步操作:`,
        choices: [
          { title: '🔄 切换到其他账号继续操作', value: 'switch' },
          { title: '🔁 继续使用当前账号进行操作', value: 'continue' },
          { title: '🚪 退出程序', value: 'exit' },
        ],
        initial: 0,
      },
    ], {
      onCancel,
    })

    if (nextAction.action === 'exit')
      return false

    if (nextAction.action === 'continue')
      return true

    // 执行切换账号逻辑
    return await performAccountSwitch()
  }
  catch (error) {
    spinner.warn(`检查账号切换过程中出现问题: ${(error as { message: string })?.message}`)
    // 出错时询问是否继续
    const shouldContinue: prompts.Answers<'continue'> = await prompts([
      {
        type: 'confirm',
        name: 'continue',
        message: '是否继续使用当前账号？',
        initial: true,
      },
    ], {
      onCancel,
    })
    return shouldContinue.continue as boolean
  }
}

/**
 * 执行账号切换
 */
async function performAccountSwitch(): Promise<boolean> {
  try {
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
    if (!accountList) {
      spinner.warn('未找到账号列表')
      return false
    }

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
    })

    if (accounts.length === 0) {
      spinner.warn('未找到可切换的账号')
      return false
    }

    // 让用户选择要切换的账号
    const selectedAccount: prompts.Answers<'accountIndex'> = await prompts([
      {
        type: 'select',
        name: 'accountIndex',
        message: '请选择要切换的账号:',
        choices: accounts.map((account, index) => ({
          title: blue(account.display),
          description: account.email ? `邮箱: ${account.email}` : '',
          value: index,
        })),
        initial: 0,
      },
    ], {
      onCancel,
    })

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
    }, selectedAccount.accountIndex)

    spinner.start('正在切换账号...')

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
    const newAccountName = await page.evaluate(() => {
      const accountElement = document.querySelector('#js_container_box > div.col_side.open.transparent > div > div.menu_box_other > div.menu_box_other_item_wrapper.account_info > div > div.menu_box_account_info > div.menu_box_account_info_item')
      return accountElement?.textContent?.trim() || '新账号'
    })

    spinner.succeed(`账号切换成功: ${green(newAccountName)}`)
    return true
  }
  catch (error) {
    spinner.warn(`切换账号失败: ${(error as { message: string })?.message}`)
    return false
  }
}

/**
 * 跳转到版本列表
 */
export async function jumpToVersions() {
  spinner.start('正在跳转到版本管理页面...')
  const versionManage = await page.waitForSelector('.menu_item .tab-bar__wrap.tab-bar__wrap--submenu', { timeout: 0 })
  if (!versionManage) {
    spinner.fail('未找到版本管理')
    throw new Error('未找到版本管理')
  }
  spinner.start('正在跳转到版本管理页面...')
  const token = new URL(page.url()).searchParams.get('token')
  await page.goto(`https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=${token}&lang=zh_CN`)
}

async function getSubmitReviewButton() {
  const submitReviewBtnSelector = '.mod_default_box.code_version_dev .code_version_log .weui-desktop-btn.weui-desktop-btn_primary'
  let submitReviewBtn = await page.waitForSelector(submitReviewBtnSelector)
  const codeVersions = await page.$$('.mod_default_box.code_version_dev .code_version_log')
  // 优先选择体验版进行提交审核
  if (codeVersions.length > 1) {
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
  // 检查是否有两小时急速审核 TODO

  // 关闭当前页面
  await sleep(1000)
  await page.close()
  await sleep(1000)
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

export default async function weixinRobot(opts: InputOptions) {
  options = opts
  try {
    await getLoginScanCode()

    // 主操作循环，允许用户在完成操作后切换账号继续操作
    while (true) {
      try {
        await jumpToVersions()

        if (options.action === ACTION.REVIEW) {
          await jumpToConfirmPage()
          await toSubmitAudit()
          spinner.succeed('✅ 提审操作完成')
        }
        else {
          await toRelease()
          spinner.succeed('✅ 发布操作完成')
        }

        // 跳转到getcodepage
        const token = new URL(page.url()).searchParams.get('token')
        await page.goto(`https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=${token}&lang=zh_CN`)

        // 操作完成后询问是否切换账号继续操作
        const shouldContinue = await checkAndSwitchAccountAfterOperation()
        if (!shouldContinue) {
          spinner.info('程序结束，感谢使用！')
          break
        }
      }
      catch (error) {
        const errorMessage = (error as { message: string })?.message || '未知错误'

        // 如果是用户取消操作，询问是否切换账号或退出
        if (errorMessage.includes('用户取消')) {
          spinner.stop()
          const nextAction: prompts.Answers<'action'> = await prompts([
            {
              type: 'select',
              name: 'action',
              message: '操作已取消，请选择下一步:',
              choices: [
                { title: '🔄 切换到其他账号继续操作', value: 'switch' },
                { title: '🔁 继续使用当前账号进行操作', value: 'continue' },
                { title: '🚪 退出程序', value: 'exit' },
              ],
              initial: 1, // 默认选择继续当前账号
            },
          ], {
            onCancel,
          })

          if (nextAction.action === 'exit') {
            spinner.info('程序结束，感谢使用！')
            break
          }
          else if (nextAction.action === 'switch') {
            const switchSuccess = await performAccountSwitch()
            if (!switchSuccess) {
              // 切换失败，询问是否继续
              const shouldContinue: prompts.Answers<'continue'> = await prompts([
                {
                  type: 'confirm',
                  name: 'continue',
                  message: '切换账号失败，是否继续使用当前账号？',
                  initial: true,
                },
              ], {
                onCancel,
              })
              if (!shouldContinue.continue) {
                spinner.info('程序结束，感谢使用！')
                break
              }
            }
          }
          // 如果选择 continue 或切换成功，继续循环
          continue
        }
        else {
          // 其他错误，重新抛出
          throw error
        }
      }
    }

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
