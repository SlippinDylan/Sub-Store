# Cloudflare Workers 部署

本分支把 Sub-Store 后端移植到原生 Cloudflare Workers。它不使用 Docker，也不使用 Cloudflare Containers。

## 架构

```text
客户端
  → Cloudflare Worker（入口鉴权）
  → 固定名称的 Durable Object（请求串行化）
  → 原版 Sub-Store REST / 解析 / 转换逻辑
  → Durable Object SQLite（事务持久化）
```

Worker 适配主要位于 `backend/src/platforms/cloudflare/`。原版解析器、生产器和 REST 业务逻辑继续直接使用，便于后续合并 `sub-store-org/Sub-Store` 的更新。

动态脚本不能使用 Workers 禁止的 `eval()` 或 `new Function()`。Worker 构建会预编译 Peggy 语法，并使用受资源限制的 QuickJS 执行 Script Operator、Script Filter 和 Response Transformer。

## 安装与验证

环境要求：Node.js 版本以仓库根目录的 `.node-version` 为准，并启用 Corepack。

```bash
cd backend
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm check:cloudflare
```

`check:cloudflare` 会构建 Worker，并通过 Wrangler dry-run 验证入口、Durable Object binding、Wasm 模块和上传包。

本地调试：

```bash
cd backend
pnpm dev:cloudflare
```

开发环境的管理入口前缀是 `/dev`。例如：

```text
http://localhost:8787/dev/api/utils/env
```

## 生产部署

先登录 Cloudflare：

```bash
cd backend
pnpm wrangler login
```

管理 API 默认关闭。部署前必须设置一个足够长、不可猜测且以 `/` 开头的管理路径。这里设置的是管理路径 Secret，不是加密私钥。

可以先生成 24 字节随机值：

```bash
openssl rand -hex 24
```

在输出前加 `/` 作为最终值。管理路径必须以 `/` 开头、不能以 `/` 结尾，也不要使用 `/admin`、`/substore` 等容易猜测的值。

### 方法一：Cloudflare Dashboard

部署后端 Worker 后进入：

```text
Workers & Pages
→ 选择后端 Worker
→ Settings
→ Variables and Secrets
→ Add
→ Secret
```

填写：

```text
名称：SUB_STORE_FRONTEND_BACKEND_PATH
值：/<生成的随机值>
类型：Secret
```

保存后让 Cloudflare 创建包含该 Secret 的新版本。

### 方法二：Wrangler

```bash
cd backend
pnpm wrangler secret put SUB_STORE_FRONTEND_BACKEND_PATH --env=''
```

Wrangler 提示输入时，填写完整的 `/<随机值>`。示例仅用于说明格式：

```text
/0123456789abcdef0123456789abcdef0123456789abcdef
```

不要把真实值写入 Git、`wrangler.jsonc`、`.env`、前端构建变量或公开文档。

部署：

```bash
pnpm deploy:cloudflare
```

然后把 WebUI 的后端地址设置为：

```text
https://<你的 Worker 域名>/<管理路径>
```

默认 CORS 允许官方前端。使用自托管前端 Worker 时，还要在后端 Worker 中配置 `SUB_STORE_CORS_ALLOWED_ORIGINS`。只填写前端的完整 Origin：包含 `https://` 和主机名，不包含路径、查询参数或末尾 `/`；多个 Origin 用英文逗号分隔。

Dashboard 设置方法：

```text
Workers & Pages
→ 选择后端 Worker
→ Settings
→ Variables and Secrets
→ Add
→ Text

名称：SUB_STORE_CORS_ALLOWED_ORIGINS
值：https://<前端 Worker 域名>
```

也可以用 Wrangler 设置同名 Secret：

```bash
cd backend
pnpm wrangler secret put SUB_STORE_CORS_ALLOWED_ORIGINS --env=''
```

该值本身不敏感，Dashboard 使用 Text 类型即可。

## 访问边界

- `/api/*`：必须通过管理路径访问。
- `/download/*`：必须通过管理路径访问，避免仅凭订阅名称直接读取。
- `/share/*`：可公开访问，但必须携带原版 Sub-Store 生成的有效 Share Token；次数限制和过期时间正常生效。
- 内部定时任务入口不会暴露到公网。

管理路径是为了兼容 Sub-Store 前端的第一道保护。当前分离部署的 WebUI 使用跨源请求，不能直接给后端套 Cloudflare Access，否则 Access 登录或 Cookie 流程可能阻断 WebUI。若以后增加同站代理或专门的 Access 鉴权适配，再考虑用 Access 保护管理接口；`/share/*` 仍需保持 Token 访问。

## 定时同步

Worker 已实现 Cloudflare `scheduled()` handler：触发时会同步未配置独立 Cron 的远程配置。仓库默认不主动创建 Cron Trigger，避免部署后未经确认产生定时外部请求。

需要定时同步时，在 `backend/wrangler.jsonc` 增加，例如每 6 小时一次：

```jsonc
"triggers": {
  "crons": ["0 */6 * * *"]
}
```

Cloudflare Cron 使用 UTC。原版每个 Artifact 的动态 Cron 目前不会转换成 Cloudflare Trigger。

## 当前兼容范围

已支持：

- 订阅、组合、文件、远程配置和设置的 CRUD
- HTTP/HTTPS 订阅获取、解析、转换和下载
- Gist 备份及同步
- Share Token 创建、过期、次数限制和 Age 输出加密
- Script Operator、Script Filter、Response Transformer
- Durable Object SQLite 持久化和旧版 Worker KV 数据迁移
- Cloudflare Cron Trigger 的全局远程配置同步

平台限制：

- 不支持出站 HTTP/SOCKS 代理选择，也不能关闭 TLS 证书校验。
- 不支持本地文件路径、MMDB 文件、UDP DNS、TCP DNS 或 DoT；请使用 DoH。
- Worker 通知目前只写日志，不发送 Node 版 Shoutrrr 推送。
- 单个持久化值限制为 1.9 MB，请避免把超大内容放进单个订阅、文件或缓存项。
- 请求体限制为 1 MB；Worker isolate 总内存限制为 128 MB。
- 大型订阅转换更适合 Workers Paid 的 CPU 配额。

Cloudflare 官方资料：

- [Workers Node.js 兼容性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [SQLite-backed Durable Object 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers 平台限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)

## 同步上游

`master` 只跟踪上游，Worker 改造保留在 `worker`：

```bash
git switch master
git fetch upstream
git merge --ff-only upstream/master
git push origin master

git switch worker
git merge master
cd backend
pnpm install --frozen-lockfile
pnpm test
pnpm check:cloudflare
```

发现上游发布新版本后，再按上述流程人工合并并处理可能的冲突。仓库不会定时检查或自动合并上游更新。

Cloudflare 平台层参考并改进自 [kasumikira/sub-worker](https://github.com/kasumikira/sub-worker)，继续遵循本项目 AGPL-3.0 许可证。
