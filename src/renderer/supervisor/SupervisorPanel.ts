/**
 * 监管子系统：监管浮窗
 * --------------------------------------------------------------
 * 调试用浮窗，展示 supervisorLog 实时事件流 + 过滤 + 导出。
 *
 * 唤出方式：
 * - 开发模式（npm run dev）默认开启
 * - 生产模式：URL 加 ?dev=1
 * - 键盘快捷键：Ctrl+Shift+D（toggle）/ Esc（关闭）
 *
 * 与现有 managerPanel 的关系：
 * - managerPanel 是给用户用的角色管理面板（生成/删除/查配置）
 * - supervisorPanel 是给开发者用的调试面板（事件流/导出）
 * - 两者互不依赖，可独立唤出
 *
 * 性能策略：
 * - 订阅 supervisorLog 的批量 flush（每 200ms 或 16 条）—— 不会逐条 DOM 渲染
 * - 事件列表用 DocumentFragment 批量追加，避免 reflow
 * - 超过 500 条自动截断老事件（环形缓冲在 eventLog.ts 里也有，再加一层 UI 保险）
 */

import { supervisorLog, PetLogEvent, LogLevel } from './eventLog';
import { StatusBar } from './StatusBar';

const STYLE_ID = 'deskpet-supervisor-panel';
const MAX_RENDERED_EVENTS = 500;

function isDevMode(): boolean {
  // 三种情况视为开发模式：
  // 1. URL 带 ?dev=1
  // 2. Electron 启动参数含 --dev
  // 3. 本地非打包路径（process.env.NODE_ENV === 'development'）
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('dev') === '1') return true;
  } catch { /* noop */ }
  const proc = (window as any).process;
  if (proc?.argv?.includes?.('--dev')) return true;
  if (proc?.env?.NODE_ENV === 'development') return true;
  return false;
}

