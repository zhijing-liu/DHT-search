# DHT Search

基于 **SQLite FTS5 全文检索**的磁力链接（magnet / torrent）搜索引擎，配套一个 Vite + Tailwind 构建的检索界面。

## 一、项目简介

DHT Search 把一个由外部程序（如 DHT 爬虫）持续写入的「源库」（`data/magnet.db`，内含 `magnets` 表）中的磁力资源，构建成一份高性能的**影子索引**（FTS5 倒排索引 + 去规范化副本），并通过 HTTP 提供：

- 关键词全文模糊搜索（前缀匹配、大小写/变音折叠）
- infohash 精确检索（含前缀匹配）
- 按抓取时间 / 体积 / 相关度排序
- 体积区间过滤、真服务端分页
- 热门关键词榜与「噪声词」过滤（黑名单导入 / 导出）
- 种子文件树展示、结果高亮、剪贴板复制磁力链接
- 输入联想（基于热词的模糊相似匹配）
- 运行状态监测（设置面板，SSE 实时推送缓存 / 内存 / 进程数 / 同步与重建进度）
- 接入层访问控制（IP / 网段白名单）

项目**不包含** DHT 爬虫本身——它只负责消费已存在的源库数据并提供检索服务。

## 二、核心架构

### 影子索引（Shadow Index）
源库（由外部写入，可能随时被别的进程写）在查询期**完全不触碰**；所有检索都打在另一份可写的索引库（默认 `data/dht.search.db`）上：

| 库 | 文件 | 角色 | 访问方式 |
|----|------|------|----------|
| 源库 | `data/magnet.db` | 外部爬虫写入的原始数据 | 仅在构建/同步索引时**只读**打开 |
| 索引库 | `data/dht.search.db` | FTS5 索引 + 副本 + 同步水位 + 热词 | 查询只命中这里 |

索引库内含 4 类对象：
- `magnets_fts`：contentless FTS5 虚表（只索引 `name` / `files` 文本）
- `magnets_docs`：`magnets` 的去规范化副本（id + 展示/排序所需列），供检索 JOIN
- `sync_meta`：同步水位（`tokenizer` / `last_rowid`）
- `keyword_stats` / `keyword_filter`：热词统计与噪声词过滤表

### 同步策略
- 启动时与运行期（默认每小时，`SYNC_INTERVAL_MS`）都按 `last_rowid` **增量补录**新增行，**均在后台执行**，不阻塞服务启动与请求；
- 源库中对已有行的 UPDATE / DELETE 不会自动反映，需手动触发 `POST /api/reindex` 全量重建（重建 JOIN 会自动丢弃源中已删除的残留行）；tokenizer 变更等结构性变更同样交由手动重建处理。

### 双运行时（Node / Bun）
`src/db-driver.js` 在运行时靠 `typeof Bun` 自动选择驱动，业务代码无需关心：

| 运行时 | 驱动 | 索引维护（重建 / 同步）执行方式 |
|--------|------|------------------|
| Node | `better-sqlite3` + `drizzle-orm/better-sqlite3` | 独立 **worker 线程**（可设堆上限，OOM 只杀 worker，主进程不受影响） |
| Bun | `bun:sqlite` + `drizzle-orm/bun-sqlite` | 独立 **子进程**（Bun 对 `node:worker_threads` 覆盖不全；`REINDEX_MAX_OLD_SPACE_MB` 不适用，堆由操作系统兜底） |

两种方式均为**主进程零阻塞**：重建 / 大批量同步是一连串同步的 SQLite 原生调用，若放在主进程会把事件循环整个卡死（页面与检索全部无响应），因此统一丢到独立线程 / 进程执行，进度与结果经统一的消息协议回传（见 `src/reindex-worker.js`）。

### 搜索执行模型（按需子进程）
检索放在**独立子进程**中执行——不是为了并发能力，而是为了「客户端断开即停」：
`better-sqlite3` / `bun:sqlite` 都是同步 API，一条查询会把执行单元阻塞在 C++ 里，
而 `worker.terminate()` 的终止标志要等执行权回到 JS 才被检查，卡在原生调用里的
查询根本收不到信号（实测：Node 下 terminate 到退出 23328ms，Bun 下 6s 后仍存活）。
只有操作系统级的 `SIGKILL` 能真正中断，而线程无法被 OS 单独杀掉——所以执行单元
只能是进程。

进程是**按需 fork** 的，而非常驻：

