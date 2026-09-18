/**
 * 文件树渲染：消费后端下发的扁平树（parent 指向父节点下标）
 * ------------------------------------------------------------------
 * 数据形状 [{ name, parent, isDir, size, path? }] 由详情接口返回，故这里不判定分隔符、
 * 不 split 路径、不累加目录大小：先按 parent 归组还原父子关系，再产出真实 DOM
 * （任意深度、展开时才建子层、单层按批补行）。
 *
 * 全程 DOM API 拼接，无 innerHTML 注入面；模板侧只需 x-init="renderTree($el)"。
 */
import { formatBytes } from './util.js';

/** 文件命中查询 token 的数量评分，用于「匹配关键词优先」排序（仅本模块内部使用） */
const fileMatchScore = (name, tokens) => {
  if (!tokens || tokens.length === 0) return 0;
  const lower = String(name).toLowerCase();
  let s = 0;
  for (const t of tokens) if (lower.includes(t)) s++;
  return s;
};

/* ------------------------------------------------------------------ */
/* 扁平树 → 渲染用父子关系                                              */
/* ------------------------------------------------------------------ */

/**
 * 由扁平树还原成渲染用的嵌套结构 { name, isDir, size, children: Map<序号, node> }。
 * parent 只认「已经出现过的下标」，非法值一律当作根级（避免脏数据成环）；
 * 返回虚拟根节点，其 children 即全部根级节点。
 */
const toNestedTree = (flat) => {
  const list = Array.isArray(flat) ? flat : [];
  const wrapped = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const n = list[i] || {};
    wrapped[i] = {
      // 退化兜底：老格式（尚未重建完成）的节点是 { path, size }，没有 name/isDir，
      // 这里平铺成根级文件显示原始路径，而不是渲染出一堆空名字行
      name: String(n.name ?? n.path ?? ''),
      isDir: !!n.isDir,
      size: Number(n.size) || 0,
      children: new Map(),
    };
  }

  const root = { name: '', isDir: true, size: 0, children: new Map() };
  for (let i = 0; i < wrapped.length; i += 1) {
    const p = Number(list[i]?.parent);
    const parent = Number.isInteger(p) && p >= 0 && p < i ? wrapped[p] : root;
    parent.children.set(i, wrapped[i]);
  }
  return root;
};

/* ------------------------------------------------------------------ */
/* 渲染（light DOM：全部用 Tailwind 工具类，无需组件样式文件）          */
/* ------------------------------------------------------------------ */

/** 一行：图标 + 名称 + 大小。
 *  w-max min-w-full：名称不换行（超长由容器横向滚动查看），同时让行至少铺满容器宽度 */
const ROW_CLASS = 'flex items-center gap-1.5 w-max min-w-full';
/** 展开/折叠把手；文件行没有把手，用 invisible 占位保持缩进对齐 */
const TOGGLE_CLASS = 'w-3.5 shrink-0 text-center text-muted cursor-pointer select-none';
/** 名称（含关键词高亮 <mark>）：不换行——长文件名靠容器横向滚动，不折行破坏树的对齐 */
const NAME_CLASS =
  'text-fg whitespace-nowrap [&_mark]:rounded-[3px] [&_mark]:bg-brand/[0.35] [&_mark]:px-0.5 [&_mark]:text-white';
/** 大小 */
const SIZE_CLASS = 'shrink-0 text-muted ml-1';
/** 子层级：左侧竖线缩进 */
const CHILDREN_CLASS = 'list-none m-0 p-0 pl-3.5 border-l border-line';
/** 每一行（li）：离屏时跳过布局与绘制（浏览器自带的长列表虚拟化，上千行滚动不卡） */
const ROW_ITEM_CLASS = '[content-visibility:auto] [contain-intrinsic-size:auto_24px]';
/** 「…还有 N 项」这一行：弱化为可点击样式 */
const MORE_CLASS = 'text-brand2 whitespace-nowrap cursor-pointer hover:underline';

/** 单层一次最多构建的行数：超出的部分折叠成「…还有 N 项」一行，点击继续按批构建 */
const BATCH_SIZE = 200;
/** 打开弹窗时的自动展开预算（行数上限）：第一层目录只在装得下时默认展开 */

const INITIAL_ROWS = 200;

/** 把 text 中命中 tokens 的片段以 <mark> 写入 container（全程 DOM API，无注入风险） */
const highlightInto = (container, text, tokens) => {
  container.replaceChildren();
  if (!tokens || tokens.length === 0 || !text) {
    container.textContent = text || '';
    return;
  }
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    container.appendChild(mark);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // 防止零宽匹配死循环
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
};

