/**
 * 全局轻量通知（toast）：状态放在 Alpine store 里，由模板的 x-for + x-show + x-transition
 * 渲染与播动画，本模块只改数据、不碰 DOM。
 */
import Alpine from 'alpinejs';

/** 可见时长；淡出时长与模板里 leave 过渡的 duration 对齐 */
const VISIBLE_MS = 1600;
const FADE_MS = 220;

export const toastStore = {
  items: [],

  /** 弹出一条提示 */
  push(message) {
    const id = ++this._seq;
    // 先以 shown:false 入列，元素创建后再翻成 true（x-show 首次求值不播过渡，否则无入场动画）；
    // queueMicrotask 排在 Alpine 本轮渲染 flush 之后，保证「先创建、后翻转」
    this.items.push({ id, message, shown: false });
    queueMicrotask(() => this._setShown(id, true));
    setTimeout(() => this.dismiss(id), VISIBLE_MS);
  },

  /** 收起某条：shown 置 false 触发离场过渡，过渡播完再从列表移除 */
  dismiss(id) {
    this._setShown(id, false);
    setTimeout(() => {
      this.items = this.items.filter((t) => t.id !== id);
    }, FADE_MS);
  },

  _seq: 0,
  _setShown(id, shown) {
    const item = this.items.find((t) => t.id === id);
    if (item) item.shown = shown;
  },
};

/**
 * 弹出提示。经 Alpine store 代理写入，保证响应式生效；
 * Alpine 未启动时（极早期调用）退化为直接写原对象。
 */
export function showToast(message) {
  (Alpine.store('toast') || toastStore).push(message);
}
