# DHT Search

基于 **SQLite FTS5 全文检索**的磁力链接（magnet / torrent）搜索引擎，配套一个零依赖的纯前端检索界面。

## 一、项目简介

DHT Search 把一个由外部程序（如 DHT 爬虫）持续写入的「源库」（`data/magnet.db`，内含 `magnets` 表）中的磁力资源，构建成一份高性能的**影子索引**（FTS5 倒排索引 + 去规范化副本），并通过 HTTP 提供：

- 关键词全文模糊搜索（前缀匹配、大小写/变音折叠）
- infohash 精确检索（含前缀匹配）
- 按抓取时间 / 体积 / 相关度排序
- 体积区间过滤、分页
- 热门关键词榜与「噪声词」过滤
- 种子文件树展示、结果高亮、剪贴板复制磁力链接
- 输入联想（基于热词的模糊相似匹配）

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
- 启动时按 `last_rowid` **增量补录**新增行；
- `tokenizer` 变更或索引为空 → **全量重建**；
- 源库中对已有行的 UPDATE / DELETE 不会自动反映，需调用 `reindex()` 全量重建（JOIN 会自动丢弃源中已删除的残留行）。

### 双运行时（Node / Bun）
`src/db-driver.js` 在运行时靠 `typeof Bun` 自动选择驱动，业务代码无需关心：

| 运行时 | 驱动 | 全文索引重建方式 |
|--------|------|------------------|
| Node | `better-sqlite3` + `drizzle-orm/better-sqlite3` | 独立 **worker 线程**（OOM 只杀 worker，主进程不受影响） |
| Bun | `bun:sqlite` + `drizzle-orm/bun-sqlite` | 同进程同步（仍保持 Promise 形态） |

## 三、项目结构

```
DHT-search/
├── index.js                  # Express 入口：HTTP API + 静态资源 + 缓存/定时同步
├── config.json               # 运行期配置（缺失/非法不阻塞启动，回退默认）
├── ecosystem.config.node.json # pm2 配置：Node 运行时
├── ecosystem.config.bun.json  # pm2 配置：Bun 运行时
├── package.json
├── src/
│   ├── db.js                 # 数据访问核心：索引维护、搜索、热词、重建（对外主入口）
│   ├── db-driver.js          # 统一 SQLite 驱动适配层（Node/Bun 自动切换，抹平差异）
│   ├── store.js              # 全局配置与共享约定（CONFIG、库路径、表名、排序白名单）
│   ├── schema.js             # drizzle 表定义（magnets_docs / sync_meta，用于查询构造器）
│   └── reindex-worker.js     # Node 下全量重建的 worker 线程脚本
├── scripts/                  # 运维 / 种子脚本（纯 Node 脚本，非运行时依赖）
│   ├── seed-filter.mjs       # 热词噪声词种子：读 hot-filter-words.txt 入库（幂等）
│   ├── hot-filter-words.txt  # 噪声词清单（每行一词，# 开头为注释）
│   ├── dump-keywords.mjs     # 导出未黑名单化热词（纯 ASCII，按 doc_count 降序）供审阅
│   └── filter-common-en.mjs  # 自动筛选宽泛英语热词候选，写入 hot-filter-en.auto.txt 供人工审阅
├── public/                   # 前端（原生 ES Module，无构建步骤）
│   ├── index.html
│   ├── css/
│   │   ├── styles.css        # 全局样式
│   │   ├── magnet-card.css   # <magnet-card> 组件样式
│   │   ├── magnet-files.css  # <magnet-files> 文件树样式
│   │   ├── result-list.css   # <result-list> 样式
│   │   └── dht-sort-group.css# <dht-sort-group> 排序控件样式
│   └── js/
│       ├── app.js            # 主逻辑：搜索/分页/排序/热词/联想/URL 同步/重建
│       ├── components.js     # 自定义元素：<magnet-card> / <magnet-files> / <result-list> / <dht-sort-group>
│       ├── file-tree.js      # 由扁平 [{path,size}] 构建可折叠目录树
│       └── util.js           # 共享纯函数（格式化、复制、高亮等）
├── test/
│   ├── smoke.mjs             # 端到端冒烟测试（依赖已索引的源库）
│   └── verify-driver.mjs     # 驱动层可行性验证（PRAGMA/WAL/事务/FTS5 等）
└── data/                     # 运行时数据（源库与索引库；通常不入库，可加 .gitignore）
```

