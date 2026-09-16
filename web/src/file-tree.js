/**
 * 文件树：由扁平 [{ path, size }] 列表生成可折叠目录树。
 * ------------------------------------------------------------------
 * 前半部分是纯数据函数（构建 / 累加 / 命中评分 / 预览筛选），对外导出的几个可直接单测
 * （fileMatchScore 只服务于本模块的排序，故不导出）；
 * 后半部分（renderTreeNode）产出真实 DOM 节点，供详情弹窗里的文件树使用。
 *
 * 这里是全站唯一由 JS 直接建 DOM 的渲染点，且是刻意保留的：树是**任意深度**的递归结构，
 * Alpine 的模板递归只能在模板里重复展开有限层（或改成扁平列表，那会连带改掉
 * 每层 <ul> 的缩进竖线结构），两者都会让 DOM 或可读性变差。模板侧只需一句
 * x-init="renderTree($el)"——递归细节收敛在这一个纯函数里，同时全程 DOM API 拼接，
 * 天然不存在 innerHTML 注入面。
 */
import { formatBytes, normalizeFiles } from './util.js';

/** 文件预览最多展示的条数（性能：列表不渲染全部） */
const PREVIEW_LIMIT = 5;

/** 文件命中查询 token 的数量评分，用于「匹配关键词优先」排序（仅本模块内部使用） */
function fileMatchScore(name, tokens) {
  if (!tokens || tokens.length === 0) return 0;
  const lower = String(name).toLowerCase();
  let s = 0;
  for (const t of tokens) if (lower.includes(t)) s++;
  return s;
}

/* ------------------------------------------------------------------ */
/* 路径 → 树                                                            */
/* 源库里的 path 有两种写法：POSIX 风格（'dir/sub/a.mkv'），以及把目录    */
/* 写成逗号分隔（'Scenes,a.m4v'）。先判定用哪个分隔符，再逐级建树；      */
/* 判定不出来的就按扁平列表处理（整条 path 就是文件名，不拆层级）。       */
/* ------------------------------------------------------------------ */

/**
 * 判定层级分隔符（空串 = 不拆分）：
 * - 只要出现 '/' 就用 '/'——它是真正的路径分隔符，最可信；
 * - 否则看 ',':只有当「首段」被多个文件共用时才算目录分隔符。
 *   文件名里本身带逗号（'片名,片名.CHM' 这类）时首段各不相同，
 *   不会被误判成目录层级，避免凭空多出一堆单文件目录；
 * - 两种都不满足 → 返回 ''（扁平列表）。
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

/**
 * 把扁平的 [{ path, size }] 列表还原成目录树。
 * 目录节点聚合字节大小（见 computeTreeSizes），文件节点保留自身 size。
 * 节点形状：{ name, isDir, children: Map<name, node>, size }。
 */
