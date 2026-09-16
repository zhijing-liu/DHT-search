/**
 * 后端接口层：统一「拼参 → 取 JSON → 校验 ok」，失败一律 throw Error（后端 error 文案
 * 或 HTTP 状态），组件层只需 try/catch + showToast。
 */

/** 解析响应；非 2xx 抛错，错误信息优先取后端返回的 error 字段 */
async function toJson(resp) {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || String(resp.status));
  return data;
}

/** GET + query 参数 */
function get(path, params, signal) {
  const qs = new URLSearchParams(params ?? {}).toString();
  return fetch(`${path}${qs ? `?${qs}` : ''}`, { signal }).then(toJson);
}

/** JSON body 的 POST */
function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(toJson);
}

/* ---------- 检索 ---------- */

/** 关键词检索（真服务端分页） */
export const search = (params, signal) => get('api/search', params, signal);

/** 资源库（固定 id 倒序，只传分页参数） */
export const fetchLatest = (params, signal) => get('api/latest', params, signal);

/** 某条 magnet 的完整文件树（列表只下发 fileCount + 预览，整棵树在打开详情时才取） */
export const fetchMagnetFiles = (id) =>
  fetch(`api/magnet/${encodeURIComponent(id)}/files`)
    .then(toJson)
    .then((d) => d.nodes || []);

/** 已索引总数 */
export const fetchCount = () => fetch('api/count').then(toJson).then((d) => d.count);

/** 热词榜（同时用于默认视图与输入框联想） */
export const fetchHot = (limit) => get('api/hot', { limit }).then((d) => d.items || []);

/* ---------- 热词黑名单 ---------- */

export const fetchBlacklist = () => fetch('api/hot/filter').then(toJson).then((d) => d.items || []);

export const addBlacklistTerm = (term) => post('api/hot/filter', { term });

export const removeBlacklistTerm = (term) =>
  fetch(`api/hot/filter?term=${encodeURIComponent(term)}`, { method: 'DELETE' }).then(toJson);

/** 批量导入，返回 { accepted, total } */
export const importBlacklist = (terms) => post('api/hot/filter/import', { terms });

/** 导出为文本（每行一个词） */
export const exportBlacklist = async () => {
  const resp = await fetch('api/hot/filter/export');
  if (!resp.ok) throw new Error('导出失败');
  return resp.text();
};

/* ---------- 索引维护 ---------- */

/** 全量重建，返回 { indexed } */
export const reindex = () => post('api/reindex');

/** 增量同步最新索引 */
export const syncIndex = () => post('api/sync');

/* ---------- 运行状态流 ---------- */

/**
 * 订阅运行状态 SSE。
 * @param {(stats: object) => void} onStats 每帧快照
 * @param {() => void} onError 连接中断（EventSource 自带重连）
 * @returns {EventSource} 由调用方负责 close()
 */
export function openStatsStream(onStats, onError) {
  const source = new EventSource('api/stats/stream');
  source.addEventListener('stats', (e) => {
    try {
      onStats(JSON.parse(e.data));
    } catch {
      /* 忽略脏帧，等下一帧补上 */
    }
  });
  source.onerror = onError;
  return source;
}
