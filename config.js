/**
 * 运行期配置（ESM 模块，可直接写注释）
 * ------------------------------------------------------------------
 * 与旧版 config.json 的区别：
 *   - 用 JS 模块代替 JSON，因此能写 // 与 /* *\/ 注释；
 *   - 每个配置项都是独立的 `export const`，便于按需 import 且语义清晰；
 *   - 时间类常量写成 `60 * 60 * 1000` 这类可读表达式，一眼能看出是「1 小时」。
 *
 * 取值优先级（在 db.js 中生效）：
 *   显式参数 > 本文件 > 模块内默认值。
 * 注意：不读取 DHT_DB_PATH / DHT_INDEX_DB_PATH 等环境变量——本文件的值恒非空，
 * 原 env 兜底分支永不生效，已从代码中移除；scripts/ 下的脚本仍直接读取环境变量。
 *
 * 注意：本文件是「真实生效」的配置。修改后无需重启构建步骤，重启服务即可生效。
 */

/** SQLite 源库路径：由其他采集程序写入的 magnet.db，构建索引时以只读方式打开 */
export const SOURCE_DB_PATH = 'data/magnet.db';

/** 影子索引库路径：本服务维护的 FTS5 倒排索引 + 去规范化副本都在此库；相对路径基于项目根目录 */
export const INDEX_DB_PATH = 'data/dht.search.db';

/** HTTP 服务监听端口 */
export const PORT = 3000;

/**
 * 整个 Express 服务的统一前缀（同时是 vite build 的 base 路径），如 '/dht'。
 * - 空字符串（默认）：服务挂在站点根（/api/...、/assets/...），适合直接对外或经
 *   nginx 等「剥前缀」反代转发到站点根的场景；
 * - 设为 `/dht`（或 `/dht/`）：页面、静态资源与全部 API 都统一带此前缀访问
 *   （/dht/、/dht/api/search、/dht/assets/...）。后端在路由层统一剥掉前缀
 *   （见 index.js），无需额外反代；不带前缀的根路径会 302 到前缀下，兼容旧直连。
 * 此前缀同时决定 `npm run build:web` 产物的资源引用前缀，改后需重新构建才生效。
 */
export const WEB_BASE_PATH = '';

/**
 * 单次「整集拉取」（limit=all）最多返回条数，超出则 truncated=true
 * （0 表示不限制，上限由代码兜底为 20000）。
 * 注意：分页路径由 db.js 的 MAX_LIMIT（200）约束，与本项无关。
 */
export const MAX_RESULTS = 2000;

/** reindex 全量重建的 V8 老生代堆上限（MB），仅 Node worker 线程生效；Bun 走子进程执行，堆由操作系统兜底 */
export const REINDEX_MAX_OLD_SPACE_MB = 2048;

/**
 * 源库（magnet.db）只读扫描连接的 SQLite mmap 上限（MB），0 = 关闭（旧行为）。
 *
 * 为什么需要：重建/增量同步要对源库做整表顺序扫，SQLite 逐页 4KB 同步读时磁盘队列
 * 深度只有 1，既吃不满 SSD/NVMe 的顺序带宽，CPU 也因等 I/O 空转——表现为「IO/CPU
 * 占用都低但重建很慢」。开启 mmap 后由内核按大块预取，扫描吞吐接近顺序读上限。
 *
 * 代价：被扫过的 mmap 页计入页缓存/进程工作集（属可回收页，内存紧张时 OS 会自动
 * 淘汰），值越大预取窗口越大、RSS 越高。源库 ~7GB 时建议 1024~4096。
 */
export const SOURCE_READ_MMAP_MB = 2048;

/**
 * 定时增量同步的 cron 表达式（标准 5 字段：分 时 日 月 周，如 '0 4 * * *' = 每天 04:00）。
 * 空字符串表示关闭。
 * 启用后，到点在后台按 last_rowid 只补录源库新增行（秒级、几乎无写放大），主进程零阻塞；
 * 不执行全量重建——重建只保留给启动建库与手动 /api/reindex（源库的 UPDATE/DELETE 不会
 * 被增量同步捕获，需要时手动重建一次即可）。
 * 设置面板的「下次同步」倒计时即本表达式推算出的下一次触发点（见 src/cron.js）。
 */
export const SYNC_CRON = '';

/**
 * 是否在服务启动时自动执行一次增量同步（按 last_rowid 补录源库新增行）。
 * - true：启动后在后台补录一次，让索引尽快追上源库（不阻塞页面响应）；
 * - false：启动不做任何索引维护，索引维持上次退出时的状态。
 *
 * 注意：本项只关掉「启动那一次补录」，不影响其他索引维护入口——
 * 定时同步（SYNC_CRON）、手动 /api/sync、手动 /api/reindex 仍然照常工作。
 * 关掉后设置面板也不会再出现「启动初始化中」状态。
 */
export const SYNC_ON_START = false;

