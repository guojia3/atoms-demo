// 产物独立复核：把生成的应用 HTML 以 http 顶层页面提供，验证真实点击与 localStorage 持久化
// 用法：ARTIFACT=test/results/app-artifact.html npx tsx test/serve-artifact.ts
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve(process.env.ARTIFACT || 'test/results/app-artifact.html')
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(fs.readFileSync(file))
  })
  .listen(3210, () => console.log(`[artifact] listening on http://127.0.0.1:3210 (${file})`))
