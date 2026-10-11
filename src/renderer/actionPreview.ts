import type { SpriteResolver } from './SpriteResolver';
import { loadUserConfig } from './config';
import type { ActionDef, FrameRef, CharacterConfig } from './types';

/**
 * 动作预览面板（只读）：选角色 → 选动作 → 逐帧播放，并给出时序数据。
 *
 * 【为什么是「独立迷你播放器」而不是复用 Pet】
 * Pet 构造即产生副作用（gravity / meetPhase / coop 锁 / 全局 ticker），放进面板会自己走进
 * 攀爬 / 抛掷窗口，且无法干净地停在某��帧。本面板只做「看效果」，所以自带一个 ~60 行的
 * 帧推进器，只读 ActionDef 的帧集与时序字段，**不碰 Pet 的任何状态**。
 *
 * 【保真度边界（有意为之，界面上会标注）】
 * 完全一致：帧序、每帧时长（与 Pet.perFrameMs 同源，见下方 frameInterval）、循环语义、台词触发帧。
 * 静态示意：位移(vx/vy)、朝向翻转、contain-fit 缩放、offset 偏移 —— 这些依赖 Pet 的物理与
 * 容器上下文，预览里不做仿真。若要校验这些，请看 scripts/analyze-sprite-size.mjs 等离线工具。
 *
 * 本面板**不写任何文件**（P1 只读）。编辑能力（增删帧 / 调 frameMs / 新增动作）属 P2，
 * 届时必须注意：① 整读-改对象-JSON.stringify 整写（防重复键静默覆盖）；② 写前备份 .bak；
 * ③ 新字段同步进 config.ts 的 normalizeAction() 白名单；④ 编辑期暂停 app.ts 的热重载。
 */

/** 单帧时长：与 Pet.ts 的 frameMs(frames,i) / perFrameMs 同一套优先级，改一处必须同步另一处。 */
function frameMsOf(frames: FrameRef[], i: number): number | null {
  const f = frames[i];
  return typeof f !== 'string' && typeof f.ms === 'number' ? f.ms : null;
}

/** 第 i 帧的实际时长(ms)：帧级 ms > 动作级 frameMs > speed 推算。与 Pet.perFrameMs 完全同源。 */
function frameInterval(def: ActionDef, frames: FrameRef[], i: number): number {
  const own = frameMsOf(frames, i);
  if (own !== null) return own;
  const fps = (def.speed ?? 0.1) * 60;
  return typeof def.frameMs === 'number' && def.frameMs > 0 ? def.frameMs : 1000 / Math.max(1, fps);
}

/** 取帧名（FrameRef 可能是字符串或 {name,...}）。 */
function frameName(f: FrameRef): string {
  return typeof f === 'string' ? f : f.name;
}

export class ActionPreviewPanel {
  private el: HTMLDivElement;
  /** 面板是否打开中：必须登记进 app.ts reconcile() 的 blocked，否则面板显示时鼠标穿透会导致点不动。 */
  public static isOpen = false;

  private configDir: string;
  private resolver: SpriteResolver;

  private selChar: HTMLSelectElement;
  private selAction: HTMLSelectElement;
  private btnPlay: HTMLButtonElement;
  private btnStep: HTMLButtonElement;
  private btnLoop: HTMLButtonElement;
  private stage: HTMLDivElement;      // 播放区
  private img: HTMLImageElement;     // 当前帧
  private strip: HTMLDivElement;     // 帧缩略图网格
  private info: HTMLDivElement;      // 时序数据条
  private missing: HTMLDivElement;   // 加载失败的帧名提示

  /** 当前角色的全部帧名（manifest），用于「未引用帧置灰」 */
  private allFrames: string[] = [];
  private chars: CharacterConfig[] = [];

  /** 播放态 */
  private playing = false;
  private loop = true;
  private frameIdx = 0;
  private accum = 0;
  private lastTs = 0;
  private rafId = 0;
  /** 当前生效的帧集与定义（渲染与时序都以此为准，切换动作时整体替换） */
  private curDef: ActionDef | null = null;
  private curFrames: FrameRef[] = [];
  /** 贴图缓存：帧名 -> dataURL（避免每帧重读磁盘） */
  private texCache = new Map<string, string | null>();

