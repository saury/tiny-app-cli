# 🚀 tiny-app-cli
自动提审、发布与自检微信、支付宝小程序，更好的实现小程序的CI/CD

## 安装
With NPM:
```bash
npm install -g @saury/tiny-app-cli
```

With PNPM:
```bash
pnpm install -g @saury/tiny-app-cli
```

With Yarn:
```bash
yarn add -g @saury/tiny-app-cli
```

## 如何使用？
```bash
tiny-app-cli
```
然后按照提示去做!

## 命令行参数
```console
$ tiny-app-cli -h
Usage: tiny-app-cli [options]

自动提审、发布与自检微信、支付宝小程序, 更好的实现小程序的CI/CD

Options:
  -V, --version               output the version number
  -p, --platform <platform>   操作的平台 (choices: "weixin", "alipay")
  -a, --action <action>       提审、发布或自检 (choices: "review", "release", "inspect")
  -f, --force-submit          如果存在【审核中】或【审核通过】的版本，这将强制提交新的审核版本 (choices: "true", "false")
  -hl, --headless [headless]  浏览器无头模式 (choices: "false", "new", default: "new")
  -h, --help                  display help for command
```

示例
```bash
# 微信小程序提审
tiny-app-cli -p weixin -a review

# 微信小程序发布
tiny-app-cli -p weixin -a release

# 微信小程序自检（检查审核版本状态）
tiny-app-cli -p weixin -a inspect
```

## 功能说明

### 🔍 自检模式
自检模式可以检查并列出选中账户的审核版本信息，包括：
- **版本号**：当前审核版本的版本号
- **审核状态**：
  - 审核中
  - 审核通过待发布
  - 审核不通过
  - 无审核版本

#### 自检结果示例
```
🔍 自检结果 (2个):
  • 账户名称1
    版本号: 1.0.5
    状态: 审核通过待发布

  • 账户名称2
    版本号: 1.0.3
    状态: 审核中
```

### 📋 支持的操作
- **提审 (review)**：自动提交小程序审核
- **发布 (release)**：发布已通过审核的小程序版本
- **自检 (inspect)**：检查当前审核版本的状态和版本号

## 注意事项
- 由于当前功能不完善，在微信小程序提审的过程中，请确保你已经提审过一次小程序

## 更多功能正在设计中...

## 其他
如果有任何问题，欢迎提 [issue](https://github.com/saury/tiny-app-cli/issues) 或者 [PR](https://github.com/saury/tiny-app-cli/pulls)!
