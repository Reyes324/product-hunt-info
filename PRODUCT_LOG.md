# PH 热门榜单阅读器 · 产品日志

## 项目背景

面向关注海外产品动态的中文用户，把 Product Hunt 的日/周/月榜单和首页"今日上线"抓下来，
配上中文名和中文简介，做成一个能随时刷的静态阅读页。起点是纯个人需求：不想每天手动翻墙看
英文原版榜单。

## 进度时间线

**2026-06-30 — 本地原型**
- `fetch_ph.mjs` 跑通：用 `r.jina.ai` 绕过 Product Hunt 的 Cloudflare 保护抓取榜单，
  DeepSeek API 生成中文名 + 中文简介，产出自包含静态 `index.html`。
- 只能在本地手动跑：`DEEPSEEK_API_KEY=xxx node fetch_ph.mjs`，生成完自己打开文件看。

**2026-07-13 — 本地一键生成**
- 加了 `server.mjs`：起一个本地 Node 服务，页面里直接有"重新生成"按钮，弹窗输入 key，
  避免每次都要开终端敲命令、key 也不用在对话里过一遍。

**2026-07-14 — 上线，全自动化**
- 仓库开源到 `Reyes324/product-hunt-info`（公开）。
- 部署到 Vercel：`product-hunt-info.vercel.app`，静态页面 + `api/trigger.mjs` 云函数。
- GitHub Actions 接管定时抓取：每天 UTC 8:00 自动跑一次，失败重试 3 次，全失败则不覆盖
  已有数据（保底不让页面变空白）。
- 页面"更新"按钮做成环境感知：本地访问走 `server.mjs`（本地 key 弹窗），线上访问改成调
  `api/trigger.mjs`，用只存在 Vercel 环境变量里的 fine-grained GitHub token 触发
  `workflow_dispatch`，浏览器和对话都不会经过任何密钥。
- 部署过程踩了两个坑（详细排查记录见 `CLAUDE.md`）：
  1. 根目录残留的 `server.mjs` + `package.json` 让 Vercel 零配置检测误判成"需要入口的
     Node 服务器"，导致 `api/` 下的云函数 404 —— 靠 `.vercelignore` 排除 + `vercel.json`
     显式 `"framework": null` 解决。
  2. GitHub fine-grained token 第一次生成时权限没保存上（页面反复提交但仓库范围/Actions
     权限没勾对），排查了两轮才发现 token 详情页显示"没有任何仓库权限"，重新在已登录会话
     里编辑一次才生效。
- 当天还发现翻译偶发失败：DeepSeek 单条调用失败或返回格式不对时，代码原本会静默回退成英文
  原文，用户毫无察觉（例如 "Osaurus" 那条）。修复：失败重试一次，最终仍失败则在日志里打印
  具体是哪个产品，方便下次排查而不是无声无息。

## 当前状态

- 线上地址：https://product-hunt-info.vercel.app
- 仓库：https://github.com/Reyes324/product-hunt-info
- 更新方式：每日定时自动 + 页面按钮手动触发，两者都会在约 1 分钟内跑完并自动重新部署
- 本地开发路径不受影响，仍可用 `server.mjs` 单独跑

## 待办 / 已知限制

- DeepSeek 翻译偶发失败目前只做了 1 次重试，极端情况下（连续失败）某条产品仍可能显示英文
  原文，需要留意 Actions 日志里的 `⚠️ 翻译失败` 记录
- `r.jina.ai` 免费额度 20 RPM，尚未观察到长期在 GitHub Actions 共享 IP 下被限流，但没有
  做长期监控，如果未来抓取大面积失败，优先怀疑这里
- 两个密钥（`DEEPSEEK_API_KEY` / `GH_DISPATCH_TOKEN`）都有过期时间，`GH_DISPATCH_TOKEN`
  设置的是 2027-07-01 到期，到期前需要重新生成并更新 Vercel 环境变量
