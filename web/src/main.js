/**
 * 前端入口：注册 Alpine 组件与 store，然后启动。
 * ------------------------------------------------------------------
 * 渲染与事件全部交给 index.html 里的 Alpine 指令，这里只做「装配」。
 */
import './styles/app.css';
import Alpine from 'alpinejs';
import { registerApp } from './app.js';
import { registerCard } from './card.js';
import { toastStore } from './toast.js';

// 全局通知：模板里以 $store.toast.items 渲染
Alpine.store('toast', toastStore);

// 组件：结果卡片（页面主组件注册在 registerApp 内）
registerCard();
registerApp();

Alpine.start();
