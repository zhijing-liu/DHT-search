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
/* 文件分类（彩虹条占比 + 树过滤共用一套判定）                          */
/* ------------------------------------------------------------------ */

/**
 * 分类定义：order 即彩虹条分段与复选框的展示顺序，`other` 是兜底分类必须放最后。
 * 扩展名一律小写、不含点；color 同时用于彩虹条分段与复选框的选中色块。
 */
export const FILE_CATEGORIES = Object.freeze([
  {
    id: 'video',
    label: '视频',
    color: '#3b82f6',
    exts: [
      'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'rmvb', 'rm', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg',
      'mpe', 'm2v', 'm1v', 'mpv', 'vob', 'webm', 'm4v', '3gp', 'asf', 'f4v', 'ogv', 'divx', 'mxf',
    ],
  },
  {
    id: 'audio',
    label: '音频',
    color: '#a855f7',
    exts: [
      'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'oga', 'wma', 'ape', 'opus', 'alac', 'aiff', 'aif',
      'ac3', 'dts', 'mka', 'mid', 'midi', 'amr', 'ra', 'wv', 'tak', 'tta',
    ],
  },
  {
    id: 'image',
    label: '图片',
    color: '#22c55e',
    exts: [
      'jpg', 'jpeg', 'jpe', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'ico', 'heic', 'heif',
      'avif', 'jfif', 'psd', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'pef', 'srw',
      'tga', 'ppm', 'pgm', 'pbm', 'xcf',
    ],
  },
  {
    id: 'archive',
    label: '压缩包',
    color: '#f59e0b',
    exts: [
      'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'zst', 'cab', 'arj', 'lzh',
      'ace', 'iso', 'img', 'lz', 'lzma', 'z', 'br', 'r00', 'r01', '001', '002', 'gzip',
    ],
  },
  // 兜底：未命中上面任何扩展名（含无扩展名）都归到这里
  { id: 'other', label: '其他', color: '#64748b', exts: [] },
]);

/** 扩展名 → 分类 id 的反查表（构建期一次） */
const EXT_TO_CATEGORY = new Map();
for (const c of FILE_CATEGORIES) for (const e of c.exts) EXT_TO_CATEGORY.set(e, c.id);

/**
 * 取扩展名（小写、不含点）。
 * 前置条件 i > 0 排除了 `.gitignore` 这类以点开头的隐藏文件（它没有扩展名）。
 */
const extOf = (name) => {
  const s = String(name);
  const i = s.lastIndexOf('.');
  return i > 0 && i < s.length - 1 ? s.slice(i + 1).toLowerCase() : '';
};

/** 按扩展名归类；未命中任何列表（含无扩展名）归入兜底的 other */
export const classifyByExt = (name) => EXT_TO_CATEGORY.get(extOf(name)) ?? 'other';

/**
 * 统计各分类的文件数与总字节，**只返回实际存在的分类**（count > 0）。
 *
 * 直接扫扁平数组而不是嵌套树：目录节点不参与统计（它的 size 已由子孙汇总），
 * 而扁平数组里文件节点就是这个含义，扫一遍即可。
 *
 * 「只返回存在的分类」正是 UI 侧「没有该类型就不显示复选框」的依据。
 *
 * @param {Array} flat 后端下发的扁平树
 * @returns {Array<{ id: string, label: string, color: string, count: number, size: number }>}
 */
