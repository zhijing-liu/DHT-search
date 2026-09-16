/**
 * 模板中需要动态渲染的图标（静态图标直接写在 index.html 里）。
 * 全部为可信字面量，模板用 x-html 绑定，不涉及用户数据。
 */
const SVG = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const X = (size, stroke) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

export const ICONS = {
  /** 热词气泡右侧的「加入黑名单」 */
  closeSm: X(12, 2.5),
  /** 黑名单条目的「移出黑名单」 */
  close: X(14, 2.5),
  /** 上一页 / 下一页 */
  prev: `<svg ${SVG}><polyline points="15 18 9 12 15 6"/></svg>`,
  next: `<svg ${SVG}><polyline points="9 18 15 12 9 6"/></svg>`,
  /** 升序 / 降序 */
  orderAsc: `<svg ${SVG}><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>`,
  orderDesc: `<svg ${SVG}><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>`,
  /** 排序键图标 */
  sortDefault: `<svg ${SVG}><path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/></svg>`,
  sortFetchedAt: `<svg ${SVG}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  sortTotalSize: `<svg ${SVG}><path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/></svg>`,
  sortRelevance: `<svg ${SVG}><path d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2L12 16.6 5.7 21l2.3-7.2-6-4.4h7.6z"/></svg>`,
};
