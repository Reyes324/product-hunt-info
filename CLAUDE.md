# PH 热门榜单阅读器

将 Product Hunt 多维度榜单转化为中文可阅读的静态网页，面向关注海外产品动态的中文用户。

## 运行方式

```bash
DEEPSEEK_API_KEY=你的key node fetch_ph.mjs
# 生成 index.html，然后用浏览器打开
open index.html
# 或本地起服务：
python3 -m http.server 8877
```

## 环境要求

- Node.js 18+（使用原生 `fetch`）
- `DEEPSEEK_API_KEY`：用于翻译和摘要，不设则展示英文原文

## 架构

```
fetch_ph.mjs
  ├── fetchJina()           # 通过 r.jina.ai 绕过 Cloudflare 拉取 PH 页面
  ├── parseLeaderboard()    # 解析日/周/月榜 Markdown
  ├── parseHomepage()       # 解析首页（今日上线）
  ├── enrichProducts()      # 抓取 /products/{slug} 补充详情，5并发，200ms间隔
  ├── synthesize()          # DeepSeek API：一次调用输出中文名 + 中文简介
  ├── translateProducts()   # 批量翻译，5并发
  └── generateHTML()        # 生成自包含静态 HTML（数据内嵌 JSON）
```

## 数据来源

| Tab | PH 路径 |
|-----|---------|
| 昨日榜单 | `/leaderboard/daily/YYYY/M/D` |
| 今日上线 | `/`（首页） |
| 周榜单 | `/leaderboard/weekly/YYYY/W`（ISO 周，取上周） |
| 月度榜单 | `/leaderboard/monthly/YYYY/M`（取上月） |

## 关键设计决策

**Jina 而非 CDP**：Product Hunt 有 Cloudflare 保护，直接用浏览器自动化开新 tab 会触发验证。Jina（`r.jina.ai`）作为预处理层可绕过，但限 20 RPM，enrichProducts 分批请求以控制频率。

**描述只取前 80 行**：Jina 返回的 Markdown 中，产品描述在前半段，用户评论在第 300+ 行起。`parseProductDetail` 用 `.slice(0, 80)` 限定范围，否则会错误采到评论文本。

**产品详情页 vs 榜单页**：榜单页 tagline 只有一句，`/products/{slug}` 有 2-3 句覆盖用户/场景/解法的完整描述，是主要信息来源。

**DeepSeek 翻译 prompt 设计**：专有名词/品牌名保留英文（避免"克莱恩通行证"这类错误）；中文简介要求覆盖：目标用户是谁、解决了什么问题、如何解决的。

**enrichProducts 分两批串行**：先处理昨日+今日，再处理周榜+月榜，避免 4 个榜单同时并发触发 Jina 速率限制。

## 页面功能

- 4-tab 切换（昨日/今日/周/月），切换时头部徽章显示对应时间段
- 卡片：中文名（大）+ 英文原名（小）+ 完整中文简介（不截断）+ 分类标签 + 点赞数
- 点击卡片：右侧滑出侧边栏，含详情、PH 链接、内嵌 iframe 预览（失败时提示）
- favicon：橙红底白色"P"，内联 SVG，无需额外文件

## 线上部署架构

仓库：`Reyes324/product-hunt-info`（公开），静态站点部署在 Vercel。

```
GitHub Actions（每日 UTC 8:00 + workflow_dispatch 手动触发）
  └─ node fetch_ph.mjs（用 GitHub Secret: DEEPSEEK_API_KEY）
       └─ 失败重试 3 次，全失败则不覆盖 index.html，直接 exit 1
       └─ 成功则 commit + push index.html 回 main
            └─ Vercel 监听到 push，自动重新部署静态文件
```

页面里的"重新生成"按钮是环境感知的（`IS_LOCAL` 判断 hostname）：
- **本地**（`localhost`）：弹窗输入 `DEEPSEEK_API_KEY`，POST 到 `server.mjs` 的 `/run`，本地跑脚本，key 不外传
- **线上**：无需输入任何东西，POST 到 Vercel Serverless Function `api/trigger.js`，用只存在 Vercel 环境变量里的 `GH_DISPATCH_TOKEN`（fine-grained PAT，仅 Actions:write 权限）调用 GitHub API 触发 `workflow_dispatch`，token 不经过浏览器

**必须手动配置的两个密钥**（无法代为创建，需登录对应网站本人操作）：
| 密钥 | 存放位置 | 权限范围 |
|---|---|---|
| `DEEPSEEK_API_KEY` | GitHub 仓库 Settings → Secrets and variables → Actions | 无需限定，本来就是自己的 key |
| `GH_DISPATCH_TOKEN` | Vercel 项目 Settings → Environment Variables | Fine-grained PAT，仅限 `product-hunt-info` 仓库的 `Actions: write` |

**已知风险**：GitHub Actions runner 是 Azure 共享 IP，`r.jina.ai` 是否对云厂商 IP 段限流未验证，靠重试兜底；若长期失败需换抓取路径。
