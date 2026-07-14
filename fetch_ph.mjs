#!/usr/bin/env node
// 运行方式: node fetch_ph.mjs

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Fetch helpers ──────────────────────────────────────────────

async function fetchJina(path) {
  const res = await fetch(`https://r.jina.ai/producthunt.com${path}`, {
    headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' }
  });
  if (!res.ok) throw new Error(`Jina ${path} → ${res.status}`);
  return res.text();
}

async function synthesize(name, detail) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { zhName: name, zhDetail: detail };

  const prompt = `你是产品分析助手。以下是一款科技产品在 Product Hunt 上的介绍（英文）。

请完成两件事：
1. 产品中文名：品牌名/专有名词直接保留英文（如 ClinePass、Receiptor AI 保持原样）；普通词汇可自然翻译。只输出名称本身。
2. 产品中文简介（2-3句）：面向中文读者，语言自然流畅，涵盖目标用户是谁、解决了什么问题、如何解决的。

严格按以下格式输出，只输出这两行：
名称：xxx
简介：xxx

产品名：${name}
介绍：${detail}`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    const zhName = text.match(/名称：(.+)/)?.[1]?.trim() || name;
    const zhDetail = text.match(/简介：([\s\S]+)/)?.[1]?.trim() || detail;
    return { zhName, zhDetail };
  } catch {
    return { zhName: name, zhDetail: detail };
  }
}

async function translateProducts(products) {
  const BATCH = 5;
  const result = [...products];
  for (let i = 0; i < result.length; i += BATCH) {
    const batch = result.slice(i, i + BATCH);
    await Promise.all(batch.map(async (p, j) => {
      const { zhName, zhDetail } = await synthesize(p.name, p.detail || p.desc);
      result[i + j] = { ...p, zhName, zhDetail };
    }));
    if (i + BATCH < result.length) await new Promise(r => setTimeout(r, 200));
  }
  return result;
}

function parseProductDetail(markdown) {
  // 产品描述在页面前半段，评论区在后半段。只扫前 80 行避开评论污染。
  const lines = markdown.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 80);

  const isDesc = l =>
    l.length > 80 && l.length < 700 &&
    !l.startsWith('[') && !l.startsWith('!') && !l.startsWith('#') &&
    !l.startsWith('*') && !l.startsWith('•') &&
    !l.includes('producthunt.com') &&
    !/^(This is the|Launch|Visit|Free|Show|Login|Sign|Subscribe|Privacy|Overview|Launches|Reviews|Alternatives|Built with|More)/.test(l);

  // 优先取 "Visit" 按钮之后的 launch 描述（更具体）
  let afterVisit = false;
  for (const line of lines) {
    if (!afterVisit) {
      if (/\]Visit$/.test(line) || line === 'Visit' || line.endsWith(']Visit')) { afterVisit = true; }
      continue;
    }
    if (line.startsWith('!') || line.startsWith('[')) continue;
    if (/^(Interactive|Launch tags|Free Options|Show more|Promoted)/.test(line)) break;
    if (isDesc(line)) return line;
  }

  // 次选：页面顶部最长的干净段落（product overview）
  return lines.filter(isDesc).sort((a, b) => b.length - a.length)[0] || null;
}

async function enrichProducts(products) {
  const BATCH = 5;
  const result = [...products];
  for (let i = 0; i < result.length; i += BATCH) {
    const batch = result.slice(i, i + BATCH);
    await Promise.all(batch.map(async (p, j) => {
      try {
        const slug = new URL(p.url).pathname.replace('/products/', '');
        const md = await fetch(
          `https://r.jina.ai/www.producthunt.com/products/${slug}`,
          { headers: { 'Accept': 'text/plain' } }
        ).then(r => r.text());
        const detail = parseProductDetail(md);
        if (detail) result[i + j] = { ...p, detail };
      } catch { /* 拿不到就保留 tagline */ }
    }));
    if (i + BATCH < result.length) await new Promise(r => setTimeout(r, 200));
  }
  return result;
}

// ── Parsers ────────────────────────────────────────────────────

