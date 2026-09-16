# DHT Search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Runtime](https://img.shields.io/badge/runtime-Node%20%7C%20Bun-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)

**简体中文** | [English](README.en.md)

基于 **SQLite FTS5 全文检索**的磁力链接（magnet / torrent）搜索引擎，配套 Vite + Tailwind 构建的检索界面。项目不包含 DHT 爬虫本身，只消费已存在的源库数据。

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [配置项](#配置项configjs)
- [启动](#启动)
- [HTTP API](#http-api)
- [架构](#架构)
- [项目结构](#项目结构)
- [热词过滤词（黑名单）](#热词过滤词黑名单)
- [测试](#测试)
- [运维要点](#运维要点)
- [RPC 推送（aria2 / Motrix）](#rpc-推送aria2--motrix)
- [exe 版使用指南](#exe-版使用指南零基础向)
- [数据来源与致谢](#数据来源与开源致谢)
- [免责声明与开源协议](#免责声明与开源协议)

## 功能特性

- **全文搜索**：对 `name` / `files` 两列做 FTS5 模糊检索，末位 token 前缀匹配，大小写 / 变音折叠。
- **infohash 精确检索**：输入 40 位 hex（或带 `urn:btih:` / `hash` 前缀）时自动切换为精确 + 前缀匹配。
- **排序与过滤**：按抓取时间 / 体积 / 相关度（bm25）排序，支持体积区间过滤。
- **真服务端分页**：翻页与排序均按页从后端拉取，`total` 与结果始终一致。
- **双视图**：搜索视图与「资源库」视图（按入库顺序列出最新资源，仅分页）。
- **URL 状态同步**：视图记在 hash（`#latest`），关键词 / 排序 / 筛选 / 页码记在 query string，均写入浏览器历史，可分享与前进后退。
- **热门关键词榜与输入联想**：索引期统计热词（去单字、去纯数字、去噪声词），联想按「相等 > 前缀 > 包含 > 模糊」分级匹配。
- **热词黑名单**：支持种子脚本、HTTP API、Web 界面三种维护方式（含导入 / 导出）。
- **文件树**：详情弹窗按需拉取扁平树，支持展开收起与关键词高亮。
- **搜索缓存**：进程内 LRU，按字节数与 TTL 淘汰（默认 32MB / 1h）。
- **影子库重建 + 原子切换**：重建在独立子进程写入影子库，完成后原子切换，期间线上索引不受影响。
- **运行状态监测**：设置面板经 SSE 推送缓存命中、内存、进程数、已索引总数、下次同步时间与维护进度。
- **访问控制**：接入层 IP / 网段白名单（默认开启），整站统一把关。
- **RPC 推送**：结果卡片可将磁力链接推送到 aria2 / Motrix。

## 快速开始

### 前置条件

1. **源库**：`data/magnet.db` 必须存在且包含 `magnets` 表（由外部爬虫写入），缺失时启动报错。
2. **运行时**（二选一）：
   - **Node ≥ 20**（推荐 22 / 24 LTS）：需 `better-sqlite3` 原生模块，`npm install` 会自动安装；
   - **Bun**：使用内置 `bun:sqlite`，无需原生编译。仓库根的 `bunfig.toml` 已配置跳过 `better-sqlite3`。

```bash
npm install                 # Node 路径
# 或
bun install                 # Bun 路径
```

> `better-sqlite3` 声明在 `optionalDependencies` 而非 `dependencies`：Node 路径需要它，Bun 路径不需要。
> `bun install` 按 `bunfig.toml` 的 `optional = false` **跳过**它（不下载、不编译），而 npm / pnpm 默认会安装。
> npm 与 Bun 共用同一个 `node_modules`，切换包管理器后若 Node 下启动报「找不到 better-sqlite3」，
> 执行 `npm install better-sqlite3` 补上即可。

3. **构建前端**（首次部署执行一次）：

```bash
npm run build:web           # web/ → public/（Vite + Tailwind）
```

## 配置项（`config.js`）

所有配置项集中在 `config.js`，均为独立 `export const`，修改后重启服务生效。路径支持相对（基于项目根）或绝对路径。

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `SOURCE_DB_PATH` | `data/magnet.db` | 源库路径（含 `magnets` 表） |
| `INDEX_DB_PATH` | `data/dht.search.db` | 影子索引库路径 |
| `PORT` | `3000` | HTTP 服务端口 |
| `WEB_BASE_PATH` | `'/dht'` | 前端产物部署前缀：空 = 站点根；`/dht` 适合反代子路径。改后需重新构建前端 |
| `MAX_RESULTS` | `2000` | 「整集拉取」（`limit=all`）单次返回上限，超出标记 `truncated` |
| `REINDEX_MAX_OLD_SPACE_MB` | `2048` | 索引维护子进程堆上限（MB）：Node 经 `--max-old-space-size` 传入；Bun 加 `--smol` |
| `SEARCH_CACHE_MAX_SIZE_MB` | `32` | 搜索缓存上限（MB），缓存存序列化后的 JSON 字符串 |
| `SEARCH_CACHE_TTL_MS` | `3600000` | 搜索缓存 TTL（ms） |
| `SEARCH_MAX_PROCESSES` | `2` | 最大并发搜索进程数 |
| `SEARCH_PROCESS_CACHE_SIZE_KB` | `2048` | 每个搜索子进程的 SQLite page cache（KiB，每进程一份） |
| `SEARCH_PROCESS_MMAP_SIZE_MB` | `32` | 每个搜索子进程的 mmap 窗口（MB），`0` 关闭 |
| `SEARCH_PROCESS_RECYCLE_IMMEDIATE` | `false` | 查询完成立即回收进程（内存最省，但每次查询付冷启动） |
| `SEARCH_PROCESS_IDLE_MS` | `60000` | 搜索进程空闲回收时间（ms），`0` 关闭；仅在上一项为 `false` 时生效 |
| `SEARCH_QUEUE_MAX` | `16` | 搜索等待队列上限，超出快速失败 |
| `SEARCH_QUEUE_TIMEOUT_MS` | `10000` | 排队超时（ms），`0` 不限时 |
| `SYNC_CRON` | `''` | 定时增量同步的 cron 表达式（5 字段，如 `'0 4 * * *'`）；空表示关闭 |
| `SYNC_ON_START` | `false` | 是否在启动时执行一次增量补录。索引格式过期时启动会无视本项自动跑迁移重建（见[运维要点](#运维要点)） |
| `ACCESS_CONTROL_MODE` | `'ip-whitelist'` | `'ip-whitelist'` 仅放行白名单，`'off'` 关闭 |
| `ALLOWED_CLIENTS` | 见 config.js | 白名单地址，支持精确 IPv4 / IPv6 与 CIDR；默认含本机与常见内网段 |
| `TRUST_PROXY` | `true` | 是否信任反代的 `X-Forwarded-For`（影响 `req.ip` 与白名单比对） |

路径解析优先级：**显式参数 > config.js > 模块默认值**。服务代码不读取 `DHT_DB_PATH` / `DHT_INDEX_DB_PATH` 环境变量，`scripts/` 下的脚本仍会读取。

## 启动

> **首次启动**：服务先监听端口、立即可访问，索引在后台构建（全新索引库为全量灌入，已有索引库为增量补录）。构建期间检索结果不全、计数偏小属正常，设置面板可观察进度。

```bash
npm start                    # Node
bun index.js                 # Bun

npm run dev:node             # 开发：nodemon
npm run dev:bun              # 开发：bun --watch
npm run dev:web              # 开发：Vite dev server（/api 代理到后端）
```

启动后访问 `http://localhost:<port>`（默认 3000）。

### pm2

```bash
pm2 start ecosystem.config.node.json   # 或 npm run start:pm2:node
pm2 start ecosystem.config.bun.json    # 或 npm run start:pm2:bun
npm run stop:pm2                       # 停止两个实例
npm run logs:pm2                       # 查看日志
```

两份配置均不硬编码端口，统一读取 `config.js` 的 `PORT`；同机并存时可临时用 `PORT=3001 pm2 start ecosystem.config.bun.json` 区分。

### 单文件 exe（bun build --compile）

在开发机打包一次，目标机器无需安装 Bun / Node 与任何依赖。

```bash
npm run build:zip        # = build:exe & pack:zip，产物 release/DHT-Search-v<版本号>.zip
```

| 命令 | 作用 | 产物 |
|------|------|------|
| `npm run build:exe` | 前端构建 → exe 编译 → 同步 public → 复制 config.js / README.md → 创建空 data/ | `dist/` 完整交付目录 |
| `npm run pack:zip` | 纯压缩，不做构建 | `release/DHT-Search-v<版本号>.zip` |

```
dist/
├── DHT-Search.exe   # 单文件服务（内含后端与执行体；前端资源不进 exe）
├── config.js        # 外置配置：运行时优先读取，改完重启即生效
├── public/          # 前端静态资源
└── data/            # 运行时数据（自动创建；源库 magnet.db 放这里）
```

- **部署**：分发 `release/` 下的 zip，解压即用；或直接拷贝整个 `dist/`。
- **改配置**：编辑 exe 旁的 `config.js` 并重启；删除该文件则回退内置默认值。
- **跨平台**：`bun build exe-entry.js --compile --target=bun-linux-x64`（详见 Bun 官方文档）。
- **编译态行为**：磁盘上只剩一个 exe，源码态 spawn 的两个执行体改为 spawn(exe 自身, 启动标记) 自拉起，IPC 协议不变。
- **最终用户**：见[exe 版使用指南](#exe-版使用指南零基础向)。

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 重定向到 `/index.html` |
| GET | `/index.html`、`/public/*` | 前端静态资源 |
| GET | `/api/search` | 搜索（见下） |
| GET | `/api/latest` | 最新入库列表（不经 FTS，按入库顺序从新到旧） |
| GET | `/api/magnet/:id/files` | 某条资源的完整文件树 `{ id, nodes }` |
| GET | `/api/count` | 已索引条数 `{ count }` |
| GET | `/api/hot?limit=` | 热词榜 `{ items }` |
| GET | `/api/hot/filter` | 过滤词列表 |
| POST | `/api/hot/filter` | 新增过滤词，body `{ term }` |
| DELETE | `/api/hot/filter?term=` | 删除过滤词 |
| GET | `/api/hot/filter/export` | 导出过滤词为文本附件（每行一词） |
| POST | `/api/hot/filter/import` | 批量导入，body `{ terms: string[] }` → `{ ok, accepted, total }` |
| POST | `/api/reindex` | 全量重建（子进程写影子库 → 原子切换）→ `{ ok, indexed }` |
| POST | `/api/sync` | 手动增量同步 → `{ ok, skipped, added }` |
| GET | `/api/stats/stream` | 运行状态 SSE 流（每 3 秒推送） |

### `GET /api/search`

| 参数 | 说明 |
|------|------|
| `q` | 必填，搜索关键词（至少一个字母或数字） |
| `sortBy` | `fetchedAt` / `totalSize` / `relevance`；其他值忽略（按 id 排序） |
| `order` | `asc` / `desc`，默认 `desc`，仅 `sortBy` 传入时生效 |
| `limit` | 每页条数（钳制 1..200，缺省 20）；仅 `all` 表示整集拉取 |
| `offset` | 分页偏移 |
| `minSize` / `maxSize` | 体积区间（字节） |
| `by` | `hash` 时按 infohash 精确检索 |

返回 `{ total, limit, offset, items: [{ id, name, infohash, magnet, fileCount, preview, totalSize, fetchedAt }], truncated? }`。

`fileCount` 为索引期算好的文件数；`preview` 为服务端挑好的前 5 条 `{ path, size }`（有关键词时只含命中的条目）。列表不下发整棵文件树，需要时调用 `/api/magnet/:id/files`；整集拉取超出 `MAX_RESULTS` 时带 `truncated: true`。

### `GET /api/magnet/:id/files`

返回 `{ id, nodes }`，`nodes` 为扁平树：

```js
[{ name, parent, isDir, size, path? }]
```

`parent` 是父节点在数组中的下标（根为 `-1`），目录的 `size` 已累加子孙，仅文件节点带 `path`。`id` 非整数返回 400，条目不存在返回 404。

### `GET /api/latest`

| 参数 | 说明 |
|------|------|
| `limit` | 每页条数（钳制 1..200，缺省 30）；不支持 `all` |
| `offset` | 分页偏移 |

返回字段同 `/api/search`。该接口固定按 `id` 倒序，不提供关键词 / 排序 / 过滤，也不经过 FTS。

### 请求取消

客户端中途断开（关页面或前端发起新搜索）时，服务端立即取消对应检索：排队中直接移除，执行中的 `SIGKILL` 搜索子进程，不写缓存也不响应。

## 架构

### 影子索引

源库在查询期完全不触碰，所有检索打在另一份可写索引库上：

| 库 | 文件 | 角色 | 访问方式 |
|----|------|------|----------|
| 源库 | `data/magnet.db` | 外部爬虫写入的原始数据 | 构建 / 同步索引时只读打开 |
| 索引库 | `data/dht.search.db` | FTS5 索引 + 副本 + 同步水位 + 热词 | 查询只命中这里 |

索引库内含 4 类对象：

- `magnets_fts`：contentless FTS5 虚表，索引 `name` 与 `files` 的纯路径文本；
- `magnets_docs`：`magnets` 的去规范化副本（含 `fileCount` 列），供检索 JOIN；`files` 列存源库原文，详情接口据其构建扁平树；
- `sync_meta`：索引状态（数据水位 `last_rowid` / 格式版本 `files_format` / 维护状态 `build_mode` / FTS 合并计数 `fts_pending`）；
- `keyword_stats` / `keyword_filter`：热词统计与过滤表。

### 同步策略

- 启动时按 `last_rowid` 增量补录新增行（后台执行，不阻塞服务）；
- 运行期周期维护由 `SYNC_CRON` 定时增量同步承担，默认关闭；全量重建仅手动触发；
- 源库已有行的 UPDATE / DELETE 不会被增量捕获，需手动 `POST /api/reindex` 全量重建。

### 双运行时

`src/db-driver.js` 运行时按 `typeof Bun` 自动选择驱动，业务代码无需感知：

| 运行时 | 驱动 | 索引维护执行方式 |
|--------|------|------------------|
| Node | `better-sqlite3` + `drizzle-orm/better-sqlite3` | 独立子进程（spawn + IPC，堆上限经 `--max-old-space-size`） |
| Bun | `bun:sqlite` + `drizzle-orm/bun-sqlite` | 独立子进程（spawn + IPC，加 `--smol`） |

两种运行时使用同一套执行载体，派生细节统一在 `src/child-process.js`。

### 搜索执行模型

检索在独立子进程中执行，目的是「客户端断开即停」：驱动是同步 API，一条查询会阻塞执行单元，只有进程级 `SIGKILL` 能真正中断，因此执行单元必须是进程而非线程。

进程按需 spawn，非常驻：

| 时机 | 行为 |
|------|------|
| 服务启动 | 0 个进程 |
| 查询到来 | 复用空闲进程；没有且未达 `SEARCH_MAX_PROCESSES` 才 spawn |
| 进程全忙 | 新查询进 FIFO 等待队列 |
| 客户端断开 | `SIGKILL` 并移除（不补位） |
| 空闲超时 | 超过 `SEARCH_PROCESS_IDLE_MS` 后回收，进程数回到 0 |

取消分两级：排队中直接移除（零成本）；已派发则 `SIGKILL` 中断。子进程的内存主要用于运行时基线，降低内存的主要手段是减少进程数，而非压 PRAGMA。

### 前端

前端源码在 `web/src/`（Alpine.js + Tailwind，Vite 打包），渲染与事件由 `index.html` 的 Alpine 指令驱动，`web/src/` 只提供状态、动作与纯函数。`npm run build:web` 产物输出到根目录 `public/`，由后端 `express.static` 托管。

## 项目结构

```
DHT-search/
├── index.js                   # Express 入口：HTTP API + 静态资源 + 搜索缓存/定时同步/运行状态 SSE
├── exe-entry.js               # 单文件 exe 打包入口（bun --compile）
├── app-entry.cjs              # pm2 入口包装器（CJS require → 动态 import ESM 的 index.js）
├── config.js                  # 运行期配置（每项独立 export const）
├── ecosystem.config.node.json # pm2 配置：Node 运行时
├── ecosystem.config.bun.json  # pm2 配置：Bun 运行时
├── bunfig.toml                # Bun 安装配置（跳过 better-sqlite3 原生模块）
├── package.json
├── src/
│   ├── db.js                  # 门面：createMagnetDb 组装（索引维护 + 检索 + 热词）
│   ├── index/                 # 索引子系统
│   │   ├── ddl.js             # 索引库 DDL 唯一来源（ensureSchema / resetIndexTables）
│   │   ├── transform.js       # 索引期行转换（files 原文 → FTS 纯路径文本 + fileCount）
│   │   ├── tuning.js          # 调优参数（批大小 / 重建期 PRAGMA / 排序线程）
│   │   └── timing.js          # 索引流水线分段计时
│   ├── search/                # 检索子系统
│   │   ├── query.js           # 检索输入契约（参数归一化 / MATCH 表达式 / SQL 白名单）
│   │   └── api.js             # 检索实现（主进程与搜索子进程共用）
│   ├── db-driver.js           # 统一 SQLite 驱动适配层（Node/Bun 自动切换 + 能力探测）
│   ├── store.js               # 共享约定（CONFIG、库路径、表名与列清单、排序白名单）
│   ├── settings.js            # 统一配置加载层（编译态优先读 exe 同目录的 config.js）
│   ├── worker-flags.js        # 执行体子进程命令行标记
│   ├── child-process.js       # 统一子进程派生入口
│   ├── schema.js              # drizzle 表定义（sync_meta）
│   ├── file-tree.js           # 扁平文件树构建（详情接口按需调用）
│   ├── reindex-worker.js      # 索引维护执行体（IPC 回传进度 / 结果）
│   ├── searchPool.js          # 搜索子进程池（按需 spawn + 有界并发 + 等待队列）
│   ├── search-child.mjs       # 搜索子进程入口
│   ├── accessControl.js       # 接入层访问控制（IP / 网段白名单）
│   ├── stats.js               # 运行时状态
│   ├── logger.js              # 分级日志
│   └── util.js                # 共享纯函数
├── scripts/                   # 运维 / 种子脚本（非运行时依赖）
│   ├── build-exe.mjs          # 单文件 exe 构建
│   ├── pack-zip.mjs           # 打包 release/*.zip
│   ├── seed-filter.mjs        # 噪声词种子入库（读 hot-filter-words.txt，幂等）
│   ├── hot-filter-words.txt   # 噪声词清单（每行一词，# 开头为注释）
│   ├── dump-keywords.mjs      # 导出未过滤热词供审阅
│   ├── filter-common-en.mjs   # 自动筛选宽泛英语热词候选
│   ├── fts-ab.mjs             # FTS5 参数 A/B 基准（npm run bench:fts）
│   ├── reset.mjs              # 重置应用：删除索引库与衍生文件（npm run reset）
│   └── spike/                 # 试验性脚本草稿
├── web/                       # 前端源码（Vite + Tailwind，需构建）
│   ├── index.html
│   ├── vite.config.js         # 产物输出 ../public；dev 期 /api 代理到后端
│   └── src/
│       ├── main.js            # 入口：注册 Alpine 组件与 store
│       ├── app.js             # 页面主组件（状态 + 动作）
│       ├── card.js            # 结果卡片组件
│       ├── api.js             # 后端接口层
│       ├── toast.js           # 全局通知 store
│       ├── icons.js           # 模板用图标字面量
│       ├── file-tree.js       # 渲染扁平文件树
│       ├── util.js            # 共享纯函数
│       └── styles/app.css     # Tailwind 入口
├── public/                    # 前端构建产物（build:web 生成）
├── test/                      # 测试与基准脚本
├── dist/                      # exe 构建产物（不入库）
└── data/                      # 运行时数据（源库与索引库，不入库）
```

## 热词过滤词（黑名单）

过滤词会从热词榜与统计中剔除，三种维护方式：

### 种子脚本

```bash
npm run seed:filter          # 读 scripts/hot-filter-words.txt 入库（幂等）
```

辅助脚本（仅生成候选，不自动入库）：

- `scripts/dump-keywords.mjs`：导出未过滤的纯 ASCII 热词（按 `doc_count` 降序）到 `scripts/hot-keywords-dump.txt`；
- `scripts/filter-common-en.mjs`：筛选宽泛英语热词候选，写入 `scripts/hot-filter-en.auto.txt`。

### HTTP API

```bash
curl -X POST localhost:3000/api/hot/filter -H 'content-type: application/json' -d '{"term":"foo"}'
curl -X DELETE 'localhost:3000/api/hot/filter?term=foo'

# 批量导入（空行 / # 注释 / 纯符号行会被忽略，幂等）
curl -X POST localhost:3000/api/hot/filter/import \
  -H 'content-type: application/json' \
  -d '{"terms":["foo","bar"]}'

# 导出（text/plain 附件，可保存后再次导入）
curl -L localhost:3000/api/hot/filter/export -o hot-filter-export.txt
```

导入 / 导出格式一致：每行一个词，`#` 开头为注释。

### Web 界面

「黑名单」面板标题栏提供导入 / 导出按钮：导出直接下载 `.txt`，导入选择文件后批量写入并即时刷新热词榜。

## 测试

```bash
npm test                 # 定时同步接线 + 重置脚本 + 冒烟 + 真实启动集成（cron / reset / smoke / boot）
npm run test:cron        # 定时同步接线（test/cron.mjs）
npm run test:reset       # 重置脚本行为（test/reset.mjs，用临时路径，不碰真实 data/）
npm run smoke            # 冒烟测试（test/smoke.mjs，自动生成夹具数据）
npm run test:boot        # 真实起服务 + HTTP 集成（test/boot.mjs）
npm run test:access      # 访问控制测试（test/access-control.mjs）
npm run verify:driver    # 驱动层可行性验证（test/verify-driver.mjs）
npm run bench:fts        # FTS5 建表参数 A/B（scripts/fts-ab.mjs）
npm run bench:index      # 重建性能基准（test/bench-index.mjs）
```

| 脚本 | 覆盖内容 |
|------|----------|
| `smoke.mjs` | 自动构建夹具源库，覆盖检索 / 热词 / 重建 / 互斥 / 幂等续跑 / 旧库升级（Node 与 Bun 均可跑） |
| `boot.mjs` | 在空闲端口启动真实服务并走 HTTP，覆盖 `index.js` 的接线（索引库切换后搜索池恢复、SSE 快照的「下次同步」来源） |
| `reset.mjs` | 重置脚本的安全属性：默认不删源库、删源库必须 `--yes`、`--dry-run` 不落盘、误配置拦截 |
| `verify-driver.mjs` | 自动探测当前运行时，校验驱动方法与 FTS5 特性 |
| `bench:fts` | 对比 FTS5 建表参数（detail / columnsize / 索引文本形态）对体积与相关性的影响 |
| `bench:index` | 用确定性合成数据把各调参变体跑成对比表（耗时 / 峰值内存 / 分段明细） |

## 运维要点

- **启动**：服务先监听端口，索引同步在后台执行，启动即响应。
- **手动重建 / 同步**：Web 端「设置」面板，或 `POST /api/reindex`、`POST /api/sync`。重建期间页面与检索不受影响，完成后原子切换；构建失败只丢弃影子文件。
- **磁盘预留**：重建期禁用 WAL 自动 checkpoint，WAL 会增长到接近索引体积、结束时一次性回写，建议预留约 2 倍索引体积的磁盘空间。
- **分段耗时**：每次重建（及确有补录的增量同步）结束会打印一行阶段明细（`schema / scan / fts / docs / txn / js / index / merge / checkpoint`），口径见 `src/index/timing.js`。
- **版本升级**：索引格式变更时，打开旧索引库会自动补齐缺失列（旧库仍可回答查询，新字段取默认值）；启动检测到格式过期会无视 `SYNC_ON_START` 在后台跑一次全量重建，期间线上一直用旧索引服务。回退旧版本同样安全（旧代码会重建回旧格式）。
- **重置应用**：`npm run reset` 删除索引库及其衍生文件——索引库本体、构建中的影子库（`.build`）、切换备份（`.old`）以及各自的 WAL / SHM。索引可再生，下次启动会自动重建（全量灌入）。**源库默认不动**（爬取数据删了无法恢复），确需一并删除时用 `npm run reset -- --source --yes`（缺 `--yes` 会拒绝执行）。`--dry-run` 先看清单，`--tests` 顺带清空 `test/data` 夹具。服务运行中执行会因文件占用失败，请先停止服务。
- **调参**：批大小、重建期 PRAGMA、排序线程集中在 `src/index/tuning.js`，各项均支持环境变量临时覆盖（仅供压测）；`npm run bench:index` 可在本机复现对比。FTS 合并策略：重建做一次 `optimize`，增量按累计行数阈值做部分 `merge`。

## RPC 推送（aria2 / Motrix）

结果卡片的「推送」按钮将磁力链接经 JSON-RPC 2.0 的 `aria2.addUri` 发送到下载器，地址与密钥在「设置」中配置（存于浏览器 `localStorage`）：

- 地址默认 `http://localhost:16800/jsonrpc`；
- 密钥可选，填写后按 aria2 约定在 `params` 头部加 `token:<密钥>`。

推送结果以页面 toast 提示（成功显示任务 GID）。浏览器跨域请求下载器 RPC 端口需下载器允许跨域：

```bash
aria2c --enable-rpc --rpc-listen-all --rpc-allow-origin-all
```

Motrix 在设置中勾选「允许来自所有来源的请求」即可。

## exe 版使用指南（零基础向）

> 本章面向拿到压缩包的最终用户：无需安装任何运行环境。

### 1. 准备工作

- 一台 Windows 电脑（Windows 10 / 11、Server 2016+）；
- 一个名为 `magnet.db` 的磁力数据库文件（由 DHT 采集程序生成，本软件只负责搜索）。

### 2. 目录结构

解压到任意位置（建议路径不含中文与空格，如 `D:\DHT-Search\`）：

```
DHT-Search\
├── DHT-Search.exe   ← 主程序，双击启动
├── config.js        ← 配置文件，记事本即可编辑
├── README.md        ← 本说明
├── public\          ← 网页界面文件（不要改动）
└── data\            ← 数据目录
    └── magnet.db    ← 磁力数据库文件
```

| 文件 | 是什么 | 能否删除 |
|------|--------|----------|
| `magnet.db` | 原始数据 | 不能删 |
| `dht.search.db`（及 `.db-wal` / `.db-shm`） | 程序自动生成的搜索索引 | 可以删，下次启动自动重建 |

> 安装包不含 `data` 目录与数据库文件（属个人数据，不随软件分发）。缺失时程序启动会自动创建。

### 3. 放入数据库

1. 找到采集程序输出的 `magnet.db`；
2. 复制到软件的 `data` 目录（没有该目录就在 DHT-Search 下新建，名称必须是 `data`）；
3. 确认文件名正好是 `magnet.db`（`magnet(1).db`、`magnet.db.crdownload` 等需重命名）；
4. 不想复制的话，也可让它留在原地并修改 `SOURCE_DB_PATH`（见第 6 节）。

### 4. 启动程序

1. 双击 `DHT-Search.exe`，会弹出一个命令行窗口并滚动显示日志，**使用期间不要关闭**（可最小化）；
2. 首次启动会自动建立索引：数据量小需几秒到几分钟，上百万条可能需十几分钟到几十分钟。期间网页可打开，但搜索结果不全、计数偏小属正常，窗口内可看到 `已索引 N 行` 进度；
3. 退出程序：直接关闭该窗口。

> 若把 `dht.search.db` 一并分发，首次启动会直接加载现成索引，几秒即可用。

### 5. 打开搜索网页

- 本机：浏览器访问 `http://localhost:3000`；
- 局域网其他设备：访问 `http://<这台电脑的IP>:3000`（IP 可用 `ipconfig` 查看 IPv4 地址）；
- 默认只允许本机与内网设备访问，局域网内无需额外设置。

### 6. 修改配置（可选）

用记事本编辑 `config.js`，保存后重启程序生效：

| 想改什么 | 配置项 | 示例 |
|----------|--------|------|
| 服务端口 | `PORT` | `export const PORT = 8080;` |
| 数据库位置 | `SOURCE_DB_PATH` | `export const SOURCE_DB_PATH = 'D:/我的数据库/magnet.db';`（路径用 `/`） |
| 放行更多设备 | `ALLOWED_CLIENTS` | 在方括号内按同样格式加一行 `'192.168.1.100',` |
| 关闭 IP 白名单 | `ACCESS_CONTROL_MODE` | 改成 `'off'`（公网环境请勿关闭） |
| 定时增量同步 | `SYNC_CRON` | cron 表达式，如每天 03:00 填 `'0 3 * * *'`；留空表示关闭 |

注意：每行格式为 `export const 名字 = 值;`，只改等号后的值；改坏可删除 `config.js` 重启恢复出厂默认；程序读取的是 exe 旁的那一份。

### 7. 日常维护

- **有新增数据**：启动时会自动补录一次；可配置 `SYNC_CRON` 定时补录，或在网页「设置」中手动点「同步」；源库中已有行的修改 / 删除需点「重建索引」全量刷新。
- **备份**：复制整个文件夹即可。`dht.search.db` 是索引缓存可不备份，`magnet.db` 是原始数据必须保留。
- **升级**：用新的 `DHT-Search.exe` 覆盖旧文件，`data` 目录不动。
- **迁移**：整个文件夹拷贝到新机器即可继续使用。

### 8. 常见问题

| 现象 | 处理 |
|------|------|
| 双击后窗口一闪而过 | 多数是 `data` 里缺 `magnet.db` 或文件名 / 格式不对，重开并看清红色报错 |
| 网页 403 / 拒绝访问 | 设备 IP 不在白名单：编辑 `ALLOWED_CLIENTS` 加入该 IP 后重启 |
| 网页打不开（连接被拒绝） | 程序未启动成功，或端口被占用：改 `PORT` 后重试 |
| 结果不全 / 计数偏小 | 索引尚未建完或同步进行中，等待进度结束 |
| 搜索一直转圈 | 确认程序仍在运行、索引已建完；必要时点「重建索引」 |
| 想让外网访问 | 路由器做端口映射并把对方公网 IP 加入 `ALLOWED_CLIENTS`；不建议关闭白名单直接暴露公网 |
| 窗口出现红色错误 | 记录报错文字，对照本文档检查配置后反馈 |

## 数据来源与开源致谢

本项目的磁力数据来自开源项目 [p2pspider](https://github.com/thejordanprice/p2pspider)（基于 Node.js 的 BitTorrent DHT 爬虫，MIT License）的抓取产出：

- 本项目不包含 p2pspider 的任何代码，仅消费其产出的数据库文件（`data/magnet.db`）；
- 本项目及发布包不分发任何抓取数据（`data/` 需使用者自行准备）。

感谢 [thejordanprice](https://github.com/thejordanprice) 及开源社区的工作。

## 免责声明与开源协议

### 免责声明

- 本项目仅对 DHT 网络中公开广播的资源元数据（磁力链接、文件名、文件大小等）建立索引，不存储、不提供、不托管任何内容文件本身；
- 抓取结果可能包含敏感、违法违规或受版权保护的内容索引，使用者应遵守所在国家 / 地区的法律法规，不得用于侵犯他人合法权益的用途；
- 本项目按「现状」提供，不含任何明示或默示担保，使用风险由使用者自行承担。

### 开源协议

本项目以 [MIT License](./LICENSE) 发布：可免费使用、复制、修改、合并、发布、分发，惟须保留原版权声明与许可声明。依赖（express / drizzle-orm / better-sqlite3 / lru-cache / chalk 等）均为宽松协议，无 copyleft 传染问题。
