# keepalive-worker

一个 Cloudflare Workers 脚本：按固定时间间隔访问一组 URL，实现“保活”；同时提供手动触发接口。

## 功能

- 定时触发（Cron）：按 `wrangler.toml` 的 `crons` 执行
- 多 URL：通过环境变量传入多个 URL
- 超时控制：每个 URL 单独超时
- 并发限制：控制同时请求的数量
- 手动触发：`/do?token=...`（或 `Authorization: Bearer ...`）

## 配置（环境变量）

- `URLS`：多个 URL。支持：
  - JSON 数组：`["https://a.com","https://b.com"]`
  - 逗号分隔：`https://a.com,https://b.com`
  - 按行分隔（含空格也可）
- `TIMEOUT_MS`：单次请求超时（毫秒），默认 `8000`
- `CONCURRENCY`：并发上限，默认 `3`
- `TOKEN`：手动触发 token（建议使用 `wrangler secret put TOKEN`）

## 手动触发

访问：

- `https://<你的 worker 域名>/do?token=123`

返回 JSON，包含每个 URL 的状态、耗时与错误信息。

## 开发/部署

```bash
npm i
npm run dev
```

部署：

```bash
npm run deploy
```

设置 secret（推荐）：

```bash
npx wrangler secret put TOKEN
```