  constructor(configDir: string, resolver: SpriteResolver) {
    this.configDir = configDir;
    this.resolver = resolver;

    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'z-index:9998', 'display:none', 'width:640px',
      'background:rgba(30,30,35,0.97)', 'color:#fff', 'font:13px/1.5 sans-serif',
      'border-radius:10px', 'padding:14px', 'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'user-select:none',
    ].join(';');
    document.body.appendChild(this.el);

    this.selChar = document.createElement('select');
    this.selAction = document.createElement('select');
    this.btnPlay = document.createElement('button');
    this.btnStep = document.createElement('button');
    this.btnLoop = document.createElement('button');
    this.stage = document.createElement('div');
    this.img = document.createElement('img');
    this.strip = document.createElement('div');
    this.info = document.createElement('div');
    this.missing = document.createElement('div');

    this.buildLayout();

    this.selChar.onchange = () => this.onCharChange();
    this.selAction.onchange = () => this.onActionChange();
    this.btnPlay.onclick = () => this.togglePlay();
    this.btnStep.onclick = () => { this.pause(); this.stepOnce(); };
    this.btnLoop.onclick = () => { this.loop = !this.loop; this.paintLoopBtn(); };

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  // ============ 布局 ============

  private buildLayout() {
    const sel = (el: HTMLSelectElement, w: number) => {
      el.style.cssText = `cursor:pointer;background:#1c1c22;color:#eee;border:1px solid #4a4a55;border-radius:4px;padding:3px 6px;font-size:12px;max-width:${w}px;`;
      return el;
    };
    const btn = (el: HTMLButtonElement, label: string) => {
      el.textContent = label;
      el.style.cssText = 'cursor:pointer;background:rgba(125,211,252,0.12);color:#7dd3fc;border:1px solid rgba(125,211,252,0.3);border-radius:4px;padding:3px 10px;font-size:12px;';
      return el;
    };

    // 标题行：左标题 + 右 ✕（与其它面板一致，底部另有一个「关闭 (Esc)」）
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    const title = document.createElement('div');
    title.textContent = '动作预览';
    title.style.cssText = 'font-weight:bold;font-size:15px;';
    const closeX = document.createElement('button');
    closeX.textContent = '✕';
    closeX.title = '关闭 (Esc)';
    closeX.style.cssText = 'cursor:pointer;background:transparent;color:#9a9aa8;border:none;font-size:15px;line-height:1;padding:2px 6px;border-radius:4px;';
    closeX.onmouseenter = () => { closeX.style.color = '#fff'; };
    closeX.onmouseleave = () => { closeX.style.color = '#9a9aa8'; };
    closeX.onclick = () => this.hide();
    titleRow.appendChild(title);
    titleRow.appendChild(closeX);
    this.el.appendChild(titleRow);

    // 控制行
    const ctrl = document.createElement('div');
    ctrl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;';
    const lbl = (t: string) => {
      const s = document.createElement('span');
      s.textContent = t;
      s.style.cssText = 'color:#9a9aa8;font-size:12px;';
      return s;
    };
    ctrl.appendChild(lbl('角色'));
    ctrl.appendChild(sel(this.selChar, 110));
    ctrl.appendChild(lbl('动作'));
    ctrl.appendChild(sel(this.selAction, 240));
    ctrl.appendChild(btn(this.btnPlay, '▶ 播放'));
    ctrl.appendChild(btn(this.btnStep, '⏭ 单帧'));
    ctrl.appendChild(btn(this.btnLoop, '🔁 循环：开'));
    this.el.appendChild(ctrl);

    // 主体：左=帧缩略图网格，右=播放区
    const main = document.createElement('div');
    main.style.cssText = 'display:flex;gap:12px;align-items:flex-start;';

    this.strip.style.cssText = [
      'flex:0 0 300px', 'height:300px', 'overflow-y:auto', 'display:flex', 'flex-wrap:wrap',
      'gap:4px', 'padding:6px', 'background:rgba(0,0,0,0.25)', 'border-radius:6px',
      'align-content:flex-start',
    ].join(';');
    main.appendChild(this.strip);

    this.stage.style.cssText = [
      'flex:1', 'height:300px', 'display:flex', 'align-items:center', 'justify-content:center',
      'background:repeating-conic-gradient(#2a2a32 0% 25%,#23232a 0% 50%) 50%/16px 16px',
      'border-radius:6px', 'position:relative', 'overflow:hidden',
    ].join(';');
    this.img.style.cssText = 'max-width:96%;max-height:96%;image-rendering:auto;';
    this.stage.appendChild(this.img);
    main.appendChild(this.stage);

    this.el.appendChild(main);

    // 时序数据条
    this.info.style.cssText = 'margin-top:10px;font:12px/1.7 ui-monospace,Consolas,monospace;color:#cfcfd8;';
    this.el.appendChild(this.info);

    // 缺帧提示
    this.missing.style.cssText = 'margin-top:6px;font-size:11px;color:#f0a05a;max-height:56px;overflow-y:auto;';
    this.el.appendChild(this.missing);

    // 保真度说明
    const note = document.createElement('div');
    note.textContent = '仅预览帧序与节奏；位移/朝向/缩放为静态示意，不做物理仿真。';
    note.style.cssText = 'margin-top:8px;font-size:11px;color:#6e6e7c;';
    this.el.appendChild(note);

    // 底部关闭（与 managerPanel / settingsPanel / aboutPanel 同一套收口）
    const close = document.createElement('div');
    close.textContent = '关闭 (Esc)';
    close.style.cssText = 'margin-top:12px;text-align:center;cursor:pointer;color:#9ab4ff;';
    close.onclick = () => this.hide();
    this.el.appendChild(close);
  }

