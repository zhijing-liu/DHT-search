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

/** 影子索引库路径：本服务维护的 FTS5 倒排索引 + 去规范化副本都在此库；相对路径基于项目根目录 */
export const INDEX_DB_PATH = 'data/dht.search.db';

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

/** 搜索结果内存缓存上限（MB）；缓存存的是序列化后的 JSON 字符串，该值 ≈ 实际堆占用 */
export const SEARCH_CACHE_MAX_SIZE_MB = 32;

/** 单条搜索缓存的存活时间（毫秒）—— 1 小时 */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** 最大并发搜索进程数（进程按需启动，空闲超时后回收至 0） */
export const SEARCH_MAX_PROCESSES = 2;

/** 每个搜索子进程的 SQLite page cache 上限（KiB，每进程一份，总额需乘以进程数） */
export const SEARCH_PROCESS_CACHE_SIZE_KB = 2048;

/** 每个搜索子进程的 SQLite mmap 上限（MB）；0 = 关闭 */
export const SEARCH_PROCESS_MMAP_SIZE_MB = 32;

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