## 四、功能特性

- **全文搜索**：对 `name` / `files` 两列做 FTS5 模糊检索，末位 token 前缀匹配，unicode61 大小写/变音折叠。
- **infohash 精确检索**：输入 40 位 hex（或带 `urn:btih:` / `hash` 前缀）时自动切换为精确 + 前缀匹配，不经 FTS 索引。
- **排序**：`fetchedAt`（抓取时间）、`totalSize`（体积）、`relevance`（bm25 相关度）；未指定则按 id。
- **体积过滤**：按字节区间过滤（前端以 MB 输入）。
- **真服务端分页**：每次查询/翻页/排序都按页从后端拉取，`total` 与结果始终一致。
- **热门关键词榜**：构建索引时统计 `name` 中的合格 token（去单字、去纯数字、去噪声词），按文档频率降序。
- **热词过滤词**：用户可维护噪声词清单（经 `seed-filter.mjs` 或 API），从热词榜与统计中剔除。
- **输入联想**：基于热词的「完全相等 > 前缀 > 包含 > 模糊（Levenshtein）」分级匹配。
- **搜索缓存**：进程内 LRU 缓存，按序列化字节数限内存、按 TTL 过期（默认 256MB / 1h）。
- **在线重建**：`reindex()` 全量重建在 worker 线程（Node）或同进程（Bun）执行，重建期间检索仍可用；运行期按 `syncIntervalMs` 自动增量补录。
- **零前端构建**：纯原生 ES Module + 自定义元素 + Shadow DOM，直接用浏览器加载。
- **RPC 推送**：结果卡片「推送」按钮可将磁力链接经 JSON-RPC 2.0（`aria2.addUri`）推送到 aria2 / Motrix 下载器；地址与密钥在「设置」中配置，密钥按 aria2 约定以 `token:` 前缀发送。

## 五、配置项（`config.json`）

所有项均可选；缺失或非法时回退默认值，不阻塞启动。路径类配置支持相对路径（基于项目根）或绝对路径。

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `sourceDbPath` | `data/magnet.db` | 源库路径（含 `magnets` 表） |
| `indexDbPath` | `data/dht.search.db` | 影子索引库路径 |
| `port` | `3000` | HTTP 服务端口 |
| `maxResults` | `20000` | 「整集拉取」（limit=0/`all`）单次返回上限，超出标记 `truncated` |
| `reindexMaxOldSpaceMb` | `2048` | Node 下重建 worker 的堆上限（MB），触顶只杀 worker |
| `reindexTimeoutMs` | `0` | 重建超时（ms），`0` 表示不限制 |
| `searchCacheMaxSizeMb` | `256` | 搜索缓存最大占用内存（MB） |
| `searchCacheTtlMs` | `3600000` | 搜索缓存 TTL（ms，默认 1 小时） |
| `syncIntervalMs` | `3600000` | 运行期自动增量同步间隔（ms，默认 1 小时；`0` 关闭） |

路径解析优先级：**显式参数 > config.json > 环境变量（`DHT_DB_PATH` / `DHT_INDEX_DB_PATH`）> 模块默认值**。

## 六、安装与前置条件

1. **源库前置**：`data/magnet.db` 必须存在且包含 `magnets` 表（由外部 DHT 爬虫写入）。不存在或表缺失时启动会报错。
2. **运行时**（二选一）：
   - **Node**：需 `better-sqlite3`（C++ 原生模块，`npm install` 会自动尝试预编译/本地编译）。要求 Node ≥ 14.8（支持顶层 await）。
   - **Bun**：`bun:sqlite` 内置，无需原生编译。但 `bun install` 默认会去编译
     `optionalDependencies` 里的 `better-sqlite3`（Node 原生模块），缺构建链时报错。
     用 `bun install --omit optional` 即可跳过它；Node 用户用 `npm install` 不受影响，仍会正常装入。
     *进阶*：若想让 `bun install` 默认就跳过，可在项目根新建 `bunfig.toml`：
     ```toml
     [install]
     optional = false
     ```
