/**
 * 结果卡片组件（Alpine.data('magnetCard')）
 * ------------------------------------------------------------------
 * 一个实例只承载「这一条结果」的状态，提供只读派生数据（标题 / 文件预览 / 元信息）
 * 与少量动作；外观与结构写在 index.html 的 <magnet-card> 模板里。
 */
import Alpine from 'alpinejs';
import { renderFileTree } from './file-tree.js';
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
    get moreText() {
      return `…及其他 ${this.moreCount} 个文件（点「查看全部文件」展开）`;
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
        container.replaceChildren(renderFileTree(cached, this.tokens));
        return;
      }
      container.textContent = '加载中…';
      try {
        const nodes = await fetchMagnetFiles(id);
        cacheTree(id, nodes);
        container.replaceChildren(renderFileTree(nodes, this.tokens));
      } catch {
        // 弹窗可能已被关闭（容器脱离文档），写文案无副作用
        container.textContent = '文件列表加载失败';
      }
    },
  }));
};