/** 子节点排序：目录优先 → 命中关键词优先 → 名称自然序 */
const sortChildren = (node, tokens) => {
  return [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const sa = fileMatchScore(a.name, tokens);
    const sb = fileMatchScore(b.name, tokens);
    if (sa !== sb) return sb - sa;
    return a.name.localeCompare(b.name, 'en', { numeric: true });
  });
};

/** 单行：文件行 = 名称 + 大小；目录行 = 把手 + 名称 + 大小 + 懒加载的子层 */
const createRow = (child, depth, tokens, budget) => {
  const li = document.createElement('li');
  li.className = ROW_ITEM_CLASS;
  const row = document.createElement('div');
  row.className = ROW_CLASS;
  const toggle = document.createElement('span');
  const name = document.createElement('span');
  name.className = NAME_CLASS;

  if (!child.isDir) {
    toggle.className = `${TOGGLE_CLASS} invisible`; // 占位保持缩进对齐
    highlightInto(name, child.name, tokens);
    const size = document.createElement('span');
    size.className = SIZE_CLASS;
    size.textContent = formatBytes(Number(child.size));
    row.append(toggle, name, size);
    li.append(row);
    return li;
  }

  const size = document.createElement('span');
  size.className = SIZE_CLASS;
  size.textContent = `· ${formatBytes(Number(child.size))}`;
  highlightInto(name, child.name, tokens);
  row.append(toggle, name, size);

  const sub = document.createElement('ul');
  sub.className = CHILDREN_CLASS;
  li.append(row, sub);
  toggle.className = TOGGLE_CLASS;

  // 子层懒渲染：只有真正展开过的目录才去建行，折叠着的子树一行都不建
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    sub.appendChild(renderChildren(child, depth + 1, tokens, budget));
  };

  // 默认展开「第一层」——但只在预算装得下时展开，装不下就先折叠（点一下再建）。
  // 深度用 hidden 属性控制折叠（由 base 层的 [hidden]{display:none!important} 兜底）。
  const rowsNeeded = Math.min(child.children.size, BATCH_SIZE);
  const autoExpand = depth === 0 && rowsNeeded > 0 && rowsNeeded <= budget.rows;
  if (autoExpand) budget.rows -= rowsNeeded;
  sub.hidden = !autoExpand;
  if (autoExpand) fill();
  toggle.textContent = autoExpand ? '▾' : '▸';

  toggle.addEventListener('click', () => {
    const collapsing = !sub.hidden; // 当前可见 → 点击后折叠
    if (!collapsing) fill(); // 首次展开时才构建子层
    sub.hidden = collapsing;
    toggle.textContent = collapsing ? '▸' : '▾';
  });
  return li;
};

/** 「…还有 N 项，点击展开」：按批续渲染剩余行，本行用完即移除 */
const createMoreRow = (node, depth, tokens, budget, next, rest) => {
  const li = document.createElement('li');
  li.className = ROW_ITEM_CLASS;
  const row = document.createElement('div');
  row.className = ROW_CLASS;
  const pad = document.createElement('span');
  pad.className = `${TOGGLE_CLASS} invisible`;
  pad.textContent = '▸';
  const more = document.createElement('span');
  more.className = MORE_CLASS;
  more.textContent = `…还有 ${rest} 项，点击展开`;
  row.append(pad, more);
  li.append(row);

  more.addEventListener('click', () => {
    const parent = li.parentNode; // 点击时本行已在真实容器里
    if (!parent) return;
    parent.insertBefore(renderChildren(node, depth, tokens, budget, next), li);
    li.remove();
  });
  return li;
};

/**
 * 渲染 node 的一层子节点，返回 DocumentFragment。
 * 单层一次最多建 BATCH_SIZE 行，其余交给「…还有 N 项」按批补。
 * @param {number} from 从第几个子节点开始（续渲染用）
 */
const renderChildren = (node, depth, tokens, budget, from = 0) => {
  const frag = document.createDocumentFragment();
  const arr = sortChildren(node, tokens);
  const batch = arr.slice(from, from + BATCH_SIZE);
  for (const child of batch) frag.appendChild(createRow(child, depth, tokens, budget));

  const rest = arr.length - from - batch.length;
  if (rest > 0) frag.appendChild(createMoreRow(node, depth, tokens, budget, from + batch.length, rest));
  return frag;
};

/**
 * 渲染整棵文件树，返回可直接插进容器的 Fragment。
 * budget 只由「打开弹窗」的那次调用给出，用于决定第一层目录是否默认展开。
 * @param {Array} nodes 后端下发的扁平树
 */
export const renderFileTree = (nodes, tokens, budget = { rows: INITIAL_ROWS }) =>
  renderChildren(toNestedTree(nodes), 0, tokens, budget);
