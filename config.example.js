/**
 * 配置模板（请勿直接改本文件用于运行）
 * ------------------------------------------------------------------
 * 这是仓库随附的「公共默认配置」示例。部署 / 本地运行时，请复制为同目录的
 * `config.js` 再按需修改：
 *
 *     cp config.example.js config.js
 *
 * 注意：
 *   - `config.js` 含本机私有项（源库绝对路径、IP 白名单、反代信任等），已被
 *     `git update-index --skip-worktree` 标记，不会进入版本库；请勿提交它。
 *   - 本模板给出的是公共默认值（相对路径、标准私网白名单、关闭反代信任），
 *     可直接提交、可公开。
 *   - CI 发版（build:exe）需要仓库根存在 config.js：它使用的是本模板对应的
 *     公共默认值，因此发布包内 config.js 为公开默认，不含任何私有信息。
 *
 * 每个配置项都是独立的 `export const`，便于按需 import；时间类常量写成
 * `60 * 60 * 1000` 这类可读表达式。取值优先级（在 db.js 中生效）：
 * 显式参数 > config > 模块内默认值。
 */

/** SQLite 源库路径：由其他采集程序写入的 magnet.db，构建索引时以只读方式打开。
 * 本地请改成你的绝对路径，例如 'G:/active_project/DHT/data/magnet.db' */
export const SOURCE_DB_PATH = 'data/magnet.db';

/** 影子索引库（热库）路径：FTS5 倒排索引 + 去规范化副本（窄表）都在此库；相对路径基于项目根目录 */
export const INDEX_DB_PATH = 'data/dht.search.db';

/**
 * 冷库路径：files 原文与预览小列存这里（都是「按 id 点查、列表路径不碰」的大对象）。
 * 拆分后热库只放检索/排序/筛选要用的窄列，随机主键回查从磁盘 IO 变成缓存命中。
 * 可指向另一块盘。
 */
export const FILES_DB_PATH = 'data/dht.files.db';

/**
 * 冷库 files 是否压缩存储（zlib level 1）。
 * 只在「查看全部文件」时付一次解压开销，列表检索完全不受影响。
 */
export const FILES_COMPRESS = true;

/**
 * 全量重建时是否重写冷库已有行。
 * false（默认）：只追加缺失 id —— files 按 id 不可变，重建因此不必重写几个 GB 的大对象，
 *   这是拆分冷库最大的重建收益；代价是源库若 UPDATE 了既有行的 files，重建不会反映。
 * true：重建时全量重写冷库（能反映 UPDATE，代价是每次重建重写全部大对象）。
 */
export const FILES_REWRITE_ON_REBUILD = false;

/** HTTP 服务监听端口 */
export const PORT = 3000;

/**
 * 整个 Express 服务的统一前缀（同时是 vite build 的 base 路径），如 '/dht'。
 * 空字符串表示挂在站点根；设置后页面、静态资源与全部 API 都带此前缀，
 * 由后端在路由层统一剥掉。改后需重新构建前端才生效。
 */
export const WEB_BASE_PATH = '';

/**
 * 单次「整集拉取」（limit=all）最多返回条数，超出则 truncated=true
 * （0 表示不限制，上限由代码兜底为 20000）；分页路径由 MAX_LIMIT 约束，与本项无关。
 */
export const MAX_RESULTS = 2000;

/** reindex 全量重建的 V8 老生代堆上限（MB），仅 Node 子进程生效 */
export const REINDEX_MAX_OLD_SPACE_MB = 2048;

/** 源库只读扫描连接的 SQLite mmap 上限（MB），0 = 关闭；源库 ~7GB 时建议 1024~4096 */
export const SOURCE_READ_MMAP_MB = 2048;

/**
 * 定时增量同步的 cron 表达式（标准 5 字段：分 时 日 月 周；空字符串表示关闭）。
 * 到点后在后台按 last_rowid 只补录源库新增行，不执行全量重建。
 */
export const SYNC_CRON = '';

/**
 * 是否在服务启动时自动执行一次增量同步（按 last_rowid 补录源库新增行）。
 * 只影响「启动那一次补录」，不影响 SYNC_CRON、/api/sync 与 /api/reindex。
 */
export const SYNC_ON_START = false;