  private paintLoopBtn() {
    this.btnLoop.textContent = this.loop ? '🔁 循环：开' : '🔁 循环：关';
  }

  // ============ 打开 / 关闭 ============

  show() {
    this.chars = loadUserConfig(this.configDir);
    this.fillCharOptions();
    this.el.style.display = 'block';
    ActionPreviewPanel.isOpen = true;
    if (!this.curDef) this.pause();
  }

  hide() {
    if (this.el.style.display === 'none') return;
    this.pause();
    this.el.style.display = 'none';
    ActionPreviewPanel.isOpen = false;
    // 关闭后按最后光标坐标重算穿透态（与 settingsPanel / aboutPanel / windowListPanel 同一套收口）。
    // 少这行 → 面板开着时 reconcile 是「强制捕获」，关掉后窗口会残留捕获态，桌面点不动，
    // 必须再动一下鼠标才自愈（就是「点完还要点任务栏」那类问题）。
    window.dispatchEvent(new CustomEvent('context-menu-closed'));
  }

  private fillCharOptions() {
    this.selChar.innerHTML = '';
    for (const c of this.chars) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.name}（${c.id}）`;
      this.selChar.appendChild(o);
    }
    if (this.chars.length > 0) {
      this.selChar.value = this.chars[0].id;
      this.onCharChange();
    }
  }

  private onCharChange() {
    const id = this.selChar.value;
    const cfg = this.chars.find((c) => c.id === id);
    // 换角色 → 清缓存与所有派生状态（action 下拉、帧集、孤儿判定都要重算）
    this.texCache.clear();
    this.curDef = null;
    this.curFrames = [];
    this.pause();

    // manifest 里该角色的全部帧名（拿不到时退化为空，缩略图区会提示）
    const mf = this.resolver.manifest?.frames?.[id];
    this.allFrames = mf ? Object.keys(mf) : [];

    this.selAction.innerHTML = '';
    if (!cfg) { this.paint(); return; }
    const ids = Object.keys(cfg.actions || {});
    for (const aid of ids) {
      const def = cfg.actions[aid];
      const o = document.createElement('option');
      o.value = aid;
      o.textContent = def.label ? `${def.label}（${aid}）` : aid;
      this.selAction.appendChild(o);
    }
    if (ids.length > 0) {
      this.selAction.value = ids[0];
      this.onActionChange();
    } else {
      this.paint();
    }
  }

  private onActionChange() {
    const cfg = this.chars.find((c) => c.id === this.selChar.value);
    const def = cfg?.actions?.[this.selAction.value];
    if (!def) { this.curDef = null; this.curFrames = []; this.paint(); return; }
    this.curDef = def;
    this.curFrames = Array.isArray(def.frames) ? def.frames : [];
    this.frameIdx = 0;
    this.accum = 0;
    this.paintStrip();
    this.showFrame(0);
  }

  // ============ 播放 ============

  private togglePlay() {
    if (this.playing) { this.pause(); return; }
    if (this.curFrames.length === 0) return;
    // 播到末帧后再按播放：从头开始，符合直觉
    if (this.frameIdx >= this.curFrames.length - 1) this.frameIdx = 0;
    this.playing = true;
    this.btnPlay.textContent = '⏸ 暂停';
    this.lastTs = performance.now();
    const loopFn = (ts: number) => {
      if (!this.playing) return;
      // dt 夹到当前帧时长：掉帧时只暂停、不跳帧（与 Pet.tickAnimation 同一处理）
      const interval = this.intervalAt(this.frameIdx);
      const dt = Math.min(ts - this.lastTs, interval);
      this.lastTs = ts;
      this.accum += dt;
      if (this.accum >= interval) {
        this.accum -= interval;
        const last = this.frameIdx >= this.curFrames.length - 1;
        if (last) {
          if (this.loop) { this.frameIdx = 0; }
          else { this.pause(); }   // 非循环：停在末帧
        } else {
          this.frameIdx++;
        }
        this.showFrame(this.frameIdx);
      }
      this.rafId = requestAnimationFrame(loopFn);
    };
    this.rafId = requestAnimationFrame(loopFn);
  }

  private pause() {
    this.playing = false;
    this.btnPlay.textContent = '▶ 播放';
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private stepOnce() {
    if (this.curFrames.length === 0) return;
    this.frameIdx = (this.frameIdx + 1) % this.curFrames.length;
    this.showFrame(this.frameIdx);
  }

  private intervalAt(i: number): number {
    return frameInterval(this.curDef as ActionDef, this.curFrames, i);
  }

  /** 载入并显示第 i 帧。 */
  private showFrame(i: number) {
    const name = frameName(this.curFrames[i]);
    const url = this.texFor(name);
    if (url) {
      this.img.src = url;
      this.img.style.visibility = 'visible';
    } else {
      this.img.removeAttribute('src');
      this.img.style.visibility = 'visible';
    }
    this.paint();
  }

  /** 取帧贴图 dataURL（带缓存）。帧名不在 manifest 时返回 null。
   *  走 SpriteResolver.frameDataUrl —— 与 Pet 实际加载同一套路径解析，不依赖 Pixi 内部结构。 */
  private texFor(frameNameStr: string): string | null {
    if (this.texCache.has(frameNameStr)) return this.texCache.get(frameNameStr) ?? null;
    let url: string | null = null;
    try {
      url = this.resolver.frameDataUrl(this.selChar.value, frameNameStr);
    } catch { /* 缺帧/读取失败 -> null，走占位 */ }
    this.texCache.set(frameNameStr, url);
    return url;
  }

  // ============ 绘制 ============

  /** 帧缩略图网格：当前动作引用的帧高亮可用，其余（manifest 里有但未被引用）置灰 = 孤儿帧。 */
  private paintStrip() {
    this.strip.innerHTML = '';
    const used = new Set(this.curFrames.map(frameName));
    if (this.allFrames.length === 0) {
      const e = document.createElement('div');
      e.textContent = `未能读取「${this.selChar.value}」的帧名映射（config/images/${this.selChar.value}.json）`;
      e.style.cssText = 'color:#f0a05a;font-size:11px;';
      this.strip.appendChild(e);
      return;
    }
    for (const name of this.allFrames) {
      const cell = document.createElement('div');
      const isUsed = used.has(name);
      cell.style.cssText = [
        'width:44px', 'height:44px', 'border-radius:4px', 'overflow:hidden',
        'border:1px solid ' + (isUsed ? 'rgba(125,211,252,0.55)' : 'rgba(255,255,255,0.08)'),
        'opacity:' + (isUsed ? '1' : '0.28'),
        'cursor:default', 'position:relative',
        'background:#191920', 'display:flex', 'align-items:center', 'justify-content:center',
      ].join(';');
      cell.title = name + (isUsed ? '' : '（未被当前动作引用）');
      // 缩略图：懒加载（同步取 dataURL，失败则留空格子）
      const url = this.texFor(name);
      if (url) {
        const im = document.createElement('img');
        im.src = url;
        im.style.cssText = 'max-width:100%;max-height:100%;';
        cell.appendChild(im);
      }
      this.strip.appendChild(cell);
    }
  }

  /** 时序数据条 + 缺帧提示 + 帧网格高亮。 */
  private paint() {
    const def = this.curDef;
    if (!def) {
      this.info.textContent = this.chars.length ? '（该角色没有动作定义）' : '（未找到任何角色配置）';
      this.missing.textContent = '';
      return;
    }
    const n = this.curFrames.length;
    const cur = Math.min(this.frameIdx, Math.max(0, n - 1));
    const curMs = this.intervalAt(cur);
    // 累计到当前帧（含）的时间
    let passed = 0;
    for (let i = 0; i < cur; i++) passed += this.intervalAt(i);
    let total = 0;
    for (let i = 0; i < n; i++) total += this.intervalAt(i);
    const perFrame = typeof def.frameMs === 'number' && def.frameMs > 0
      ? `frameMs=${def.frameMs}`
      : `speed=${def.speed ?? 0.1}(fps=${((def.speed ?? 0.1) * 60).toFixed(1)})`;
    const mixed = n > 0 && this.curFrames.some((f) => typeof f !== 'string');

    this.info.textContent =
      `帧 ${cur + 1}/${n}   本帧 ${curMs}ms   累计 ${(passed / 1000).toFixed(2)}s / 总 ${(total / 1000).toFixed(2)}s\n`
      + `behavior=${def.behavior}   ${perFrame}${mixed ? '（部分帧含独立 ms/vx/scale）' : ''}   `
      + `loop=${def.loop !== false}   ${def.width || def.height ? `size=${def.width ?? '-'}x${def.height ?? '-'}` : ''}`
      + `${def.durationMs !== undefined ? `   durationMs=${def.durationMs}` : ''}`
      + `${def.dialogue ? `   台词：${JSON.stringify(def.dialogue)}` : ''}`;

    // 缺帧检查：frames 里的帧名不在 manifest 中（配错 id 时很有用）
    const bad = Array.from(new Set(this.curFrames.map(frameName)))
      .filter((fn) => !(this.resolver.manifest?.frames?.[this.selChar.value]?.[fn]));
    this.missing.textContent = bad.length
      ? `⚠ 以下帧名在 config/images/${this.selChar.value}.json 中不存在，播放区会空白：${bad.join('、')}`
      : '';

    // 当前帧在网格里加个高亮框
    const curName = frameName(this.curFrames[cur] ?? '');
    let k = 0;
    for (const cell of Array.from(this.strip.children) as HTMLElement[]) {
      if (cell.tagName !== 'DIV') continue;
      const nm = cell.title?.replace('（未被当前动作引用）', '');
      if (nm === curName) {
        cell.style.outline = '2px solid #7dd3fc';
        if (k++ === 0) cell.scrollIntoView({ block: 'nearest' });
      } else {
        cell.style.outline = 'none';
      }
    }
  }
}
