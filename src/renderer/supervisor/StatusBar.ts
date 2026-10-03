/**
 * 监管子系统：状态快照条
 * --------------------------------------------------------------
 * 监管浮窗的「顶栏」——一行恒显当前帧所有 pet 状态。
 *
 * 为什么单独抽出来：
 * - 卡死第一信号不是看事件流，而是看这行字 200ms 没变
 * - 状态条只读、不订阅日志流、不参与 IPC —— 性能开销可忽略
 * - 即使监管浮窗被折叠也始终可见（用户随时查）
 *
 * 数据来源：
 * - 每帧从 PIXI ticker 里读取（不在这里再加 ticker，独立一个 setInterval 16ms）
 * - 通过 Pet.getAll() 拿全部 pet 的当前 action / x / y / frame
 *
 * 显示格式：
 * [rose] walk L · x=820 y=900 · frame=2/4 · vx=+2.0 [nina] static · x=1100 y=912 · frame=1/1
 */

import { Pet } from '../Pet';
import { supervisorLog } from './eventLog';

const STYLE_ID = 'deskpet-supervisor-statusbar';

function ensureStylesInjected() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #${STYLE_ID}-root {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 999999;
      pointer-events: none;
      font-family: ui-monospace, "Cascadia Code", Consolas, "SF Mono", Menlo, "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
      font-size: 11px;
      line-height: 1.4;
      color: #e0e0e0;
      background: rgba(15, 15, 20, 0.78);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      padding: 4px 10px;
      display: none; /* 默认隐藏，supervisor.show() 时切 block */
      white-space: nowrap;
      overflow-x: auto;
    }
    #${STYLE_ID}-root.visible { display: block; }
    #${STYLE_ID}-root .sb-pet {
      display: inline-block;
      margin-right: 16px;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.04);
    }
    #${STYLE_ID}-root .sb-pet.stalled { background: rgba(255, 80, 80, 0.25); }
    #${STYLE_ID}-root .sb-pet-id { color: #7dd3fc; font-weight: 600; }
    #${STYLE_ID}-root .sb-meta { color: #888; margin-left: 4px; }
    #${STYLE_ID}-root .sb-fps { color: #fbbf24; margin-left: 12px; }
  `;
  document.head.appendChild(s);
}

export class StatusBar {
  private root: HTMLElement;
  private rafHandle: number | null = null;
  private lastSnapshotKey = '';
  private lastChangeTs = 0;
  private fpsBuf: number[] = [];
  private lastTickTs = 0;
  private fps = 0;
  private visible = false;

  constructor() {
    ensureStylesInjected();
    this.root = document.createElement('div');
    this.root.id = `${STYLE_ID}-root`;
    document.body.appendChild(this.root);
  }

  /** 显示/隐藏状态条（监管窗口唤出时一并显示） */
  setVisible(v: boolean) {
    this.visible = v;
    if (v) {
      this.root.classList.add('visible');
      this.startLoop();
    } else {
      this.root.classList.remove('visible');
      this.stopLoop();
    }
  }

  isVisible() {
    return this.visible;
  }

  /** 启动每帧 RAF 循环 */
  private startLoop() {
    if (this.rafHandle !== null) return;
    const tick = () => {
      this.render();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  /** 单帧渲染：状态条 + FPS */
  private render() {
    const now = performance.now();
    if (this.lastTickTs > 0) {
      const dt = now - this.lastTickTs;
      const fps = 1000 / Math.max(1, dt);
      this.fpsBuf.push(fps);
      if (this.fpsBuf.length > 30) this.fpsBuf.shift();
      this.fps = this.fpsBuf.reduce((s, v) => s + v, 0) / this.fpsBuf.length;
    }
    this.lastTickTs = now;

    const pets = Pet.getAll();
    const parts: string[] = [];
    let snapKey = '';
    for (const p of pets) {
      const pos = p.getPosition();
      const action = p.currentActionId;
      const facing = (p as any).facingRight ? 'R' : 'L';
      const fi = (p as any).frameIdx ?? 0;
      const total = (p as any).actionTextures?.length ?? 1;
      const vx = (p as any).vx ?? 0;
      const vxStr = (vx > 0 ? '+' : '') + vx.toFixed(1);
      const x = Math.round(pos.x);
      const y = Math.round(pos.y);
      const seg = `<span class="sb-pet-id">${p.config.id}</span> ${action} ${facing} · x=${x} y=${y} · frame=${fi + 1}/${total} · vx=${vxStr}`;
      parts.push(`<span class="sb-pet" data-pet="${p.config.id}">${seg}</span>`);
      snapKey += `${p.config.id}:${action}:${facing}:${x}:${y}:${fi}|`;
    }
    // 卡死检测：快照无变化 ≥ 2s 标红
    const petEls = Array.from(this.root.querySelectorAll('.sb-pet'));
    if (snapKey === this.lastSnapshotKey) {
      if (this.lastChangeTs === 0) this.lastChangeTs = now;
      const stallMs = now - this.lastChangeTs;
      if (stallMs > 2000) {
        for (const el of petEls) el.classList.add('stalled');
      }
    } else {
      this.lastSnapshotKey = snapKey;
      this.lastChangeTs = now;
      for (const el of petEls) el.classList.remove('stalled');
    }
    // FPS
    parts.push(`<span class="sb-fps">FPS ${this.fps.toFixed(1)}</span>`);
    // 诊断按钮（点击唤出监管浮窗）
    parts.push(`<span class="sb-meta" style="float:right">events ${supervisorLog.diagnose().totalEmitted} · ⌃⇧D 唤出监管</span>`);
    this.root.innerHTML = parts.join('');
  }
}