# sftp-relay — Node + ssh2 后端中转（给 fi17 这类纯 SFTP 账号）

2026-11-12 晚 daye 提出来的思路：一个 Node 小服务用 ssh2 库连 2022 端口，
网页只负责列目录、上传、下载。CloudSSH 现在的后端是跑在 Worker 里手写的
SSH 客户端（Worker 用不了 ssh2），fi17 的文件列表一直出不来；
换成熟的 ssh2 库是合理的下一步——**但前提是 fi17 的 SFTP 服务本身是好的**。

## 先决条件（没过就别部署）

1. daye 本机 FileZilla 直连 fi17（主机/端口/用户名/密码就是面板上那套）能列出文件
   → 说明服务端是好的，换 ssh2 才有戏。
2. FileZilla 也列不出来 → 服务端问题，换什么库都没用，找 bot-hosting，跟中转没关系。

fi11 是另一回事：面板密码跟服务端对不上（已更新到 CloudSSH 仍认证失败），
要 daye 在面板点 Regenerate 拿新密码再更新。跟这个中转无关。

## 服务本身

- `server.js`：纯 Node stdlib HTTP + `ssh2`，无其他依赖。
- 接口（除 `/health` 外都要带 `X-Relay-Token`）：
  - `GET /health` → `{ok:true}`
  - `GET /api/list?path=/` → 目录条目（文件名、大小、mtime、是否目录）
  - `GET /api/download?path=/x` → 文件流
  - `POST /api/upload?path=/x` → body 即文件内容（上限 100MB）
  - `POST /api/mkdir` + JSON `{"path":"/x"}` → 建目录
- 每次请求新建一个 SSH 连接，用完即关（无状态，避免 CloudSSH 那种
  “旧 handler 占着不释放、刷新被挡”的死锁）。
- 凭证只走环境变量，绝不写进代码/文件：
  `SFTP_HOST` `SFTP_PORT`（默认 2022）`SFTP_USER` `SFTP_PASS`
  `RELAY_TOKEN`（API 鉴权）`PORT`（默认 3000）。

## 部署候选（待部署时实测哪台能通 fi17:2022）

| 候选 | 依据 | 风险 |
|---|---|---|
| alwaysdata Node 站点（wudacaowuer 账号） | 已有 Node 站点自举经验（见 AGENTS.md）；`npm install` 正常 | 出站到 2022 端口是否放行，未实测 |
| Unikraft 实例（mystery/myusservers） | 完整容器，出站一般不受限 | 要装 Node、占实例资源；部署方式待定 |
| Simular 盒子 | **已排除**：2026-11-12 实测，代理 ruleset 明确拦 fi17:2022（同代理连 github:22 是通的） | — |
| 本机沙箱 | **已排除**：出口代理掐 SSH 直连 | — |
| Cloudflare Worker | **做不了**：Worker 用不了 ssh2，这正是现在 CloudSSH 的短板 | — |

部署时先在目标机器上跑 `sftp -P 2022 <user>@fi17.bot-hosting.cloud`
（或 `node -e` 连一下）确认出站通，再起服务。

## 本地验证（2026-11-12）

- `npm install ssh2` 成功；`node --check server.js` 通过。
- 未连 fi17 实测：沙箱/盒子都连不上 fi17:2022，真正的端到端
  （list/download/upload）只能在部署机器上、配好凭证后测。

## 待 daye 定

1. FileZilla 结果（先做这个）。
2. 部署到哪台机器（alwaysdata / Unikraft 二选一）。
3. 前端接哪里：CloudSSH 里加一个“中转模式”开关，还是单独一个极简网页。