export const summarizeCategories = (flat) => {
  const list = Array.isArray(flat) ? flat : [];
  const acc = new Map();
  for (const n of list) {
    if (!n || n.isDir) continue;
    const id = classifyByExt(n.name ?? n.path ?? '');
    const hit = acc.get(id) ?? { count: 0, size: 0 };
    hit.count += 1;
    hit.size += Number(n.size) || 0;
    acc.set(id, hit);
  }
  return FILE_CATEGORIES.filter((c) => acc.has(c.id)).map((c) => ({ ...c, ...acc.get(c.id) }));
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
    // 退化兜底：老格式（尚未重建完成）的节点是 { path, size }，没有 name/isDir，
    // 这里平铺成根级文件显示原始路径，而不是渲染出一堆空名字行
    const name = String(n.name ?? n.path ?? '');
    const isDir = !!n.isDir;
    wrapped[i] = {
      name,
      isDir,
      size: Number(n.size) || 0,
      // 分类只对文件成立；目录的分类恒为 null（它由子孙组成，可能混合多类）
      category: isDir ? null : classifyByExt(name),
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

/**
 * 按勾选的分类原地剪枝。
 *
 * 两条规则：
 *   1. 文件节点只在分类被勾选时保留；
 *   2. 目录节点**剪完子树后仍有子**才保留 —— 这就是「过滤出来的树只展示有子的父级」。
 *
 * 顺带把每个目录的 size 重算为「可见子孙之和」，否则过滤后树里的数字会与彩虹条对不上。
 *
 * @param {object} node 嵌套树节点（原地修改）
 * @param {Set<string>} selected 勾选的分类 id
 */
const pruneTree = (node, selected) => {
  const kept = [];
  for (const child of node.children.values()) {
    if (child.isDir) {
      pruneTree(child, selected);
      if (child.children.size > 0) kept.push(child);
    } else if (selected.has(child.category)) {
      kept.push(child);
    }
  }
  // key 原本是扁平数组下标，剪枝后已无意义 —— 渲染侧只用 values() 与 size
  node.children = new Map(kept.map((c, i) => [i, c]));
  let total = 0;
  for (const c of kept) total += c.size;
  node.size = total;
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

/** 分类 id → 颜色（与彩虹条、复选框同一套色值，三者肉眼可对应） */
const CATEGORY_COLOR = new Map(FILE_CATEGORIES.map((c) => [c.id, c.color]));

/** 行首分类色块：形状与复选框色块一致（小圆角方块），宽度固定以保持名称对齐 */
const DOT_CLASS = 'flex-none w-2 h-2 rounded-[2px]';

/**
 * 生成行首的分类标记。
 *
 * 文件行用**亮色实心块**（该文件的分类色）；目录行没有单一类型（由子孙组成，
 * 可能混合多类），用**暗色实心块**（--color-line #334155）而不是留空位：
 *   - 留空位会让目录行的名称相对文件行更靠左，缩进层级看起来是乱的；
 *   - 暗色块与亮色块尺寸完全一致（都是 size-2），对齐天然成立；
 *   - 暗色是相对文件行的低饱和灰，不抢眼又能一眼看出「这是容器」；
 *     比「其他」分类的灰（#64748b）更暗，两者不会混淆。
 *
 * 注：早期试过用 1px 空心描边，但 #334155 的描边在 #111827 的弹窗底色上
 * 对比度太低，肉眼几乎看不见，等于没加 —— 故改回实心填充。
 */
const createCategoryDot = (category) => {
  const dot = document.createElement('span');
  dot.className = DOT_CLASS;
  const color = category ? CATEGORY_COLOR.get(category) : null;
  if (color) dot.style.background = color;
  else dot.classList.add('bg-line');
  return dot;
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
    row.append(toggle, createCategoryDot(child.category), name, size);
    li.append(row);
    return li;
  }

  const size = document.createElement('span');
  size.className = SIZE_CLASS;
  size.textContent = `· ${formatBytes(Number(child.size))}`;
  highlightInto(name, child.name, tokens);
  row.append(toggle, createCategoryDot(null), name, size);

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
  row.append(pad, createCategoryDot(null), more);
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
 *
 * @param {Array} nodes 后端下发的扁平树
 * @param {string[]} tokens 关键词高亮与「命中优先」排序用
 * @param {{rows: number}} [budget] 只由「打开弹窗」那次调用给出，决定第一层目录是否默认展开
 * @param {Set<string>|null} [selected] 勾选的分类 id；null / 省略表示不做分类过滤
 */
export const renderFileTree = (nodes, tokens, budget = { rows: INITIAL_ROWS }, selected = null) => {
  const root = toNestedTree(nodes);
  if (selected) pruneTree(root, selected);
  return renderChildren(root, 0, tokens, budget);
};