function buildIconMap(markdown) {
  const map = {};
  for (const line of markdown.split('\n')) {
    const m = line.match(/^!\[Image \d+: ([^\]]+)\]\((https:\/\/ph-files\.imgix\.net\/[^)]+)\)/);
    if (m) map[m[1].trim()] = m[2];
  }
  return map;
}

function parseTags(line) {
  return [...line.matchAll(/\[([^\]]+)\]\([^)]+\/topics\/[^)]+\)/g)].map(m => m[1]);
}

function parseLeaderboard(markdown) {
  const lines = markdown.split('\n').map(l => l.trim()).filter(Boolean);
  const iconMap = buildIconMap(markdown);
  const products = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[(\d+)\. ([^\]]+)\]\((https?:\/\/(?:www\.)?producthunt\.com\/products\/[^)]+)\)(.*)/);
    if (!m) continue;
    const name = m[2].trim();
    const url = m[3].replace('http://', 'https://');
    const desc = m[4].trim();
    if (!desc) continue;

    const tags = (i + 1 < lines.length && lines[i + 1].includes('/topics/'))
      ? parseTags(lines[i + 1]) : [];

    let upvotes = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^\d{2,}$/.test(lines[j])) { upvotes = parseInt(lines[j]); break; }
    }

    products.push({ rank: parseInt(m[1]), name, zhName: name, url, desc, zhDesc: desc, tags, upvotes, icon: iconMap[name] || null });
  }
  return products;
}

function parseHomepage(markdown) {
  const lines = markdown.split('\n').map(l => l.trim()).filter(Boolean);
  const iconMap = buildIconMap(markdown);
  const products = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[([^\]]+)\]\((https?:\/\/(?:www\.)?producthunt\.com\/products\/[^)]+)\)(.*)/);
    if (!m) continue;
    const name = m[1].trim();
    const url = m[2].replace('http://producthunt.com', 'https://www.producthunt.com');
    const desc = m[3].trim();
    if (!desc || seen.has(name)) continue;
    seen.add(name);

    const tags = (i + 1 < lines.length && lines[i + 1].includes('/topics/'))
      ? parseTags(lines[i + 1]) : [];

    let upvotes = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^\d{2,}$/.test(lines[j])) {
        const n = parseInt(lines[j]);
        if (!upvotes || n > upvotes) upvotes = n;
      }
    }

    products.push({ rank: products.length + 1, name, zhName: name, url, desc, zhDesc: desc, tags, upvotes, icon: iconMap[name] || null });
  }
  return products;
}

// ── HTML generator ─────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function getISOWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function getISOYear(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return date.getUTCFullYear();
}

const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23FF6154'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-family='system-ui,sans-serif' font-weight='800' font-size='19' fill='white'%3EP%3C/text%3E%3C/svg%3E`;

function generateHTML(data) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PH 热门</title>
<link rel="icon" href="${FAVICON}">
<style>
:root{
  --bg:#F5F2EC;
  --surface:#FFFFFF;
  --surface-2:#FAF9F7;
  --border:#E8E4DC;
  --accent:#FF6154;
  --accent-soft:rgba(255,97,84,0.08);
  --text:#1C1917;
  --text-2:#6B6560;
  --text-3:#B5AFA8;
  --tag-bg:#EDE9E3;
  --tag-text:#57534E;
  --shadow-sm:0 1px 3px rgba(0,0,0,0.06),0 1px 2px rgba(0,0,0,0.04);
  --shadow-md:0 4px 16px rgba(0,0,0,0.09),0 2px 6px rgba(0,0,0,0.05);
  --shadow-lg:0 12px 40px rgba(0,0,0,0.14),0 4px 12px rgba(0,0,0,0.06);
  --sidebar-w:460px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'PingFang SC','SF Pro Text','Helvetica Neue',sans-serif;font-size:14px;line-height:1.6}
a{color:inherit;text-decoration:none}

.app{display:flex;min-height:100vh;transition:padding-right .35s cubic-bezier(.4,0,.2,1)}
.app.panel-open{padding-right:var(--sidebar-w)}
.main{flex:1;max-width:740px;margin:0 auto;padding:0 28px 80px}