| 时机 | 行为 |
|------|------|
| 服务启动 | **0 个**进程，不占额外内存 |
| 查询到来 | 复用空闲进程；没有且未达 `SEARCH_MAX_PROCESSES` 才 fork |
| 进程全忙 | 新查询进等待队列（FIFO），不新建进程 |
| 客户端断开 | `SIGKILL` 该进程并移除（**不补位**），下次查询按需再 fork |
| 空闲超时 | 超过 `SEARCH_PROCESS_IDLE_MS` 后回收，进程数回到 0 |

取消能力分两级，完整覆盖：**排队中** → 从队列直接移除（零成本）；**已派发** →
`SIGKILL` 真正中断正在执行的同步查询。

> 注：检索是分页的（单次 ≤ `MAX_LIMIT` 200 条），单个进程的内存需求很低，
> 子进程的 PRAGMA 已按此调优（`cache_size = -2048`、`mmap_size = 32MB`）。
> 进程内存的大头是运行时基线本身（Bun ~60-120MB），因此降低内存的主要手段是
> **减少进程数**，而不是压 PRAGMA。

### 前端（`web/`，Vite + Tailwind）
前端源码在 `web/src/`（原生 ES Module + 自定义元素 + Tailwind CSS），
`npm run build:web` 后产物输出到仓库根的 `public/`，由后端 `express.static` 直接托管。
开发期可用 `npm run dev:web` 启动 Vite dev server，`/api` 请求自动代理到后端（端口读自 `config.js`）。
部署在 nginx 等反代子路径时，用 `WEB_BASE_PATH` 控制构建产物的资源引用前缀。

## 三、项目结构

```
DHT-search/
├── index.js                   # Express 入口：HTTP API + 静态资源 + 搜索缓存/定时同步/运行状态 SSE
├── app-entry.cjs              # pm2 入口包装器（CJS require → 动态 import ESM 的 index.js）
├── config.js                  # 运行期配置（ESM 模块，支持注释；每项独立 export const）
├── ecosystem.config.node.json # pm2 配置：Node 运行时
├── ecosystem.config.bun.json  # pm2 配置：Bun 运行时
├── bunfig.toml                # Bun 安装配置（跳过 better-sqlite3 原生模块）
├── package.json
├── src/
│   ├── db.js                  # 数据访问核心：索引维护、搜索、热词、重建（对外主入口）
│   ├── db-driver.js           # 统一 SQLite 驱动适配层（Node/Bun 自动切换，抹平差异）
│   ├── store.js               # 全局配置聚合与共享约定（CONFIG、库路径、表名、排序白名单）
│   ├── schema.js              # drizzle 表定义（magnets_docs / sync_meta，用于查询构造器）
│   ├── reindex-worker.js      # 索引维护执行体（双模式：Node worker 线程 / Bun 子进程）
│   ├── searchPool.js          # 搜索子进程池（按需 fork + 有界并发 + 等待队列）
│   ├── search-child.mjs       # 搜索子进程入口（只读打开索引库执行检索）
│   ├── accessControl.js       # 接入层访问控制（IP / 网段白名单）
│   ├── stats.js               # 运行时状态（缓存命中 / 内存 / 进程数 / 同步与重建进度）
│   ├── logger.js              # 带着色的分级日志
│   └── util.js                # 共享纯函数（clampInt / normalizeKeyword 等）
├── scripts/                   # 运维 / 种子脚本（纯 Node 脚本，非运行时依赖）
│   ├── seed-filter.mjs        # 热词噪声词种子：读 hot-filter-words.txt 入库（幂等）
│   ├── hot-filter-words.txt   # 噪声词清单（每行一词，# 开头为注释）
│   ├── dump-keywords.mjs      # 导出未黑名单化热词（纯 ASCII，按 doc_count 降序）供审阅
│   ├── filter-common-en.mjs   # 自动筛选宽泛英语热词候选，写入 hot-filter-en.auto.txt 供人工审阅
│   └── spike/                 # 试验性脚本草稿
├── web/                       # 前端源码（Vite + Tailwind，需构建）
│   ├── index.html
│   ├── vite.config.js         # 产物输出 ../public；dev 期 /api 代理到后端
│   ├── package.json
│   └── src/
│       ├── main.js            # 主逻辑：搜索/分页/排序/热词/联想/URL 同步/重建/设置面板
│       ├── components.js      # 自定义元素：结果卡片 / 文件树 / 排序控件等
│       ├── file-tree.js       # 由扁平 [{path,size}] 构建可折叠目录树
│       ├── util.js            # 共享纯函数（格式化、复制、高亮、RPC 推送等）
│       └── styles/app.css     # Tailwind 入口与全局样式
├── public/                    # 前端构建产物（npm run build:web 生成，后端静态托管）
├── test/
│   ├── smoke.mjs              # 端到端冒烟测试（自动生成夹具源库，Node / Bun 均可跑）
│   ├── verify-driver.mjs      # 驱动层可行性验证（PRAGMA/WAL/事务/FTS5 等）
│   ├── access-control.mjs     # 访问控制（白名单 / 反代）测试
│   └── data/                  # 测试夹具库
└── data/                      # 运行时数据（源库与索引库；通常不入库，可加 .gitignore）
```