/**
 * 下发给前端的词表收录阈值：只下发 doc_count ≥ 本值的词。
 *
 * keyword_stats 是完整的原始统计（实测 129 万词），但其中 77% 的词只出现过 1 次——
 * 对热词榜和联想都没有意义，却会把下发的词表撑到几十 MB。按本阈值筛完后一次性
 * 下发给前端（换行分隔纯文本 + gzip），之后的联想完全在前端做，零网络延迟。
 *
 * 实测参考（313 万行索引，列出的是滤掉黑名单后的实际下发量）：
 *   ≥50  → 23,405 条 / 183KB / gzip 103KB   ← 默认，联想候选充足
 *   ≥30  → 34,935 条 / 285KB / gzip 162KB
 *   ≥10  → 84,406 条 / 775KB / gzip 454KB   ← 候选最全，首屏多传约 350KB
 *   ≥100 → 13,213 条 /  99KB / gzip  55KB   ← 更省，但长尾词联想会明显变少
 *
 * 调大能减小首屏体积，代价是长尾词不再出现在联想与榜单里。
 * 本项不影响 keyword_stats 的全量统计，只决定下发给前端的范围。
 */
export const HOT_MIN_DOC_COUNT = 50;

/** 搜索结果内存缓存上限（MB）；缓存存的是序列化后的 JSON 字符串，该值 ≈ 实际堆占用 */
export const SEARCH_CACHE_MAX_SIZE_MB = 32;

/** 单条搜索缓存的存活时间（毫秒）—— 1 小时 */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** 最大并发搜索进程数（进程按需启动，空闲超时后回收至 0） */
export const SEARCH_MAX_PROCESSES = 2;

/** 每个搜索子进程的 SQLite page cache 上限（KiB，每进程一份，总额需乘以进程数） */
export const SEARCH_PROCESS_CACHE_SIZE_KB = 2048;

/**
 * 是否启用 SQLite mmap（内存映射索引文件）：映射页可被 OS 页缓存共享、随连接复用，
 * 命中时省去 buffer cache 拷贝，对多 GB 级索引库的随机读有显著提速。
 * false = 全部读连接 mmap_size=0（纯 buffer cache，行为等价、内存更可控）。
 */
export const ENABLE_MMAP = true;

/**
 * 索引库读连接的 mmap 窗口上限（MB）：同时作用于「主进程只读连接」与「搜索子进程」，
 * 0 = 关闭（等价于 ENABLE_MMAP=false）。12GB 索引库建议 256~1024，使热区常驻内存。
 * 兼容旧配置：未设置本项时回退到 SEARCH_PROCESS_MMAP_SIZE_MB（若该旧项仍存在）。
 */
export const INDEX_MMAP_SIZE_MB = 256;

/**
 * 搜索进程是否「立即回收」：true = 查询一完成就回收，内存最省但每次查询要付进程冷启动；
 * false = 保留进程复用，空闲超过 SEARCH_PROCESS_IDLE_MS 才回收。
 */
export const SEARCH_PROCESS_RECYCLE_IMMEDIATE = false;

/**
 * 搜索进程空闲多久后被回收（毫秒），0 = 不回收。
 * 仅在 SEARCH_PROCESS_RECYCLE_IMMEDIATE = false 时生效。
 */
export const SEARCH_PROCESS_IDLE_MS = 60 * 1000;

/** 搜索等待队列上限：所有进程忙碌时新查询排队，超出则快速失败（防无界堆积） */
export const SEARCH_QUEUE_MAX = 16;

/** 排队超时（毫秒），超时后快速失败；0 表示不限时 */
export const SEARCH_QUEUE_TIMEOUT_MS = 10 * 1000;

/* ------------------------------------------------------------------ */
/* 访问控制（接入层 IP / 网段白名单）                                   */
/* ------------------------------------------------------------------ */

/** 访问控制模式：'ip-whitelist' = 仅放行 ALLOWED_CLIENTS 中的地址，其余 403；'off' = 关闭 */
export const ACCESS_CONTROL_MODE = 'ip-whitelist';

/**
 * 允许访问的客户端地址清单（仅 ip-whitelist 模式生效）。
 * 支持精确 IPv4 / IPv6 与 CIDR 网段；::ffff:x.x.x.x 形式的映射地址会归一化回 IPv4 再比对。
 * 本地部署请在此追加你的组网网段（如 tailscale / 星空组网等）。
 */
export const ALLOWED_CLIENTS = [
  '127.0.0.1',        // IPv4 本机回路
  '::1',              // IPv6 本机回路
  '10.0.0.0/8',       // A 类私网
  '172.16.0.0/12',    // B 类私网
  '192.168.0.0/16',   // C 类私网
  '169.254.0.0/16',   // 链路本地（APIPA）
  'fc00::/7',         // IPv6 唯一本地地址（ULA，对应私网）
  'fe80::/10',        // IPv6 链路本地
];

/** 是否信任前置反向代理的 X-Forwarded-For（影响 req.ip 取值；反代后部署需开启才能拿到真实客户端 IP） */
export const TRUST_PROXY = false;
