/**
 * 索引期行转换（纯函数，无 IO）
 * ------------------------------------------------------------------
 * 源库 `magnets.files` 是 `[{ path, size }]` 的 JSON 文本，写入索引库时只做两个派生值：
 *
 *   1. `ftsText`   —— 喂给 FTS5 的检索文本：仅路径，换行分隔（整个 JSON 会把 path / size
 *      这类键名与体积数字也索引进倒排表，既占体积又污染检索）。
 *   2. `fileCount` —— 文件条目数，落库成独立列（列表接口只返回它，不下发整棵文件树）。
 *
 * 容错：不是合法 JSON 时 `ftsText` 回退为原文、`fileCount` 记 0。
 */

/**
 * @param {string|null|undefined} rawFiles 源库 files 列原文
 * @returns {{ ftsText: string, fileCount: number }}
 */
export function transformFiles(rawFiles) {
  if (rawFiles === null || rawFiles === undefined) return { ftsText: '', fileCount: 0 };

  let parsed;
  try {
    parsed = JSON.parse(rawFiles);
  } catch {
    return { ftsText: String(rawFiles), fileCount: 0 };
  }

  // 源数据可能是数组，也可能被写成单个对象；两者都按一条处理
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];

  // 快速路径：单文件种子占多数（真实分布里约一半以上），此时不必建数组、不必 join
  const only = list.length === 1 ? list[0] : null;
  if (only && typeof only.path === 'string' && only.path) {
    return { ftsText: only.path, fileCount: 1 };
  }

  let fileCount = 0;
  const paths = [];
  for (const f of list) {
    const p = f && typeof f.path === 'string' ? f.path : '';
    if (!p) continue;
    fileCount += 1;
    paths.push(p);
  }
  return { ftsText: paths.join('\n'), fileCount };
}
