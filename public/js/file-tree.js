/* 文件树的构建与渲染（从扁平 [{ path, size }] 列表生成可折叠目录树） */
import { formatBytes, highlightInto } from './util.js';

/** 文件预览最多展示的条数（性能：列表不渲染全部） */
export const PREVIEW_LIMIT = 5;

/** 文件命中查询 token 的数量评分，用于「匹配关键词优先」排序 */
export function fileMatchScore(name, tokens) {
  if (!tokens || !tokens.length) return 0;
  const lower = String(name).toLowerCase();
  let s = 0;
  for (const t of tokens) if (lower.includes(t)) s++;
  return s;
}

/**
 * 把扁平的 [{ path, size }] 列表按 path 中的 '/' 拆分成目录树。
 * 目录节点聚合字节大小，文件节点保留自身 size。
 */
export function buildFileTree(files) {
  const root = { name: '', isDir: true, children: new Map(), size: 0 };
  for (const f of files) {
    const parts = String((f && f.path) || '').split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '') continue;
      const isLeaf = i === parts.length - 1;
      let child = cur.children.get(part);
      if (!child) {
        child = { name: part, isDir: !isLeaf, children: new Map(), size: 0 };
        cur.children.set(part, child);
      }
      if (isLeaf) {
        child.isDir = false;
        child.size = Number(f.size) || 0;
      }
      cur = child;
    }
  }
  return root;
}

/** 递归累加目录节点的字节大小（所有子孙叶子之和） */
export function computeTreeSizes(node) {
  if (!node.isDir) return Number(node.size) || 0;
  let total = 0;
  for (const c of node.children.values()) total += computeTreeSizes(c);
  node.size = total;
  return total;
}

/** 递归渲染树节点；depth 为父节点深度，child 实际深度 = depth + 1 */
export function renderTreeNode(node, depth, tokens) {
  const frag = document.createDocumentFragment();
  const arr = [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 目录优先
    const sa = fileMatchScore(a.name, tokens);
    const sb = fileMatchScore(b.name, tokens);
    if (sa !== sb) return sb - sa; // 命中关键词优先
    return a.name.localeCompare(b.name, 'en', { numeric: true });
  });
  for (const child of arr) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    const toggle = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'name';

    if (child.isDir) {
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = `· ${formatBytes(Number(child.size))}`;
      highlightInto(name, child.name, tokens);
      row.append(toggle, name, size);

      const sub = document.createElement('ul');
      sub.className = 'children';
      sub.appendChild(renderTreeNode(child, depth + 1, tokens));
      li.append(row, sub);

      // 默认仅展开第一级（顶层目录显示其直接子，更深层级折叠）
      const expanded = depth === 0;
      if (!expanded) li.classList.add('collapsed');
      toggle.textContent = expanded ? '▾' : '▸';
      toggle.addEventListener('click', () => {
        const collapsed = li.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '▸' : '▾';
      });
    } else {
      toggle.className = 'toggle empty';
      highlightInto(name, child.name, tokens);
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatBytes(Number(child.size));
      row.append(toggle, name, size);
      li.append(row);
    }
    frag.appendChild(li);
  }
  return frag;
}