export function buildFileTree(files) {
  const list = Array.isArray(files) ? files : [];
  const sep = detectSeparator(list.map((f) => String((f && f.path) || '')));
  const root = { name: '', isDir: true, children: new Map(), size: 0 };

  for (const f of list) {
    const path = String((f && f.path) || '');
    // 分隔符为空 = 扁平列表；过滤空段以容忍首尾/连续分隔符
    const parts = (sep ? path.split(sep) : [path]).filter((s) => s !== '');
    if (parts.length === 0) continue;

    // 最后一段是文件名，前面的段逐级建目录
    const fileName = parts.pop();
    let cur = root;
    for (const dir of parts) {
      let child = cur.children.get(dir);
      if (!child) {
        child = { name: dir, isDir: true, children: new Map(), size: 0 };
        cur.children.set(dir, child);
      }
      cur = child;
    }

    // 同名节点可能是先建出来的目录（同名前缀路径），这里统一收敛成文件
    let leaf = cur.children.get(fileName);
    if (!leaf) {
      leaf = { name: fileName, isDir: false, children: new Map(), size: 0 };
      cur.children.set(fileName, leaf);
    }
    leaf.isDir = false;
    leaf.size = Number(f.size) || 0;
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

/**
 * 卡片内的文件预览：有关键词时只保留匹配到的文件，否则取前 limit 条；
 * 命中较多者优先，同分保持原始顺序（稳定）。
 */
export function previewFiles(files, tokens, limit = PREVIEW_LIMIT) {
  const list = normalizeFiles(files);
  const hasTokens = Array.isArray(tokens) && tokens.length > 0;
  const scored = list
    .map((f, i) => ({ f, i, s: fileMatchScore(f?.path, tokens) }))
    .filter((x) => !hasTokens || x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.f);
}

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
/** 每一行（li）：离屏时跳过布局与绘制——浏览器自带的「长列表虚拟化」，
 *  上千行的文件树滚动不再卡顿。contain-intrinsic-size 用 auto 让浏览器复用上次实测高度，
 *  避免滚动条因占位高度估算而跳动（不支持的浏览器会忽略这两条，行为与原来一致）。 */
const ROW_ITEM_CLASS = '[content-visibility:auto] [contain-intrinsic-size:auto_24px]';
/** 「…还有 N 项」这一行：弱化为可点击样式 */
const MORE_CLASS = 'text-brand2 whitespace-nowrap cursor-pointer hover:underline';

/** 单层一次最多构建的行数：超出的部分折叠成「…还有 N 项」一行，点击继续按批构建 */
const BATCH_SIZE = 200;
/**
 * 打开弹窗时的「自动展开预算」（行数上限）。
 * 第一层目录只在装得下时默认展开，装不下就折叠（点开再建）；
 * 于是「打开」的构建量与文件总数解耦——上千文件、根层挂着几百个文件也能立刻打开。
 */
const INITIAL_ROWS = 200;

/** 把 text 中命中 tokens 的片段以 <mark> 写入 container（全程 DOM API，无注入风险） */
function highlightInto(container, text, tokens) {
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
}

/** 子节点排序：目录优先 → 命中关键词优先 → 名称自然序 */
function sortChildren(node, tokens) {
  return [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const sa = fileMatchScore(a.name, tokens);
    const sb = fileMatchScore(b.name, tokens);
    if (sa !== sb) return sb - sa;
    return a.name.localeCompare(b.name, 'en', { numeric: true });
  });
}

/** 单行：文件行 = 名称 + 大小；目录行 = 把手 + 名称 + 大小 + 懒加载的子层 */
function createRow(child, depth, tokens, budget) {
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
}

/** 「…还有 N 项，点击展开」：按批续渲染剩余行，本行用完即移除 */
function createMoreRow(node, depth, tokens, budget, next, rest) {
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
}

/**
 * 渲染 node 的一层子节点，返回 DocumentFragment。
 * 单层一次最多建 BATCH_SIZE 行，其余交给「…还有 N 项」按批补。
 * @param {number} from 从第几个子节点开始（续渲染用）
 */
function renderChildren(node, depth, tokens, budget, from = 0) {
  const frag = document.createDocumentFragment();
  const arr = sortChildren(node, tokens);
  const batch = arr.slice(from, from + BATCH_SIZE);
  for (const child of batch) frag.appendChild(createRow(child, depth, tokens, budget));

  const rest = arr.length - from - batch.length;
  if (rest > 0) frag.appendChild(createMoreRow(node, depth, tokens, budget, from + batch.length, rest));
  return frag;
}

/**
 * 渲染整棵树，返回可直接插进容器的 Fragment。
 * depth 为父节点深度（子节点实际深度 = depth + 1）；
 * budget 只由「打开弹窗」的那次调用给出，用于决定第一层目录是否默认展开。
 */
export function renderTreeNode(node, depth, tokens, budget = { rows: INITIAL_ROWS }) {
  return renderChildren(node, depth, tokens, budget);
}