## 四、功能特性

- **全文搜索**：对 `name` / `files` 两列做 FTS5 模糊检索，末位 token 前缀匹配，unicode61 大小写/变音折叠。
- **infohash 精确检索**：输入 40 位 hex（或带 `urn:btih:` / `hash` 前缀）时自动切换为精确 + 前缀匹配，不经 FTS 索引。
- **排序**：`fetchedAt`（抓取时间）、`totalSize`（体积）、`relevance`（bm25 相关度）；未指定则按 id。
- **体积过滤**：按字节区间过滤（前端以 MB 输入）。
- **真服务端分页**：每次查询/翻页/排序都按页从后端拉取，`total` 与结果始终一致。
- **热门关键词榜**：构建索引时统计 `name` 中的合格 token（去单字、去纯数字、去噪声词），按文档频率降序。
- **热词过滤词（黑名单）**：用户可维护噪声词清单（经种子脚本 / API / Web 界面导入导出），从热词榜与统计中剔除。
- **输入联想**：基于热词的「完全相等 > 前缀 > 包含 > 模糊（Levenshtein）」分级匹配。
- **搜索缓存**：进程内 LRU 缓存，存序列化后的 JSON 字符串（命中时直接回写，零 stringify），按字节数限内存、按 TTL 过期（默认 32MB / 1h）。整集拉取（`limit=all`）的结果不进缓存。
- **在线重建与后台同步**：全量重建在独立 worker 线程（Node）或子进程（Bun）执行，**主进程零阻塞，重建期间页面与检索全程可用**；运行期按 `SYNC_INTERVAL_MS` 自动增量补录，启动同步也在后台执行，服务秒级可用。
- **运行状态监测**：设置面板经 SSE（`/api/stats/stream`）每 3 秒推送缓存命中、堆内存、搜索进程数、已索引总数、下次同步倒计时与重建/同步进度。
- **访问控制**：接入层 IP / 网段白名单（CIDR），整站（页面 + API + 写接口）统一把关，支持反代场景。
- **RPC 推送**：结果卡片「推送」按钮可将磁力链接经 JSON-RPC 2.0（`aria2.addUri`）推送到 aria2 / Motrix 下载器；地址与密钥在「设置」中配置，密钥按 aria2 约定以 `token:` 前缀发送。

## 五、配置项（`config.js`）