/**
 * 搜索结果内存缓存上限（MB）。
 * 缓存存的是序列化后的 JSON 字符串（而非对象），故该值 ≈ 实际堆占用，
 * 不必再按「对象堆占用是 JSON 字节数 3~5 倍」去放大预留。
 */
export const SEARCH_CACHE_MAX_SIZE_MB = 32;

/** 单条搜索缓存的存活时间（毫秒）—— 1 小时 */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * 最大并发搜索进程数。
 * 进程是「按需 fork」的：服务启动时常驻 0 个，有查询才启动，
 * 客户端断开或空闲超时后回收，空闲足够久则回到 0。
 * 低并发场景 1~2 即可；调大只影响并发能力，不影响空闲时的内存。
 */
export const SEARCH_MAX_PROCESSES = 2;

/**
 * 每个搜索子进程的 SQLite page cache 上限（KiB）。
 * 注意：这是**每个进程一份**的私有内存，总额 = 本值 × SEARCH_MAX_PROCESSES。
 * 检索是分页的（单次 ≤ 200 条），工作集很小，默认 2MB 足够；
 * 只有整集拉取（limit=all）才可能受益于更大的值。
 */
export const SEARCH_PROCESS_CACHE_SIZE_KB = 2048;

/**
 * 每个搜索子进程的 SQLite mmap 上限（MB）；配 0 表示关闭 mmap。
 * 与 page cache 不同，mmap 映射的是**共享 clean page**：多个进程读同一个索引库
 * 不会重复占用一份，且内存紧张时可由 OS 直接回收（不计入进程私有内存）。
 * 因此同样的内存预算，给 mmap 比给 page cache 划算。
 */
export const SEARCH_PROCESS_MMAP_SIZE_MB = 32;

/**
 * 搜索进程是否「立即回收」：查询一完成就 SIGKILL 掉该进程。
 * - `true` ：空闲时进程数恒为 0，内存最省；代价是**每次查询都要付一次 fork
 *            冷启动**（Windows 实测约 1 秒），连续翻页 / 改关键词时体感明显。
 * - `false`：进程保留一段时间供后续查询复用，只有空闲超过 SEARCH_PROCESS_IDLE_MS
 *            才回收 —— 即**只有此时 SEARCH_PROCESS_IDLE_MS 才生效**。
 *            连续操作期间复用热进程，真正空闲后内存同样回到 0。
 */
export const SEARCH_PROCESS_RECYCLE_IMMEDIATE = false;

/**
 * 搜索进程空闲多久后被回收（毫秒）—— 空闲足够久后进程数回到 0；配 0 表示不回收。
 * 注意：**仅在 SEARCH_PROCESS_RECYCLE_IMMEDIATE = false 时生效**；
 * 立即回收模式下进程用完即杀，不存在「空闲进程」，本项被忽略。
 */
export const SEARCH_PROCESS_IDLE_MS = 60 * 1000;

/** 搜索等待队列上限：所有进程忙碌时新查询排队，超出则快速失败（防无界堆积） */
export const SEARCH_QUEUE_MAX = 16;

/** 排队超时（毫秒），超时后快速失败；0 表示不限时 */
export const SEARCH_QUEUE_TIMEOUT_MS = 10 * 1000;

/* ------------------------------------------------------------------ */
/* 访问控制（接入层 IP / 网段白名单）                                    */
/* ------------------------------------------------------------------ */

/**
 * 访问控制模式。
 * - 'ip-whitelist'（默认）：仅允许 ALLOWED_CLIENTS 中的 IP / 网段访问，
 *   其余一律 403。适合局域网 / 内网共享部署，把外网陌生人挡在门外。
 * - 'off'：关闭访问控制（兼容纯本机 / 公网 + 反代鉴权等场景）。
 */
export const ACCESS_CONTROL_MODE = 'ip-whitelist';

/**
 * 允许访问的客户端地址清单（仅 ACCESS_CONTROL_MODE='ip-whitelist' 时生效）。
 * 支持三种形式：
 *   - 精确 IPv4：'192.168.1.5'
 *   - 精确 IPv6：'2001:db8::1'
 *   - CIDR 网段：'192.168.0.0/16'、'2001:db8::/32'
 * 内置覆盖常见内网 / 本机范围；公网部署应改为只列自己的固定 IP。
 * 注意：::ffff:x.x.x.x 形式的 IPv4 映射 IPv6 会自动归一化回 IPv4 再比对。
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

/**
 * 是否信任前置反向代理的 X-Forwarded-For（影响 req.ip 取值）。
 * - false（默认）：直接取 TCP 对端地址，适合直连 / 无反代；
 * - 设为 true / 'loopback' / 具体子网：当服务位于 nginx 等反代之后，
 *   需开启才能拿到真实客户端 IP，否则 req.ip 会是反代自身 IP，
 *   导致白名单把整张内网都误放行（或误拒）。
 */
export const TRUST_PROXY = false;
