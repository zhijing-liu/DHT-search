/**
 * 扁平文件树构建（详情接口按需调用）
 * ------------------------------------------------------------------
 * 把源库的 [{ path, size }] 路径列表还原成扁平树：
 *
 *   [{ name, parent, isDir, size, path? }, ...]
 *
 *   - parent：父节点在数组中的下标，根节点为 -1；
 *   - size  ：文件为自身字节数，目录为所有子孙之和；
 *   - path  ：仅文件节点携带源路径，供渲染时展示与关键词匹配。
 *
 * 前端按 parent 分组即可渲染，不必判定分隔符或 split 路径。
 */

/**
 * 判定层级分隔符（'' = 不拆分）：优先 '/'；其次 ','，但仅当「首段」被多个文件共用时
 * 才算目录分隔符（文件名本身带逗号时首段各不相同，不会被误判成层级）。
 */
function detectSeparator(paths) {
  if (paths.some((p) => p.includes('/'))) return '/';

  const heads = new Map();
  let commaFiles = 0;
  for (const p of paths) {
    const i = p.indexOf(',');
    if (i < 0) continue;
    commaFiles += 1;
    const head = p.slice(0, i);
    heads.set(head, (heads.get(head) || 0) + 1);
  }
  if (commaFiles === 0) return '';

  // 多数「含逗号的文件」都落在被共用的首段下 → 认定逗号是目录分隔符
  let shared = 0;
  for (const n of heads.values()) if (n > 1) shared += n;
  return shared * 2 > commaFiles ? ',' : '';
}

/** 同父下的节点唯一键：目录与文件共用同一命名空间（与前端 Map<name, node> 的语义一致） */
function keyOf(parent, name) {
  return `${parent}\u0000${name}`;
}

/**
 * 把 [{ path, size }]（或单个对象）还原成扁平树数组；目录大小已按子孙累加好。
 * 无法识别的输入（非数组 / 非对象 / 空）返回空数组。
 * @param {Array|object|null} files 源库 files 原文解析结果
 * @returns {Array<{ name: string, parent: number, isDir: boolean, size: number, path?: string }>}
 */
export function buildFlatTree(files) {
  const list = Array.isArray(files) ? files : files && typeof files === 'object' ? [files] : [];
  if (list.length === 0) return [];

  const sep = detectSeparator(list.map((f) => String((f && f.path) || '')));
  const nodes = [];
  const byKey = new Map();

  for (const f of list) {
    const path = String((f && f.path) || '');
    // 分隔符为空 = 扁平列表；过滤空段以容忍首尾/连续分隔符
    const parts = (sep ? path.split(sep) : [path]).filter((s) => s !== '');
    if (parts.length === 0) continue;

    // 最后一段是文件名，前面的段逐级建目录（同父同名目录复用同一个节点）
    const fileName = parts.pop();
    let parent = -1;
    for (const dir of parts) {
      const key = keyOf(parent, dir);
      let idx = byKey.get(key);
      if (idx === undefined) {
        idx = nodes.length;
        nodes.push({ name: dir, parent, isDir: true, size: 0 });
        byKey.set(key, idx);
      }
      parent = idx;
    }

    // 同名节点可能是先建出来的目录（同名前缀路径），这里统一收敛成文件
    const leafKey = keyOf(parent, fileName);
    let leaf = byKey.get(leafKey);
    if (leaf === undefined) {
      leaf = nodes.length;
      nodes.push({ name: fileName, parent, isDir: false, size: 0, path });
      byKey.set(leafKey, leaf);
    }
    const node = nodes[leaf];
    node.isDir = false;
    node.size = Number(f && f.size) || 0;
    node.path = path;
  }

  // 目录大小 = 所有子孙之和：节点恒为「父先于子」创建，倒序遍历一次即可累加完
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i];
    if (n.parent >= 0) nodes[n.parent].size += n.size;
  }
  return nodes;
}
