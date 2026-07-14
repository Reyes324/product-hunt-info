// Vercel Serverless Function: 收到网页按钮的 POST 请求后，
// 用只保存在 Vercel 环境变量里的 GitHub token 触发 Actions workflow_dispatch。
// token 只在这段代码运行的瞬间存在于内存里，永远不会发回浏览器。

const OWNER = 'Reyes324';
const REPO = 'product-hunt-info';
const WORKFLOW_FILE = 'update.yml';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    res.status(500).json({ error: '服务端未配置 GH_DISPATCH_TOKEN' });
    return;
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );

  if (ghRes.status === 204) {
    res.status(200).json({ ok: true });
    return;
  }

  const text = await ghRes.text();
  res.status(502).json({ error: `GitHub API ${ghRes.status}: ${text}` });
}
