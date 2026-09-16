/**
 * 结果卡片组件（Alpine.data('magnetCard')）。
 * ------------------------------------------------------------------
 * 一个卡片实例只承载「这一条结果」的状态：高亮 token、复制反馈、详情弹窗开关。
 * 卡片外观与结构全部写在 index.html 的 <magnet-card> 模板里（Tailwind 工具类），
 * 这里只提供只读派生数据（标题 / 文件预览 / 元信息）与少量动作。
 */
import Alpine from 'alpinejs';
import {
  buildFileTree,
  computeTreeSizes,
  previewFiles as pickPreviewFiles,
  renderTreeNode,
} from './file-tree.js';
import {
  copyToClipboard,
  formatBytes,
  formatDate,
  highlightHtml,
  normalizeFiles,
  pushToAria2,
  toThunder,
} from './util.js';
import { showToast } from './toast.js';

/** 复制按钮反馈时长 */
const COPIED_MS = 1200;

export function registerCard() {
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
    /**
     * 派生值的记忆化缓存：挂在元素上（非响应式，读写不会自触发副作用），
     * 按 (files, tokens) 的引用失效。
     * 一次渲染里模板会多次读同一份派生值（预览列表 + 「还有 N 个文件」+ 详情文件树 +
     * 「无文件列表」判断），上千文件的条目下重复 normalize / 筛选的代价并不小。
     */
    _memo() {
      const files = this.item?.files;
      const el = this.$el;
      if (!el._memo || el._memo.files !== files || el._memo.tokens !== this.tokens) {
        el._memo = { files, tokens: this.tokens, list: null, preview: null };
      }
      return el._memo;
    },
    get fileList() {
      const m = this._memo();
      if (!m.list) m.list = normalizeFiles(m.files);
      return m.list;
    },
    /** 预览文件（有关键词时优先展示命中的若干条） */
    get preview() {
      const m = this._memo();
      if (!m.preview) m.preview = pickPreviewFiles(m.files, m.tokens);
      return m.preview;
    },
    get previewView() {
      return this.preview.map((f) => ({
        html: highlightHtml(f?.path || '(未命名)', this.tokens),
        size: formatBytes(Number(f?.size)),
      }));
    },
    get moreCount() {
      return Math.max(0, this.fileList.length - this.preview.length);
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

    /** 把递归文件树挂到详情弹窗的列表中（由模板的 x-init 调用，每次打开只构建一次） */
    renderTree(container) {
      const list = this.fileList;
      container.replaceChildren();
      if (!list.length) {
        container.textContent = '（无文件列表）';
        return;
      }
      const root = buildFileTree(list);
      computeTreeSizes(root);
      container.replaceChildren(renderTreeNode(root, 0, this.tokens));
    },
  }));
}
