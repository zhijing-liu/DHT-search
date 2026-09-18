/**
 * 结果卡片组件（Alpine.data('magnetCard')）
 * ------------------------------------------------------------------
 * 一个实例只承载「这一条结果」的状态，提供只读派生数据（标题 / 文件预览 / 元信息）
 * 与少量动作；外观与结构写在 index.html 的 <magnet-card> 模板里。
 */
import Alpine from 'alpinejs';
import { renderFileTree, summarizeCategories } from './file-tree.js';
import { fetchMagnetFiles } from './api.js';
import {
  copyToClipboard,
  formatBytes,
  formatDate,
  highlightHtml,
  pushToAria2,
  toThunder,
} from './util.js';
import { showToast } from './toast.js';

/** 复制按钮反馈时长 */
const COPIED_MS = 1200;

/** 文件树按 id 缓存（上限 32 条，FIFO 淘汰）——树按需请求，反复打开不必重复往返 */

const TREE_CACHE_MAX = 32;
const treeCache = new Map();
const cacheTree = (id, nodes) => {
  if (treeCache.size >= TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value);
  treeCache.set(id, nodes);
};

export const registerCard = () => {
  Alpine.data('magnetCard', (item, tokens = []) => ({
    item,
    tokens,
    /** 详情弹窗是否已展开（非展开时不渲染内容，避免列表里堆积 200 棵文件树） */
    detailOpen: false,
    /** 复制成功后的短暂高亮 */
    copied: false,
    /**
     * 文件分类统计，只含该种子**实际存在**的分类：
     * [{ id, label, color, count, size, sizeText }]。由 applyTree 在拿到扁平树后填充。
     */
    categoryStats: [],
    /** 勾选的分类 id；默认全选，由 applyTree 按实际存在的分类初始化 */
    selectedCats: [],
    /** 扁平树原文（切换分类时就地重渲染，不必重新请求） */
    _treeNodes: null,
    /** 树所在的 <ul> 容器引用，重渲染用 */
    _treeEl: null,

    /* ---------- 派生数据 ---------- */

    get magnet() {
      return this.item?.magnet || '';
    },
    get thunder() {
      return toThunder(this.magnet);
    },
    get titleHtml() {
      return highlightHtml(this.item?.name || '(无名)', this.tokens);
    },
    get metaText() {
      return `大小 ${formatBytes(Number(this.item?.totalSize))} · 抓取于 ${formatDate(Number(this.item?.fetchedAt))}`;
    },
    /** 文件数（索引期算好的列）与预览（服务端挑好的前几条）都是直读字段 */
    get fileCount() {
      return Number(this.item?.fileCount) || 0;
    },
    /** 预览文件：[{ path, size }]；有关键词时只含命中的条目 */
    get preview() {
      return Array.isArray(this.item?.preview) ? this.item.preview : [];
    },
    get previewView() {
      return this.preview.map((f) => ({
        html: highlightHtml(f?.path || '(未命名)', this.tokens),
        size: formatBytes(Number(f?.size)),
      }));
    },
    get moreCount() {
      return Math.max(0, this.fileCount - this.preview.length);
    },
    /**
     * 「展开全部」的提示文案。
     *
     * 三种情形的语义并不相同，不能共用一句「及其他 N 个文件」（moreCount 只是
     * 「总数 − 已列出数」，它并不总是「没显示出来的那些」）：
     *
     *   - 预览为空：检索词没有任何文件路径命中（服务端 pickPreview 会把未命中项
     *     全部跳过），上面一条都没列出来，「及其他」失去参照物 —— 只报文件总数；
     *   - 有检索词：预览列的是**命中项**，而 fileCount 是**全部**文件数，相减得到的
     *     差额里混着大量未命中的文件，说成「还有其他 N 个」会让人以为那 N 个同样命中
     *     —— 改为报总数 + 已列出的命中数；
     *   - 无检索词：预览就是最前面 N 条，差额确实全是「剩下的」，沿用原说法。
     */
    get moreText() {
      const total = this.fileCount;
      const shown = this.preview.length;
      if (shown === 0) return `共 ${total} 个文件（点「查看全部文件」展开）`;
      if (this.tokens.length) {
        return `共 ${total} 个文件，已列出 ${shown} 个匹配（点「查看全部文件」展开）`;
      }
      return `…及其他 ${total - shown} 个文件（点「查看全部文件」展开）`;
    },
    get detailInfohash() {
      return this.item?.infohash || '-';
    },
    get detailSize() {
      return formatBytes(Number(this.item?.totalSize));
    },
    get detailDate() {
      return formatDate(Number(this.item?.fetchedAt));
    },
    /**
     * 彩虹条分段：按**全部**文件（不受勾选影响）计算字节占比。
     *
     * 刻意不按「已勾选」重算 —— 否则每取消一个类型，其余色段的宽度都会跟着变，
     * 反而看不出各自原本占多少。排除状态交给模板降透明度表达。
     */
    get rainbowSegments() {
      const total = this.categoryStats.reduce((s, c) => s + c.size, 0);
      if (!total) return [];
      return this.categoryStats.map((c) => ({ ...c, pct: (c.size / total) * 100 }));
    },

    /* ---------- 动作 ---------- */

    async copy() {
      try {
        await copyToClipboard(this.magnet);
      } catch {
        showToast('复制失败，请手动复制');
        return;
      }
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, COPIED_MS);
      showToast('已复制到剪贴板');
    },

    push() {
      pushToAria2(this.magnet);
    },

    /** 懒渲染：仅在打开时才构建完整文件树（见模板 x-if="detailOpen"） */
    async openDetail() {
      const dialog = this.$refs.detailDialog;
      // 连点两次时第二次会走到这里：showModal 对已打开的 dialog 会抛 InvalidStateError
      if (!dialog || dialog.open) return;
      this.detailOpen = true;
      await this.$nextTick();
      if (!dialog.open) dialog.showModal();
    },

    closeDetail() {
      this.$refs.detailDialog.close();
    },

    /** 勾选 / 取消勾选某个分类，并就地重渲染树 */
    toggleCat(id) {
      const i = this.selectedCats.indexOf(id);
      if (i >= 0) this.selectedCats.splice(i, 1);
      else this.selectedCats.push(id);
      this.rerenderTree();
    },

    /**
     * 点击彩虹条的某个色段：隔离该类型（只留它）。
     * 若当前已经处于「只选中它」的状态，则视为再次点击，恢复为全选 ——
     * 于是在同一个色段上就能完成「只看这类 / 看全部」的来回切换，无需另设按钮。
     *
     * @param {string} id 分类 id
     */
    soloCat(id) {
      const isolated = this.selectedCats.length === 1 && this.selectedCats[0] === id;
      this.selectedCats = isolated ? this.categoryStats.map((c) => c.id) : [id];
      this.rerenderTree();
    },

    /**
     * 拿到扁平树后的一次性准备：统计分类 → 默认全选 → 渲染。
     * 每次打开弹窗都会走到这里（x-if 懒创建），所以「默认展示全部类型」始终成立。
     *
     * @param {Array} nodes 扁平树
     * @param {HTMLElement} container 树所在的容器
     */
    applyTree(nodes, container) {
      this._treeNodes = nodes;
      this._treeEl = container;
      // summarizeCategories 只返回实际存在的分类 —— 没有该类型文件就不出复选框
      this.categoryStats = summarizeCategories(nodes).map((c) => ({
        ...c,
        sizeText: formatBytes(c.size),
      }));
      this.selectedCats = this.categoryStats.map((c) => c.id);
      this.rerenderTree();
    },

    /** 按当前勾选重渲染树（复用已缓存的扁平树，不重新请求） */
    rerenderTree() {
      const el = this._treeEl;
      if (!el || !this._treeNodes) return;
      el.replaceChildren(
        renderFileTree(this._treeNodes, this.tokens, undefined, new Set(this.selectedCats))
      );
    },

    /**
     * 把文件树挂到详情弹窗（模板的 x-init 调用，每次打开只跑一次）。
     * 按需请求 /api/magnet/:id/files，命中缓存则直接渲染。
     */
    async renderTree(container) {
      if (this.fileCount === 0) {
        container.textContent = '（无文件列表）';
        return;
      }
      const id = this.item?.id;
      const cached = treeCache.get(id);
      if (cached) {
        this.applyTree(cached, container);
        return;
      }
      container.textContent = '加载中…';
      try {
        const nodes = await fetchMagnetFiles(id);
        cacheTree(id, nodes);
        this.applyTree(nodes, container);
      } catch {
        // 弹窗可能已被关闭（容器脱离文档），写文案无副作用
        container.textContent = '文件列表加载失败';
      }
    },
  }));
};