3. 安装依赖：
   ```bash
   npm install                 # Node 路径（会正常安装 better-sqlite3）
   # 或
   bun install --omit optional # Bun 路径（跳过 better-sqlite3）
   ```

## 七、启动

> **首次启动很慢，属正常**：首次运行会从源库（`sourceDbPath`，默认 `data/magnet.db`）全量构建搜索索引并写入索引库（`indexDbPath`，默认 `data/dht.search.db`）。数据量大时这一步可能耗时**几分钟到几十分钟**，期间程序在后台建索引、暂无明显响应，请勿误以为卡死或启动失败。索引库建好（存在 `data/dht.search.db`）后，后续启动会直接加载，几秒内即可提供服务。

### 普通启动
```bash
npm start            # Node：node index.js
# 或
bun index.js         # Bun
```
启动后访问 `http://localhost:<port>`（默认 3000）。

### 用 pm2 启动（分别两个配置）
项目提供两份独立 pm2 配置，可分别调用（避免写在一起）：

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

两份配置都不在 pm2 中硬编码端口，统一读取 `config.json` 的 `port`（默认 3000）。
若想同机并存做回归对比，需让两个实例监听不同端口——可在启动前用环境变量区分，例如：
`PORT=3001 pm2 start ecosystem.config.bun.json`，或各自指向不同的 `config.json`。

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
| GET | `/index.html`、 `/public/*` | 前端静态资源 |
| GET | `/api/search` | 搜索（见下） |
| GET | `/api/count` | 已索引条数 `{ count }` |
| GET | `/api/hot?limit=` | 热词榜 `{ items: [{term,doc_count,occurrences}] }` |
| GET | `/api/hot/filter` | 热词过滤词列表 |
| POST | `/api/hot/filter` | 新增过滤词，body `{ term }` |
| DELETE | `/api/hot/filter?term=` | 删除过滤词 |
| GET | `/api/hot/filter/export` | 导出热词过滤词为纯文本文件（附件下载，每行一词，含 `#` 头注释） |
| POST | `/api/hot/filter/import` | 批量导入过滤词，body `{ terms: string[] }`，返回 `{ ok, accepted, total }` |
| POST | `/api/reindex` | 全量重建索引，返回 `{ ok, indexed }` |

### `GET /api/search` 参数
| 参数 | 说明 |
|------|------|
| `q` | 必填，搜索关键词（至少一个字母/数字） |
| `sortBy` | `fetchedAt` / `totalSize` / `relevance`；其他值忽略（按 id 排序） |
| `order` | `asc` / `desc`，默认 `desc`，仅 `sortBy` 传入时生效 |
| `limit` | 每页条数（钳制 1..200）；`0` 或 `all` 表示整集拉取 |
| `offset` | 分页偏移 |
| `minSize` / `maxSize` | 体积区间（字节）过滤 |
| `by` | `hash` 时按 infohash 精确检索（其余走 FTS5 模糊） |

返回：`{ total, limit, offset, items: [{ id, name, infohash, magnet, files, totalSize, fetchedAt }], truncated? }`
（`files` 为已解析的 `[{ path, size }]` 数组；整集拉取超出 `maxResults` 时带 `truncated: true`。）

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
npm test                 # 端到端冒烟测试（test/smoke.mjs，依赖已索引的源库）
npm run verify:driver    # 驱动层可行性验证（test/verify-driver.mjs）
npm run smoke            # 同 test（别名）
```
`verify-driver.mjs` 会自动探测当前运行时（Node / Bun），逐一校验驱动方法与 FTS5 特性；`smoke.mjs` 需要源库与索引库已就绪。

## 十一、运维要点

- **首次运行**：源库就绪后启动会自动全量重建索引（日志打印 `[index] 已索引 N 行`）。
- **手动重建**：Web 端「设置 → 重建索引」，或 `POST /api/reindex`。重建期间检索不受影响（Node 走 worker 线程）。
- **增量同步**：默认每小时按 `last_rowid` 补录源库新增行（`syncIntervalMs` 配 `0` 可关闭）。
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
