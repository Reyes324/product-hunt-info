#!/usr/bin/env node
// 本地服务：直接托管 index.html（页面里内置"重新生成"入口），POST /run 触发 fetch_ph.mjs。
// key 只在浏览器和这个进程之间传递，不写日志、不回显。
// 运行方式: node server.mjs

import http from 'http';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8879;

function serveIndex(res) {
  const p = join(__dirname, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); res.end('index.html 不存在，先运行一次 node fetch_ph.mjs'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(p, 'utf8'));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    serveIndex(res);
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let key = '';
      try { key = JSON.parse(body).key || ''; } catch {}

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

      const child = spawn('node', ['fetch_ph.mjs'], {
        cwd: __dirname,
        env: { ...process.env, DEEPSEEK_API_KEY: key },
      });

      child.stdout.on('data', d => res.write(d));
      child.stderr.on('data', d => res.write(d));
      child.on('close', code => {
        res.write(code === 0 ? '\n🎉 生成完成\n' : `\n❌ 进程退出码 ${code}\n`);
        res.end();
      });
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🚀 http://localhost:${PORT}`);
});