所有项均已在 `config.js` 中给出默认值并附注释；直接修改对应 `export const` 即可，重启服务生效。路径类配置支持相对路径（基于项目根）或绝对路径。

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `SOURCE_DB_PATH` | `data/magnet.db` | 源库路径（含 `magnets` 表） |
| `INDEX_DB_PATH` | `data/dht.search.db` | 影子索引库路径 |
| `PORT` | `3000` | HTTP 服务端口 |
| `WEB_BASE_PATH` | `''` | 前端构建产物的部署前缀：空 = 站点根；`/dht` 适合反代子路径部署。仅影响 `npm run build:web` 的产物，改后需重新构建 |
| `MAX_RESULTS` | `2000` | 「整集拉取」（`limit=all`）单次返回上限，超出标记 `truncated` |
| `REINDEX_MAX_OLD_SPACE_MB` | `2048` | Node 下重建 worker 线程的堆上限（MB），触顶只杀 worker；Bun 走子进程，本项不适用 |
| `REINDEX_TIMEOUT_MS` | `0` | 重建超时（ms），`0` 表示不限制；超时终止 worker / 杀掉子进程，主进程不受影响 |
| `SEARCH_CACHE_MAX_SIZE_MB` | `32` | 搜索缓存最大占用内存（MB）；缓存存序列化后的 JSON 字符串，故该值 ≈ 实际堆占用 |
| `SEARCH_CACHE_TTL_MS` | `3600000` | 搜索缓存 TTL（ms，默认 1 小时） |
| `SEARCH_MAX_PROCESSES` | `2` | 最大并发搜索进程数（按需 fork，服务启动时常驻 0 个） |
| `SEARCH_PROCESS_CACHE_SIZE_KB` | `2048` | 每个搜索子进程的 SQLite page cache（KiB）——**每进程一份**的私有内存，总额 = 本值 × `SEARCH_MAX_PROCESSES` |
| `SEARCH_PROCESS_MMAP_SIZE_MB` | `32` | 每个搜索子进程的 mmap 窗口（MB）——映射共享 clean page，多进程读同一库不重复占用，可给相对大的值；`0` 关闭 |
| `SEARCH_PROCESS_RECYCLE_IMMEDIATE` | `false` | 查询完成**立即回收**进程；`true` 时空闲恒为 0 个进程，但每次查询都要重付 fork 冷启动（约 1s） |
| `SEARCH_PROCESS_IDLE_MS` | `60000` | 搜索进程空闲多久后回收（ms），空闲足够久后进程数回到 0；`0` 关闭回收。**仅在 `SEARCH_PROCESS_RECYCLE_IMMEDIATE = false` 时生效** |
| `SEARCH_QUEUE_MAX` | `16` | 搜索等待队列上限：进程全忙时新查询排队，超出快速失败 |
| `SEARCH_QUEUE_TIMEOUT_MS` | `10000` | 排队超时（ms），超时快速失败；`0` 不限时 |
| `SYNC_INTERVAL_MS` | `3600000` | 运行期自动增量同步间隔（ms，默认 1 小时；`0` 关闭） |
| `ACCESS_CONTROL_MODE` | `'ip-whitelist'` | 访问控制模式：`'ip-whitelist'` 仅放行 `ALLOWED_CLIENTS` 中的 IP / 网段，其余 403；`'off'` 关闭（兼容纯本机 / 反代鉴权）。**默认开启** |
| `ALLOWED_CLIENTS` | 见下 | 允许访问的客户端地址清单（仅 `ip-whitelist` 模式生效）：支持精确 IPv4/IPv6 与 CIDR（如 `192.168.0.0/16`、`2001:db8::/32`）。默认含 `127.0.0.1`、`::1` 及 `10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`fc00::/7`、`fe80::/10` 等内网 / 本机范围 |
| `TRUST_PROXY` | `false` | 是否信任前置反代（nginx 等）的 `X-Forwarded-For` 来取真实客户端 IP：`false`（默认）取 TCP 对端，适合直连；反代场景需设为 `true` / `'loopback'` / 具体子网，否则白名单会误判 |

路径解析优先级：**显式参数 > config.js > 模块默认值**（config.js 的值恒非空，服务代码不读取 `DHT_DB_PATH` / `DHT_INDEX_DB_PATH` 环境变量；`scripts/` 下的脚本仍直接读取 `DHT_INDEX_DB_PATH`）。

## 六、安装与前置条件

1. **源库前置**：`data/magnet.db` 必须存在且包含 `magnets` 表（由外部 DHT 爬虫写入）。不存在或表缺失时启动会报错。
2. **运行时**（二选一）：
   - **Node**：需 `better-sqlite3`（C++ 原生模块，`npm install` 会自动尝试预编译/本地编译）。要求 Node ≥ 14.8（支持顶层 await）。
   - **Bun**：`bun:sqlite` 内置，无需原生编译。仓库根的 `bunfig.toml` 已配置
     `[install] optional = false`，`bun install` 会自动跳过 `optionalDependencies` 里的
     `better-sqlite3`，无需手工处理；Node 用户用 `npm install` 不受影响，仍会正常装入。
3. 安装依赖：
   ```bash
   npm install                 # Node 路径（会正常安装 better-sqlite3）
   # 或
   bun install                 # Bun 路径（bunfig.toml 已跳过 better-sqlite3）
   ```
4. 构建前端（首次部署需执行一次；产物已存在时可跳过）：
   ```bash
   npm run build:web           # web/ → public/（Vite + Tailwind）
   ```

## 七、启动

> **首次启动**：服务会先监听端口、立即可访问，索引在后台异步构建（源库已有索引时为增量补录，全新索引库为全量灌入）。数据量大时后台构建可能持续几分钟到几十分钟，**期间检索结果不全、计数偏小属正常**，设置面板的运行状态可观察进度，构建完成后自动恢复。

### 前端开发模式（可选）
```bash
npm run dev:web      # Vite dev server，/api 自动代理到后端端口
```

### 普通启动
```bash
npm start            # Node：node index.js
# 或
bun index.js         # Bun
```
开发期热重载：
```bash
npm run dev:node     # nodemon index.js
npm run dev:bun      # bun --watch index.js
```
启动后访问 `http://localhost:<port>`（默认 3000）。