header{padding:36px 0 20px}
.header-row{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:11px}
.ph-mark{width:36px;height:36px;background:var(--accent);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;flex-shrink:0;box-shadow:0 2px 8px rgba(255,97,84,.35)}
h1{font-size:21px;font-weight:700;letter-spacing:-.4px;color:var(--text)}
.header-sub{display:flex;align-items:center;gap:10px;margin-top:8px}
.badge{font-size:11px;font-weight:600;background:var(--surface);border:1px solid var(--border);color:var(--text-2);padding:3px 10px;border-radius:20px;box-shadow:var(--shadow-sm)}
.updated{font-size:12px;color:var(--text-3)}
.refresh-btn{background:var(--surface);border:1px solid var(--border);color:var(--text-2);font-size:12px;padding:6px 13px;border-radius:8px;cursor:pointer;transition:.15s;display:flex;align-items:center;gap:6px;box-shadow:var(--shadow-sm)}
.refresh-btn:hover{border-color:var(--accent);color:var(--accent)}

/* Segmented tabs */
.tab-bar{display:flex;background:var(--surface);border-radius:11px;padding:4px;margin-bottom:20px;box-shadow:var(--shadow-sm);border:1px solid var(--border)}
.tab{flex:1;padding:8px 0;border-radius:8px;font-size:13px;font-weight:500;text-align:center;color:var(--text-3);cursor:pointer;transition:all .2s;user-select:none}
.tab.active{background:var(--accent);color:#fff;font-weight:600;box-shadow:0 1px 4px rgba(255,97,84,.4)}
.tab:hover:not(.active){color:var(--text-2);background:var(--surface-2)}

/* Cards */
.list{display:flex;flex-direction:column;gap:10px}
.card{background:var(--surface);border-radius:14px;padding:16px 18px;display:flex;align-items:flex-start;gap:14px;cursor:pointer;border:1px solid var(--border);box-shadow:var(--shadow-sm);transition:box-shadow .2s,transform .15s}
.card:hover{box-shadow:var(--shadow-md);transform:translateY(-1px)}
.rank{width:20px;font-size:12px;font-weight:800;color:var(--text-3);text-align:center;padding-top:3px;flex-shrink:0;font-variant-numeric:tabular-nums}
.rank.gold{color:#D97706}.rank.silver{color:#9CA3AF}.rank.bronze{color:#B45309}
.icon{width:46px;height:46px;border-radius:11px;background:var(--surface-2);border:1px solid var(--border);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:22px}
.icon img{width:100%;height:100%;object-fit:cover;display:block}
.body{flex:1;min-width:0}
.name-zh{font-size:15px;font-weight:650;letter-spacing:-.15px;margin-bottom:1px;color:var(--text)}
.name-en{font-size:11px;color:var(--text-3);margin-bottom:6px}
.desc{font-size:13px;color:var(--text-2);margin-bottom:9px;line-height:1.6}
.meta{display:flex;flex-wrap:wrap;gap:5px}
.tag{background:var(--tag-bg);color:var(--tag-text);font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;letter-spacing:.1px}
.right{display:flex;align-items:center;gap:8px;flex-shrink:0;padding-top:2px}
.votes{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:36px}
.vote-box{width:28px;height:28px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;color:var(--text-3);transition:.15s}
.card:hover .vote-box{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.vote-count{font-size:11px;font-weight:700;color:var(--text-2)}
.ext-btn{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--text-3);transition:.15s}
.ext-btn:hover{background:var(--surface-2);color:var(--accent)}

/* Sidebar */
.sidebar{position:fixed;top:0;right:0;width:var(--sidebar-w);height:100vh;background:var(--surface);box-shadow:var(--shadow-lg);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .35s cubic-bezier(.4,0,.2,1);z-index:200;overflow:hidden}
.sidebar.open{transform:translateX(0)}
.sb-head{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0;background:var(--surface)}
.sb-head-title{flex:1;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.icon-btn{width:30px;height:30px;background:none;border:none;color:var(--text-3);cursor:pointer;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:.15s;flex-shrink:0}
.icon-btn:hover{background:var(--surface-2);color:var(--text-2)}
.sb-body{padding:20px;border-bottom:1px solid var(--border);flex-shrink:0;overflow-y:auto;max-height:65vh}
.sb-product-row{display:flex;gap:14px;margin-bottom:14px}
.sb-icon{width:56px;height:56px;border-radius:13px;background:var(--surface-2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0;overflow:hidden}
.sb-icon img{width:100%;height:100%;object-fit:cover;display:block}
.sb-name-zh{font-size:18px;font-weight:700;letter-spacing:-.3px;line-height:1.3;margin-bottom:3px;color:var(--text)}
.sb-name-en{font-size:11px;color:var(--text-3);margin-bottom:8px}
.sb-desc{font-size:13px;color:var(--text-2);line-height:1.65}
.sb-stats{display:flex;gap:14px;margin:12px 0}
.sb-stat{font-size:13px;color:var(--text-2);display:flex;align-items:center;gap:4px}
.sb-stat strong{color:var(--accent)}
.sb-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
.sb-btn{display:block;padding:11px 18px;background:var(--accent);color:#fff;border-radius:10px;font-size:13px;font-weight:600;text-align:center;transition:opacity .15s;box-shadow:0 2px 8px rgba(255,97,84,.3)}
.sb-btn:hover{opacity:.9}
.sb-btn-sec{display:block;padding:10px 18px;border:1.5px solid var(--border);color:var(--text-2);border-radius:10px;font-size:13px;font-weight:500;text-align:center;margin-top:8px;cursor:pointer;background:none;width:100%;transition:.15s}
.sb-btn-sec:hover{border-color:var(--text-3);color:var(--text)}
.sb-iframe-wrap{flex:1;display:flex;flex-direction:column;min-height:0;background:var(--surface-2)}
.sb-iframe{width:100%;height:100%;border:none;flex:1;display:none;background:#fff}
.sb-no-preview{flex:1;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text-3);font-size:13px;text-align:center;padding:32px}

.regen-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100;align-items:center;justify-content:center;padding:20px}
.regen-overlay.open{display:flex}
.regen-modal{background:var(--surface);border-radius:14px;padding:20px;width:400px;max-width:100%;box-shadow:var(--shadow-lg)}
.regen-head{display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:600;margin-bottom:10px}
.regen-hint{font-size:12px;color:var(--text-3);line-height:1.5;margin-bottom:12px}
.regen-hint code{background:var(--tag-bg);padding:1px 5px;border-radius:4px}
.regen-modal input[type=password]{width:100%;padding:10px 12px;font-size:13px;border:1px solid var(--border);border-radius:8px;box-sizing:border-box;margin-bottom:10px;background:var(--surface-2);color:var(--text)}
.regen-log{background:#111;color:#0f0;font-family:ui-monospace,monospace;font-size:11px;padding:10px;border-radius:8px;white-space:pre-wrap;min-height:20px;max-height:260px;overflow-y:auto;margin-top:12px}
.regen-log:empty{padding:0;margin-top:0}

::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text-3)}

@media(max-width:640px){
  :root{--sidebar-w:100vw}
  .main{padding:0 16px 60px}
  .app.panel-open{padding-right:0}
}
</style>
</head>
<body>
<div class="app" id="app">
  <div class="main">
    <header>
      <div class="header-row">
        <div class="brand">
          <div class="ph-mark">P</div>
          <h1>Product Hunt 热门</h1>
        </div>
        <div style="display:flex;gap:8px">
          <button class="refresh-btn" onclick="openRegenModal()">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>
            重新生成
          </button>
          <button class="refresh-btn" onclick="window.location.reload()">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            刷新
          </button>
        </div>
      </div>
      <div class="header-sub">
        <span class="badge" id="period-badge">📅 ${data.periods.yesterday}</span>
        <span class="updated">更新于 ${data.updatedAt}</span>
      </div>
    </header>

    <div class="tab-bar">
      <div class="tab active" id="tab-yesterday" onclick="switchTab('yesterday')">昨日榜单</div>
      <div class="tab" id="tab-today" onclick="switchTab('today')">今日上线</div>
      <div class="tab" id="tab-weekly" onclick="switchTab('weekly')">周榜单</div>
      <div class="tab" id="tab-monthly" onclick="switchTab('monthly')">月度榜单</div>
    </div>
    <div class="list" id="list"></div>
  </div>
</div>

<div class="sidebar" id="sidebar">
  <div class="sb-head">
    <span class="sb-head-title" id="sb-title">产品详情</span>
    <button class="icon-btn" onclick="openNewTab()" title="新标签页打开">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    </button>
    <button class="icon-btn" onclick="closeSidebar()" title="关闭">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>
  <div class="sb-body" id="sb-body"></div>
  <div class="sb-iframe-wrap">
    <iframe class="sb-iframe" id="sb-iframe" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    <div class="sb-no-preview" id="sb-no-preview">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".4"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <span>该页面不支持内嵌预览</span>
    </div>
  </div>
</div>

<div class="regen-overlay" id="regenOverlay">
  <div class="regen-modal">
    <div class="regen-head">
      <span>重新生成榜单</span>
      <button class="icon-btn" onclick="closeRegenModal()" title="关闭">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <p class="regen-hint" id="regenHint">Key 只在浏览器和本地服务之间传递，不会被记录。留空则生成英文原文版本。</p>
    <input type="password" id="regenKey" placeholder="DEEPSEEK_API_KEY（可留空）" autocomplete="off">
    <button class="sb-btn" id="regenStart" onclick="runRegen()" style="width:100%;border:none;cursor:pointer">开始生成</button>
    <pre class="regen-log" id="regenLog"></pre>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(data)};
let activeTab = 'yesterday';
let activeUrl = null;

const TAB_IDS = ['yesterday', 'today', 'weekly', 'monthly'];

function switchTab(tab) {
  activeTab = tab;
  TAB_IDS.forEach(id => document.getElementById('tab-' + id).classList.toggle('active', id === tab));
  document.getElementById('period-badge').textContent = '📅 ' + DATA.periods[tab];
  closeSidebar();
  render();
}

function rankClass(i) {
  return ['gold','silver','bronze'][i] || '';
}

function render() {
  const products = DATA[activeTab] || [];
  const list = document.getElementById('list');
  if (!products?.length) {
    list.innerHTML = '<div style="padding:48px 0;text-align:center;color:#444;font-size:13px">暂无数据，请运行脚本更新</div>';
    return;
  }
  list.innerHTML = products.map((p, i) => \`
    <div class="card" onclick="openSidebar(\${i})">
      <div class="rank \${rankClass(i)}">\${p.rank}</div>
      <div class="icon">\${p.icon ? \`<img src="\${p.icon}" alt="" onerror="this.parentElement.innerHTML='🚀'">\` : '🚀'}</div>
      <div class="body">
        <div class="name-zh">\${p.zhName || p.name}</div>
        \${p.zhName && p.zhName !== p.name ? \`<div class="name-en">\${p.name}</div>\` : ''}
        <div class="desc">\${p.zhDetail || p.desc}</div>
        <div class="meta">\${p.tags.map(t => \`<span class="tag">\${t}</span>\`).join('')}</div>
      </div>
      <div class="right">
        <div class="votes">
          <div class="vote-box">
            <svg width="9" height="8" viewBox="0 0 10 8" fill="currentColor"><path d="M5 0L10 8H0z"/></svg>
          </div>
          <span class="vote-count">\${p.upvotes ?? '—'}</span>
        </div>
        <a class="ext-btn" href="\${p.url}" target="_blank" onclick="event.stopPropagation()" title="在 PH 查看">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      </div>
    </div>
  \`).join('');
}

function openSidebar(i) {
  const p = (DATA[activeTab] || [])[i];
  activeUrl = p.url;
  document.getElementById('sb-title').textContent = p.zhName || p.name;
  document.getElementById('sb-body').innerHTML = \`
    <div class="sb-product-row">
      <div class="sb-icon">\${p.icon ? \`<img src="\${p.icon}" alt="" onerror="this.parentElement.innerHTML='🚀'">\` : '🚀'}</div>
      <div style="min-width:0">
        <div class="sb-name-zh">\${p.zhName || p.name}</div>
        \${p.zhName && p.zhName !== p.name ? \`<div class="sb-name-en">\${p.name}</div>\` : ''}
        <div class="sb-desc">\${p.zhDetail || p.desc}</div>
      </div>
    </div>
    \${p.upvotes ? \`<div class="sb-stats"><div class="sb-stat">▲ <strong>\${p.upvotes}</strong> 票</div></div>\` : ''}
    <div class="sb-tags">\${p.tags.map(t => \`<span class="tag">\${t}</span>\`).join('')}</div>
    <a class="sb-btn" href="\${p.url}" target="_blank">在 Product Hunt 查看 →</a>
    <button class="sb-btn-sec" onclick="loadFrame()">尝试内嵌预览</button>
  \`;
  document.getElementById('sb-iframe').style.display = 'none';
  document.getElementById('sb-iframe').src = '';
  document.getElementById('sb-no-preview').style.display = 'none';
  document.getElementById('app').classList.add('panel-open');
  document.getElementById('sidebar').classList.add('open');
}

function loadFrame() {
  const frame = document.getElementById('sb-iframe');
  frame.style.display = 'block';
  frame.src = activeUrl;
  const t = setTimeout(showNoPreview, 5000);
  frame.onload = () => {
    clearTimeout(t);
    try { if (!frame.contentDocument?.body) showNoPreview(); } catch { showNoPreview(); }
  };
}

function showNoPreview() {
  document.getElementById('sb-iframe').style.display = 'none';
  document.getElementById('sb-no-preview').style.display = 'flex';
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('app').classList.remove('panel-open');
  document.getElementById('sb-iframe').src = '';
  activeUrl = null;
}

function openNewTab() { if (activeUrl) window.open(activeUrl, '_blank'); }

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname);

function openRegenModal() {
  const hint = document.getElementById('regenHint');
  const keyInput = document.getElementById('regenKey');
  const startBtn = document.getElementById('regenStart');
  if (IS_LOCAL) {
    hint.innerHTML = 'Key 只在浏览器和本地服务之间传递，不会被记录。留空则生成英文原文版本。需通过 <code>node server.mjs</code> 启动的本地服务访问此页面才能使用。';
    keyInput.style.display = 'block';
    startBtn.textContent = '开始生成';
  } else {
    hint.textContent = '将触发云端自动抓取最新榜单并翻译，无需输入任何内容，完成后（约 1-2 分钟）本页会自动刷新。';
    keyInput.style.display = 'none';
    startBtn.textContent = '触发更新';
  }
  document.getElementById('regenLog').textContent = '';
  document.getElementById('regenOverlay').classList.add('open');
}
function closeRegenModal() { document.getElementById('regenOverlay').classList.remove('open'); }

async function runRegen() {
  if (IS_LOCAL) return runRegenLocal();
  return runRegenRemote();
}

async function runRegenLocal() {
  const btn = document.getElementById('regenStart');
  const log = document.getElementById('regenLog');
  btn.disabled = true;
  log.textContent = '';
  const key = document.getElementById('regenKey').value;
  try {
    const res = await fetch('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      log.textContent += decoder.decode(value);
      log.scrollTop = log.scrollHeight;
    }
    if (log.textContent.includes('✅ 已生成')) {
      log.textContent += '\\n即将刷新页面…';
      setTimeout(() => window.location.reload(), 1200);
    }
  } catch (e) {
    log.textContent += '\\n请求失败：请确认是通过 node server.mjs 启动的本地服务打开此页面（而不是直接双击 index.html）。';
  }
  btn.disabled = false;
}

async function runRegenRemote() {
  const btn = document.getElementById('regenStart');
  const log = document.getElementById('regenLog');
  btn.disabled = true;
  log.textContent = '正在触发云端更新…';
  try {
    const res = await fetch('/api/trigger', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    log.textContent = '✅ 已触发，GitHub Actions 正在云端抓取最新数据（约 1-2 分钟），完成后页面会自动刷新。\\n你也可以稍后手动刷新查看。';
    setTimeout(() => window.location.reload(), 100000);
  } catch (e) {
    log.textContent = '❌ 触发失败：' + e.message;
  }
  btn.disabled = false;
}

render();
</script>
</body>
</html>`;
}

export { generateHTML };

// ── Main ───────────────────────────────────────────────────────
if (!process.env.GEN_HTML_ONLY) {

const now = new Date();
const todayStr = formatDate(now);

// 昨日
const yesterday = new Date(now);
yesterday.setDate(yesterday.getDate() - 1);
const yesterdayPath = `/leaderboard/daily/${yesterday.getFullYear()}/${yesterday.getMonth() + 1}/${yesterday.getDate()}`;

// 上周（往前推7天，取那一天所在的 ISO 周）
const lastWeekDate = new Date(now);
lastWeekDate.setDate(lastWeekDate.getDate() - 7);
const weekYear = getISOYear(lastWeekDate);
const weekNum = getISOWeek(lastWeekDate);
const weekPath = `/leaderboard/weekly/${weekYear}/${weekNum}`;

// 上个月
const lastMonthDate = new Date(now.getFullYear(), now.getMonth(), 0); // 上月最后一天
const monthYear = lastMonthDate.getFullYear();
const monthNum = lastMonthDate.getMonth() + 1;
const monthPath = `/leaderboard/monthly/${monthYear}/${monthNum}`;

const periods = {
  yesterday: `${yesterday.getFullYear()}年${yesterday.getMonth() + 1}月${yesterday.getDate()}日`,
  today: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
  weekly: `${weekYear}年 第${weekNum}周`,
  monthly: `${monthYear}年${monthNum}月`,
};

console.log('📡 正在抓取 Product Hunt 数据（4个榜单）...');

const [leaderboardMd, homepageMd, weeklyMd, monthlyMd] = await Promise.all([
  fetchJina(yesterdayPath),
  fetchJina('/'),
  fetchJina(weekPath).catch(() => ''),
  fetchJina(monthPath).catch(() => ''),
]);

console.log('✅ 数据获取成功，解析中...');
let yesterdayProducts = parseLeaderboard(leaderboardMd).slice(0, 20);
let todayProducts = parseHomepage(homepageMd).slice(0, 20);
let weeklyProducts = weeklyMd ? parseLeaderboard(weeklyMd).slice(0, 20) : [];
let monthlyProducts = monthlyMd ? parseLeaderboard(monthlyMd).slice(0, 20) : [];

console.log('📄 抓取产品详情页（日榜+今日）...');
[yesterdayProducts, todayProducts] = await Promise.all([
  enrichProducts(yesterdayProducts),
  enrichProducts(todayProducts),
]);

console.log('📄 抓取产品详情页（周榜+月榜）...');
[weeklyProducts, monthlyProducts] = await Promise.all([
  enrichProducts(weeklyProducts),
  enrichProducts(monthlyProducts),
]);

console.log('🌐 翻译中（日榜+今日）...');
[yesterdayProducts, todayProducts] = await Promise.all([
  translateProducts(yesterdayProducts),
  translateProducts(todayProducts),
]);

console.log('🌐 翻译中（周榜+月榜）...');
[weeklyProducts, monthlyProducts] = await Promise.all([
  translateProducts(weeklyProducts),
  translateProducts(monthlyProducts),
]);

console.log(`  昨日榜单: ${yesterdayProducts.length} 条`);
console.log(`  今日上线: ${todayProducts.length} 条`);
console.log(`  周榜单:   ${weeklyProducts.length} 条`);
console.log(`  月度榜单: ${monthlyProducts.length} 条`);

const data = {
  date: todayStr,
  updatedAt: now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  yesterday: yesterdayProducts,
  today: todayProducts,
  weekly: weeklyProducts,
  monthly: monthlyProducts,
  periods,
};

const outPath = join(__dirname, 'index.html');
writeFileSync(outPath, generateHTML(data), 'utf8');
console.log(`✅ 已生成: ${outPath}`);

} // end GEN_HTML_ONLY guard