function ensureStylesInjected() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #${STYLE_ID}-root {
      position: fixed;
      top: 28px;     /* 状态条下方 */
      right: 12px;
      width: 480px;
      max-width: calc(100vw - 24px);
      height: 520px;
      max-height: calc(100vh - 40px);
      z-index: 999998;
      pointer-events: auto;
      background: rgba(15, 15, 20, 0.92);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      color: #e0e0e0;
      font-family: ui-monospace, "Cascadia Code", Consolas, "SF Mono", Menlo, "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
      font-size: 12px;
      display: none;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    #${STYLE_ID}-root.visible { display: flex; }
    #${STYLE_ID}-root .sp-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      user-select: none;
      cursor: move;
    }
    #${STYLE_ID}-root .sp-title { font-weight: 600; color: #7dd3fc; }
    #${STYLE_ID}-root .sp-filters {
      display: flex;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-wrap: wrap;
    }
    #${STYLE_ID}-root .sp-filters input,
    #${STYLE_ID}-root .sp-filters select {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      color: #e0e0e0;
      padding: 3px 6px;
      border-radius: 3px;
      font-family: inherit;
      font-size: 11px;
    }
    #${STYLE_ID}-root .sp-pet-quick {
      display: inline-flex;
      gap: 4px;
    }
    #${STYLE_ID}-root .sp-pet-chip {
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 3px;
      background: rgba(125, 211, 252, 0.1);
      border: 1px solid rgba(125, 211, 252, 0.25);
      color: #7dd3fc;
      font-size: 11px;
      font-family: inherit;
    }
    #${STYLE_ID}-root .sp-pet-chip:hover { background: rgba(125, 211, 252, 0.25); }
    #${STYLE_ID}-root .sp-pet-chip.active { background: #7dd3fc; color: #0a0a0f; }
    #${STYLE_ID}-root .sp-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    #${STYLE_ID}-root .sp-evt {
      padding: 3px 10px;
      border-left: 3px solid transparent;
      cursor: pointer;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    #${STYLE_ID}-root .sp-evt:hover { background: rgba(255,255,255,0.04); }
    #${STYLE_ID}-root .sp-evt.expanded { background: rgba(125, 211, 252, 0.08); }
    #${STYLE_ID}-root .sp-evt[data-level="error"] { border-left-color: #f87171; }
    #${STYLE_ID}-root .sp-evt[data-level="warn"] { border-left-color: #fbbf24; }
    #${STYLE_ID}-root .sp-evt[data-level="action"] { border-left-color: #7dd3fc; }
    #${STYLE_ID}-root .sp-evt[data-level="physics"] { border-left-color: #a78bfa; }
    #${STYLE_ID}-root .sp-evt[data-level="system"] { border-left-color: #888; }
    #${STYLE_ID}-root .sp-evt-line1 {
      display: flex;
      gap: 8px;
      align-items: baseline;
    }
    #${STYLE_ID}-root .sp-evt-ts { color: #888; font-size: 10px; }
    #${STYLE_ID}-root .sp-evt-cat { color: #fbbf24; font-size: 11px; }
    #${STYLE_ID}-root .sp-evt-pet { color: #7dd3fc; font-size: 11px; }
    #${STYLE_ID}-root .sp-evt-cause { color: #c084fc; font-size: 11px; }
    #${STYLE_ID}-root .sp-evt-action { color: #86efac; font-size: 11px; font-weight: 500; }
    #${STYLE_ID}-root .sp-evt-detail {
      display: none;
      padding: 4px 0 0 60px;
      color: #aaa;
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    #${STYLE_ID}-root .sp-evt.expanded .sp-evt-detail { display: block; }
    #${STYLE_ID}-root .sp-footer {
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    #${STYLE_ID}-root .sp-btn {
      background: rgba(125, 211, 252, 0.12);
      border: 1px solid rgba(125, 211, 252, 0.3);
      color: #7dd3fc;
      padding: 4px 10px;
      border-radius: 3px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    #${STYLE_ID}-root .sp-btn:hover { background: rgba(125, 211, 252, 0.2); }
    #${STYLE_ID}-root .sp-btn.danger { color: #f87171; border-color: rgba(248,113,113,0.3); background: rgba(248,113,113,0.1); }
    #${STYLE_ID}-root .sp-counts { color: #888; font-size: 10px; margin-left: auto; align-self: center; }
  `;
  document.head.appendChild(s);
}

function fmtTs(t: number): string {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export class SupervisorPanel {
  /** 面板是否打开：供 app.ts reconcile() 判定阻塞态 */
  public static isOpen = false;
  private root: HTMLElement;
  private listEl: HTMLElement;
  private countsEl: HTMLElement;
  private statusBar: StatusBar;
  private unsubscribe: (() => void) | null = null;
  /** 内存里的全部事件（环形缓冲外再加一层 UI 缓冲，方便过滤和回放） */
  private events: PetLogEvent[] = [];
  private paused = false;
  private filterPet = '';
  private filterCat = '';
  private filterLevel: LogLevel | '' = '';
  // 面板拖拽状态
  private isDraggingPanel = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartLeft = 0;
  private dragStartTop = 0;
  // 面板 resize 状态
  private isResizing = false;
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartW = 0;
  private resizeStartH = 0;

  constructor(statusBar: StatusBar) {
    this.statusBar = statusBar;
    ensureStylesInjected();
    this.root = document.createElement('div');
    this.root.id = `${STYLE_ID}-root`;
    this.root.innerHTML = `
      <div class="sp-header">
        <span class="sp-title">🛰 Supervisor</span>
        <span class="sp-counts" data-role="counts">0 events</span>
      </div>
      <div class="sp-filters">
        <input data-role="filter-pet" placeholder="pet id" />
        <span data-role="pet-quick" class="sp-pet-quick"></span>
        <input data-role="filter-cat" placeholder="category 关键字" />
        <select data-role="filter-level">
          <option value="">all levels</option>
          <option value="action">action</option>
          <option value="physics">physics</option>
          <option value="system">system</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </div>
      <div class="sp-list" data-role="list"></div>
      <div class="sp-footer">
        <button class="sp-btn" data-role="pause">⏸ Pause</button>
        <button class="sp-btn" data-role="clear">🗑 Clear</button>
        <button class="sp-btn" data-role="export">📥 Export JSON</button>
        <button class="sp-btn" data-role="copy">📋 Copy</button>
        <button class="sp-btn danger" data-role="close">✕ Close</button>
      </div>
    `;
    document.body.appendChild(this.root);
    this.listEl = this.root.querySelector('[data-role="list"]') as HTMLElement;
    this.countsEl = this.root.querySelector('[data-role="counts"]') as HTMLElement;
    this.bindFilters();
    this.bindButtons();
    this.bindKeyboard();
    this.suppressContextMenu();
    this.bindPanelMove();
    this.bindResize();
    // 首次订阅（dev 模式默认显示）
    if (isDevMode()) {
      setTimeout(() => this.show(), 100); // 延后让 PIXI 起来
    }
  }

  /** 显示浮窗 + 状态条 */
  show() {
    SupervisorPanel.isOpen = true;
    this.root.classList.add('visible');
    this.statusBar.setVisible(true);
    this.subscribe();
    this.renderList();
    this.dispatchToggle();
  }

  hide() {
    SupervisorPanel.isOpen = false;
    this.root.classList.remove('visible');
    this.statusBar.setVisible(false);
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.dispatchToggle();
  }

  toggle() {
    if (this.root.classList.contains('visible')) this.hide();
    else this.show();
  }

  isVisible() {
    return this.root.classList.contains('visible');
  }

  /** 订阅 supervisorLog 批量 flush */
  private subscribe() {
    if (this.unsubscribe) return;
    this.unsubscribe = supervisorLog.subscribe((batch) => {
      if (this.paused) return;
      this.events.push(...batch);
      // UI 缓冲也限 5000 条（环形外的保险）
      if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
      // 首次收到事件后顺手把 petId 列表喂给快捷过滤按钮
      this.refreshPetChips();
      this.renderList();
    });
  }

  /** 从已收集的事件里抽出 petId 集合，建快捷过滤按钮 */
  private refreshPetChips() {
    const wrap = this.root.querySelector('[data-role="pet-quick"]') as HTMLElement;
    if (!wrap) return;
    const ids = new Set<string>();
    for (const e of this.events) if (e.petId) ids.add(e.petId);
    const cur = Array.from(wrap.children).map((c) => (c as HTMLElement).dataset.pid || '');
    const next = Array.from(ids);
    if (cur.length === next.length && cur.every((c, i) => c === next[i])) return; // 没变
    wrap.innerHTML = '';
    for (const id of next) {
      const chip = document.createElement('span');
      chip.className = 'sp-pet-chip';
      chip.dataset.pid = id;
      chip.textContent = id;
      if (this.filterPet === id) chip.classList.add('active');
      chip.onclick = () => {
        // 再次点击同一 chip = 清除过滤
        if (this.filterPet === id) {
          this.filterPet = '';
          (this.root.querySelector('[data-role="filter-pet"]') as HTMLInputElement).value = '';
        } else {
          this.filterPet = id;
          (this.root.querySelector('[data-role="filter-pet"]') as HTMLInputElement).value = id;
        }
        this.refreshPetChips();
        this.renderList();
      };
      wrap.appendChild(chip);
    }
  }

  private bindFilters() {
    const fp = this.root.querySelector('[data-role="filter-pet"]') as HTMLInputElement;
    const fc = this.root.querySelector('[data-role="filter-cat"]') as HTMLInputElement;
    const fl = this.root.querySelector('[data-role="filter-level"]') as HTMLSelectElement;
    fp.addEventListener('input', () => { this.filterPet = fp.value.trim(); this.refreshPetChips(); this.renderList(); });
    fc.addEventListener('input', () => { this.filterCat = fc.value.trim(); this.renderList(); });
    fl.addEventListener('change', () => { this.filterLevel = fl.value as any; this.renderList(); });
  }

  private bindButtons() {
    const pauseBtn = this.root.querySelector('[data-role="pause"]') as HTMLButtonElement;
    const clearBtn = this.root.querySelector('[data-role="clear"]') as HTMLButtonElement;
    const exportBtn = this.root.querySelector('[data-role="export"]') as HTMLButtonElement;
    const copyBtn = this.root.querySelector('[data-role="copy"]') as HTMLButtonElement;
    const closeBtn = this.root.querySelector('[data-role="close"]') as HTMLButtonElement;
    pauseBtn.addEventListener('click', () => {
      this.paused = !this.paused;
      pauseBtn.textContent = this.paused ? '▶ Resume' : '⏸ Pause';
    });
    clearBtn.addEventListener('click', () => {
      supervisorLog.clear();
      this.events = [];
      this.renderList();
    });
    exportBtn.addEventListener('click', () => this.exportJson());
    copyBtn.addEventListener('click', () => this.copyJson());
    closeBtn.addEventListener('click', () => this.hide());
  }

  private bindKeyboard() {
    // 全局 Ctrl+Shift+D（panel 未显示时也响应——一键唤出）
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        this.toggle();
      } else if (e.key === 'Escape' && this.isVisible()) {
        this.hide();
      }
    });
  }

  /** 通知 app.ts 重算鼠标穿透态（面板显隐切换时立即生效） */
  private dispatchToggle() {
    try {
      window.dispatchEvent(new CustomEvent('supervisor-toggle'));
    } catch { /* noop */ }
  }

  /** 面板内右键不触发角色右键菜单 */
  private suppressContextMenu() {
    this.root.addEventListener('contextmenu', (e) => e.stopPropagation());
  }

  /** 标题栏拖拽移动面板 */
  private bindPanelMove() {
    const header = this.root.querySelector('.sp-header') as HTMLElement;
    if (!header) return;
    header.addEventListener('mousedown', (e) => {
      // 点击关闭按钮时不拖拽
      if ((e.target as HTMLElement).closest('[data-role="close"]')) return;
      this.isDraggingPanel = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      const rect = this.root.getBoundingClientRect();
      this.dragStartLeft = rect.left;
      this.dragStartTop = rect.top;
      // 初始用 right 定位，拖拽时切换为 left/top
      this.root.style.right = 'auto';
      this.root.style.left = `${rect.left}px`;
      this.root.style.top = `${rect.top}px`;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.isDraggingPanel) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      const maxLeft = Math.max(0, window.innerWidth - this.root.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - this.root.offsetHeight);
      const left = Math.max(0, Math.min(maxLeft, this.dragStartLeft + dx));
      const top = Math.max(0, Math.min(maxTop, this.dragStartTop + dy));
      this.root.style.left = `${left}px`;
      this.root.style.top = `${top}px`;
    });
    window.addEventListener('mouseup', () => {
      this.isDraggingPanel = false;
    });
  }

  /** 右下角拖拽调整面板大小 */
  private bindResize() {
    const handle = document.createElement('div');
    handle.className = 'sp-resize-handle';
    handle.style.cssText = [
      'position:absolute', 'right:0', 'bottom:0', 'width:16px', 'height:16px',
      'cursor:nwse-resize', 'z-index:1',
      'background:linear-gradient(135deg, transparent 50%, rgba(125,211,252,0.35) 50%)',
    ].join(';');
    this.root.appendChild(handle);
    handle.addEventListener('mousedown', (e) => {
      this.isResizing = true;
      this.resizeStartX = e.clientX;
      this.resizeStartY = e.clientY;
      this.resizeStartW = this.root.offsetWidth;
      this.resizeStartH = this.root.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.isResizing) return;
      const dw = e.clientX - this.resizeStartX;
      const dh = e.clientY - this.resizeStartY;
      const maxW = window.innerWidth - 24;
      const maxH = window.innerHeight - 40;
      const width = Math.max(240, Math.min(maxW, this.resizeStartW + dw));
      const height = Math.max(160, Math.min(maxH, this.resizeStartH + dh));
      this.root.style.width = `${width}px`;
      this.root.style.height = `${height}px`;
    });
    window.addEventListener('mouseup', () => {
      this.isResizing = false;
    });
  }

  /** 渲染事件列表（倒序，过滤） */
  private renderList() {
    const filtered: PetLogEvent[] = [];
    const allEvents = this.events;
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const e = allEvents[i];
      if (this.filterPet && e.petId !== this.filterPet) continue;
      if (this.filterLevel && e.level !== this.filterLevel) continue;
      if (this.filterCat && !e.category.toLowerCase().includes(this.filterCat.toLowerCase())) continue;
      filtered.push(e);
      if (filtered.length >= MAX_RENDERED_EVENTS) break;
    }
    this.countsEl.textContent = `${filtered.length} / ${this.events.length} events`;
    // 用 DocumentFragment 批量插入
    const frag = document.createDocumentFragment();
    for (const e of filtered) frag.appendChild(this.renderEvent(e));
    this.listEl.innerHTML = '';
    this.listEl.appendChild(frag);
  }

  private renderEvent(e: PetLogEvent): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sp-evt';
    el.dataset.level = e.level;
    const ts = fmtTs(e.ts);
    // 提取 after 里的 frameIdx / currentActionId 让"动作内第几帧"和"PIXI 全局帧号"分得开
    const after: any = e.after;
    const actionFrame = after && typeof after.frameIdx === 'number'
      ? `<span class="sp-evt-ts">第${after.frameIdx + 1}帧</span>` : '';
    const actionName = after && typeof after.action === 'string'
      ? `<span class="sp-evt-action">→ ${after.action}</span>` : '';
    const detail = JSON.stringify({
      petId: e.petId, frame: e.frame, tsMs: Math.round(e.tsMs),
      before: e.before, after: e.after, meta: e.meta,
    }, null, 2);
    el.innerHTML = `
      <div class="sp-evt-line1">
        <span class="sp-evt-ts">${ts}</span>
        <span class="sp-evt-cat">${e.category}</span>
        ${e.petId ? `<span class="sp-evt-pet">@${e.petId}</span>` : ''}
        ${e.cause ? `<span class="sp-evt-cause">← ${e.cause}</span>` : ''}
        ${actionName}
        ${actionFrame}
        <span class="sp-evt-ts" title="PIXI 全局帧号">#${e.frame}</span>
      </div>
      <div class="sp-evt-detail">${detail}</div>
    `;
    el.addEventListener('click', () => el.classList.toggle('expanded'));
    return el;
  }

  /** 导出 JSON：包含事件 + 当前配置快照（用于还原现场） */
  private buildExportPayload() {
    const configDir = ((window as any).__deskpet_configDir as string) || '';
    const cfg: any = {};
    if (configDir) {
      try {
        // 同步读 fs 在 renderer 里没有，但可通过 process 直接读
        const fs = (window as any).require?.('fs');
        const path = (window as any).require?.('path');
        if (fs && path) {
          const cfgPath = path.join(configDir, 'config.json');
          if (fs.existsSync(cfgPath)) cfg.config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        }
      } catch { /* 静默：导出失败不影响调试 */ }
    }
    return {
      session: {
        exportedAt: new Date().toISOString(),
        totalEmitted: supervisorLog.diagnose().totalEmitted,
        bufferSize: supervisorLog.diagnose().filled,
      },
      events: this.events,
      ...cfg,
    };
  }

  private async exportJson() {
    const payload = this.buildExportPayload();
    const json = JSON.stringify(payload, null, 2);
    try {
      const fs = (window as any).require?.('fs');
      const path = (window as any).require?.('path');
      const dir = ((window as any).__deskpet_configDir as string) || '';
      if (fs && path && dir) {
        const fname = `deskpet-supervisor-${Date.now()}.json`;
        const fpath = path.join(dir, fname);
        fs.writeFileSync(fpath, json, 'utf-8');
        alert(`导出成功:\n${fpath}\n\n(${payload.events.length} events)`);
      } else {
        // 无 fs 时 fallback 到下载
        this.downloadBlob(json, `deskpet-supervisor-${Date.now()}.json`);
      }
    } catch (err: any) {
      alert('导出失败: ' + err.message);
    }
  }

  private async copyJson() {
    const payload = this.buildExportPayload();
    const json = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      // 简短反馈（toast 风格）
      this.countsEl.textContent = `✓ 已复制 ${payload.events.length} events 到剪贴板`;
      setTimeout(() => this.renderList(), 1500);
    } catch (err: any) {
      alert('复制失败: ' + err.message);
    }
  }

  private downloadBlob(content: string, filename: string) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}