### 用 pm2 启动（分别两个配置）
项目提供两份独立 pm2 配置，可分别调用（避免写在一起）。pm2 经 `app-entry.cjs` 包装加载 ESM 入口：

```bash
# Node 实例
pm2 start ecosystem.config.node.json
# 或
npm run start:pm2:node

# Bun 实例（需 bun 在 PATH 中）
pm2 start ecosystem.config.bun.json
# 或
npm run start:pm2:bun
```

两份配置都不在 pm2 中硬编码端口，统一读取 `config.js` 的 `PORT`（默认 3000）。
若想同机并存做回归对比，需让两个实例监听不同端口——可在启动前用环境变量区分，例如：
`PORT=3001 pm2 start ecosystem.config.bun.json`，或各自指向不同的 `config.js`。

常用 pm2 命令：
```bash
npm run stop:pm2      # 停止两个实例
npm run logs:pm2      # 查看日志
pm2 restart <name>    # 重启单个实例
pm2 delete  <name>    # 删除
```

## 八、HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 重定向到 `/index.html` |
| GET | `/index.html`、 `/public/*` | 前端静态资源（构建产物） |
| GET | `/api/search` | 搜索（见下） |
| GET | `/api/count` | 已索引条数 `{ count }`（读内存缓存，不扫表） |
| GET | `/api/hot?limit=` | 热词榜 `{ items: [{term,doc_count,occurrences}] }` |
| GET | `/api/hot/filter` | 热词过滤词列表 |
| POST | `/api/hot/filter` | 新增过滤词，body `{ term }` |
| DELETE | `/api/hot/filter?term=` | 删除过滤词 |
| GET | `/api/hot/filter/export` | 导出热词过滤词为纯文本文件（附件下载，每行一词，含 `#` 头注释） |
| POST | `/api/hot/filter/import` | 批量导入过滤词，body `{ terms: string[] }`，返回 `{ ok, accepted, total }` |
| POST | `/api/reindex` | 全量重建索引（后台 worker 线程 / 子进程执行），返回 `{ ok, indexed }` |
| POST | `/api/sync` | 手动增量同步（按 `last_rowid` 补录新增行），返回 `{ ok, skipped, added }` |
| GET | `/api/stats/stream` | 运行状态 SSE 流（设置面板订阅），每 3 秒推送缓存 / 内存 / 进程数 / 进度等快照 |

### `GET /api/search` 参数
| 参数 | 说明 |
|------|------|
| `q` | 必填，搜索关键词（至少一个字母/数字） |
| `sortBy` | `fetchedAt` / `totalSize` / `relevance`；其他值忽略（按 id 排序） |
| `order` | `asc` / `desc`，默认 `desc`，仅 `sortBy` 传入时生效 |
| `limit` | 每页条数（钳制 1..200，缺省 20）；**仅 `all` 表示整集拉取**，`0` / 负数 / 非数值一律按分页处理 |
| `offset` | 分页偏移 |
| `minSize` / `maxSize` | 体积区间（字节）过滤 |
| `by` | `hash` 时按 infohash 精确检索（其余走 FTS5 模糊） |

返回：`{ total, limit, offset, items: [{ id, name, infohash, magnet, files, totalSize, fetchedAt }], truncated? }`
（`files` 为已解析的 `[{ path, size }]` 数组；整集拉取超出 `MAX_RESULTS` 时带 `truncated: true`。）

客户端中途断开（关页面 / 前端发起新搜索取消旧请求）时，服务端会立即取消对应检索（排队中直接移除、执行中 `SIGKILL` 子进程），不写缓存、不响应。

## 九、热词过滤词（黑名单）维护

热词过滤词（噪声词）从热词榜与统计中剔除，维护方式有三种：

### 1. 种子脚本（`scripts/`）
`scripts/hot-filter-words.txt` 每行一个噪声词（`#` 开头为注释），批量写入 `keyword_filter` 表（幂等，可重复运行）：

```bash
npm run seed:filter          # 读 scripts/hot-filter-words.txt 入库
```

辅助脚本（不自动入库，仅供人工 / AI 审阅挑选）：
- `scripts/dump-keywords.mjs`：导出「未黑名单化、纯 ASCII」热词（按 `doc_count` 降序）到 `scripts/hot-keywords-dump.txt`。
- `scripts/filter-common-en.mjs`：自动筛选宽泛英语热词候选，写入 `scripts/hot-filter-en.auto.txt`（含命中原因注释）。

### 2. HTTP API 增删 / 批量导入导出
```bash
# 单条增删
curl -X POST localhost:3000/api/hot/filter -H 'content-type: application/json' -d '{"term":"foo"}'
curl -X DELETE 'localhost:3000/api/hot/filter?term=foo'

# 批量导入：terms 为字符串数组（每行一词）；空行 / # 注释 / 纯符号行会被忽略，幂等
curl -X POST localhost:3000/api/hot/filter/import \
  -H 'content-type: application/json' \
  -d '{"terms":["foo","bar"]}'
# 返回 {"ok":true,"accepted":2,"total":N}

# 导出：返回 text/plain 附件（文件名 hot-filter-export.txt），可保存后再次导入
curl -L localhost:3000/api/hot/filter/export -o hot-filter-export.txt
```
导入 / 导出文件格式一致：每行一个词，`#` 开头为注释，支持「导出 → 编辑 → 回灌」工作流。

### 3. Web 界面（黑名单面板）
界面「黑名单」面板标题栏提供 **导入 / 导出** 两个图标按钮：
- **导出**：浏览器直接下载当前黑名单为 `.txt`。
- **导入**：选择 `.txt`（每行一词，支持 `#` 注释），批量写入并即时刷新热词榜。

## 十、测试

```bash
npm test                 # 端到端冒烟测试（test/smoke.mjs，自动生成夹具数据）
npm run test:access      # 访问控制测试（test/access-control.mjs）
npm run verify:driver    # 驱动层可行性验证（test/verify-driver.mjs）
npm run smoke            # 同 test（别名）
```
`verify-driver.mjs` 会自动探测当前运行时（Node / Bun），逐一校验驱动方法与 FTS5 特性；`smoke.mjs` 自动构建夹具源库并覆盖检索 / 热词 / 重建 / 互斥 / 错误传播等场景，Node 与 Bun 下均可运行。

## 十一、运维要点

- **启动**：服务先监听端口，索引同步在后台执行（日志打印 `[index] 已索引 N 行`）；启动即响应，无需等待索引完成。
- **手动重建**：Web 端「设置 → 重建索引」，或 `POST /api/reindex`。重建在独立 worker 线程（Node）/ 子进程（Bun）执行，**期间页面与检索全程可用**（重建中检索结果可能暂时不全，属在线重建的固有代价）；手动同步用 `POST /api/sync`。
- **增量同步**：默认每小时按 `last_rowid` 补录源库新增行（`SYNC_INTERVAL_MS` 配 `0` 可关闭）；重建期间自动跳过，下一周期再试。
- **性能调优**：重建/查询期的 SQLite PRAGMA（WAL、cache_size、mmap_size、temp_store 等）已在 `db.js` 中按场景预设，一般无需改动；超大索引如需降低 `optimize` 内存峰值，可在 `optimizeFts()` 处改回分步合并。

## 十二、RPC 推送（aria2 / Motrix）

结果卡片在「迅雷下载」按钮右侧提供一个 **推送** 图标按钮，点击即把当前磁力链接经 JSON-RPC 2.0 的 `aria2.addUri` 推送到本地下载器。地址与密钥在 **设置** 弹窗中配置：

- **地址**：默认 `http://localhost:16800/jsonrpc`
- **密钥**：可选；填写后按 aria2 约定在请求 `params` 头部加 `token:<密钥>`（留空表示无密钥）

配置存于浏览器 `localStorage`，刷新后保留。推送结果以页面 toast 提示（成功显示任务 GID，失败显示错误信息）。

### 前置条件：下载器需开启 JSON-RPC 并允许跨域
浏览器从搜索站点（如 `localhost:3000`）跨域 `fetch` 下载器的 RPC 端口会受 CORS 限制，下载器启动需允许跨域：

```bash
aria2c --enable-rpc --rpc-listen-all --rpc-allow-origin-all
```

Motrix 在设置中勾选「允许来自所有来源的请求」即可。未开启跨域时推送会报网络错误。
