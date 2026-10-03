/**
 * 设置面板 —— 右键菜单「设置」打开。
 *
 * 定位：把原来散在右键一级菜单里的配置项收拢到一处（对齐常见桌面软件的
 * 「托盘/右键 → 设置」习惯，而不是把开关和动作混在同一层菜单）。
 *
 * 当前收纳：
 *   1. 自定义可互动窗口    → 二级子面板（WindowListPanel，原版 ChooseInteractiveWindows）
 *   2. 投掷窗口（开关）    → 等价原版菜单项 ThrowingWindows，写回 config/config.json
 *
 * 「窗口归还」已从本面板移出：它是一次性动作、不该藏进配置，改为与「设置」并列放在
 * 系统托盘菜单（2026-09-26 拍板）；renderer 侧通过 win-restore-request IPC 触发
 * WindowInteract.restoreWindows()（先 stop() 中止演出再归还，避免动画抢窗口）。
 *
 * 面板打开期间必须纳入 app.ts 的 reconcile blocked 判定（见 static isOpen），
 * 否则鼠标点不动面板上的按钮。
 */
import { WindowConfig } from './config';

export class SettingsPanel {
  /** 是否打开中：供 app.ts 的 reconcile() 判定阻塞态。 */
  public static isOpen = false;

  private el: HTMLDivElement;
  private cfg: WindowConfig;
  /** 配置变更（名单 / 投掷开关 / 投掷频率）→ 通知 app 更新内存并在需要时落盘。 */
  private onConfigChange: (patch: { throwEnabled?: boolean; whitelist?: string[]; throwRollMs?: number; throwChance?: number }) => void;
  /** 打开「自定义可互动窗口」子面板。 */
  private openWindowList: () => void;
  /** koffi 是否可用（不可用时窗口系条目整体隐藏，与右键菜单保持一致）。 */
  private winOk: boolean;
  private note = '';
  private noteOk = true;

  constructor(opts: {
    cfg: WindowConfig;
    winOk: boolean;
    onConfigChange: (patch: { throwEnabled?: boolean; whitelist?: string[]; throwRollMs?: number; throwChance?: number }) => void;
    openWindowList: () => void;
  }) {
    this.cfg = { ...opts.cfg, whitelist: opts.cfg.whitelist.slice() };
    this.winOk = opts.winOk;
    this.onConfigChange = opts.onConfigChange;
    this.openWindowList = opts.openWindowList;

    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'z-index:9998', 'display:none', 'width:340px',
      'background:rgba(30,30,35,0.97)', 'color:#fff', 'font:13px/1.5 sans-serif',
      'border-radius:10px', 'padding:16px', 'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'user-select:none',
    ].join(';');
    document.body.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  /** cfg 由 app 侧持有，打开时同步一次，避免面板显示的是过期快照。 */
  show(cfg: WindowConfig) {
    this.cfg = { ...cfg, whitelist: cfg.whitelist.slice() };
    this.note = '';
    this.render();
    this.el.style.display = 'block';
    SettingsPanel.isOpen = true;
  }

  hide() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
    SettingsPanel.isOpen = false;
    // 关闭后按最后光标坐标重算穿透态（与其它面板同一套收口逻辑）
    window.dispatchEvent(new CustomEvent('context-menu-closed'));
  }

  /** 刷新面板持有的配置快照（子面板保存后回来会用到）。 */
  syncConfig(cfg: WindowConfig) {
    this.cfg = { ...cfg, whitelist: cfg.whitelist.slice() };
  }

  private render() {
    this.el.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = '设置';
    title.style.cssText = 'font-weight:bold;font-size:15px;margin-bottom:12px;';
    this.el.appendChild(title);

    // —— 窗口互动（koffi 不可用时整节隐藏）——
    if (this.winOk) {
      this.el.appendChild(this.sectionTitle('窗口互动'));

      this.el.appendChild(this.linkRow(
        '自定义可互动窗口…',
        '维护「可以被角色搬走／甩出去」的窗口标题名单',
        () => { this.hide(); this.openWindowList(); },
      ));

      this.el.appendChild(this.checkRow(
        '投掷窗口',
        '允许角色自动随机找窗口搬走并甩出去（对齐原版 ThrowingWindows）',
        this.cfg.throwEnabled,
        (v) => {
          this.cfg.throwEnabled = v;
          this.onConfigChange({ throwEnabled: v });
          this.setNote(v ? '已开启：达到间隔后角色会自己找窗口搬走' : '已关闭：只能在右键菜单里手动「搬走一个窗口」', true);
          this.render();
        },
      ));

      // 频率控件只在开启时才显示：关着的时候调频率没有意义，避免面板堆无用项。
      if (this.cfg.throwEnabled) {
        this.el.appendChild(this.numRow(
          '投掷间隔',
          '每隔多久掷一次骰子决定要不要去搬窗口',
          this.cfg.throwRollMs,
          { unit: '秒', min: 5, max: 3600, step: 5, toDisplay: (v) => Math.round(v / 1000), fromDisplay: (v) => v * 1000 },
          (v) => {
            this.cfg.throwRollMs = v;
            this.onConfigChange({ throwRollMs: v });
            this.setNote('投掷间隔已改为 ' + Math.round(v / 1000) + ' 秒', true);
            this.render();
          },
        ));
        this.el.appendChild(this.numRow(
          '命中概率',
          '每次掷骰命中才会真的去搬窗口（原有角色需配齐投掷帧，现已全员支持）',
          this.cfg.throwChance,
          { unit: '%', min: 1, max: 100, step: 1, toDisplay: (v) => Math.round(v * 100), fromDisplay: (v) => v / 100 },
          (v) => {
            this.cfg.throwChance = v;
            this.onConfigChange({ throwChance: v });
            this.setNote('命中概率已改为 ' + Math.round(v * 100) + '%', true);
            this.render();
          },
        ));
      }

      const wlHint = document.createElement('div');
      wlHint.textContent = '当前名单 ' + this.cfg.whitelist.length + ' 条'
        + (this.cfg.whitelist.length === 0 ? '（空 = 不限制，任何窗口都能被搬走）' : '：' + this.cfg.whitelist.slice(0, 4).join('、')
          + (this.cfg.whitelist.length > 4 ? ' 等' : ''));
      wlHint.style.cssText = 'font-size:11px;opacity:0.55;margin:2px 0 4px;line-height:1.5;word-break:break-all;';
      this.el.appendChild(wlHint);
    } else {
      const na = document.createElement('div');
      na.textContent = '窗口互动不可用（未能加载 Win32 接口）';
      na.style.cssText = 'font-size:12px;opacity:0.6;background:rgba(255,255,255,0.06);border-radius:6px;padding:8px;';
      this.el.appendChild(na);
    }

    // —— 关于 ——
    this.el.appendChild(this.sectionTitle('关于'));
    this.el.appendChild(this.linkRow(
      '关于 DeskPet',
      '版本、作者、开源许可、数据目录',
      () => {
        this.hide();
        window.dispatchEvent(new CustomEvent('open-about-panel'));
      },
    ));

    // —— 提示行 ——
    if (this.note) {
      const st = document.createElement('div');
      st.textContent = this.note;
      st.style.cssText = 'font-size:11px;margin-top:10px;line-height:1.5;color:' + (this.noteOk ? '#8ee28e' : '#ffb0b0') + ';';
      this.el.appendChild(st);
    }

    const close = document.createElement('div');
    close.textContent = '关闭 (Esc)';
    close.style.cssText = 'margin-top:12px;text-align:center;cursor:pointer;color:#9ab4ff;';
    close.onclick = () => this.hide();
    this.el.appendChild(close);
  }

  private setNote(text: string, ok: boolean) {
    this.note = text;
    this.noteOk = ok;
  }

  private sectionTitle(text: string): HTMLDivElement {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'font-size:11px;letter-spacing:0.08em;opacity:0.5;text-transform:uppercase;'
      + 'margin:10px 0 4px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);';
    return t;
  }

  /** 可点条目：主标题 + 灰色说明。整行可点。 */
  private linkRow(label: string, desc: string, onClick: () => void): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'padding:6px 8px;border-radius:6px;cursor:pointer;';
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.08)'; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    const l = document.createElement('div');
    l.textContent = label;
    const d = document.createElement('div');
    d.textContent = desc;
    d.style.cssText = 'font-size:11px;opacity:0.5;line-height:1.4;';
    row.appendChild(l);
    row.appendChild(d);
    row.onclick = onClick;
    return row;
  }

  /** 开关条目：左侧勾选框 + 主标题 + 灰色说明。 */
  private checkRow(label: string, desc: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;';
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.08)'; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = checked;
    chk.style.cssText = 'margin-top:3px;cursor:pointer;';
    const box = document.createElement('div');
    const l = document.createElement('div');
    l.textContent = label;
    const d = document.createElement('div');
    d.textContent = desc;
    d.style.cssText = 'font-size:11px;opacity:0.5;line-height:1.4;';
    box.appendChild(l);
    box.appendChild(d);
    row.appendChild(chk);
    row.appendChild(box);
    chk.onchange = () => onChange(chk.checked);
    return row;
  }

  /** 数值条目：主标题 + 灰色说明 + 右侧「− 输入 +」步进器。
   *  内部值(value) 与显示值(display) 可用 toDisplay/fromDisplay 换算（如 ms ↔ 秒、0~1 ↔ %）。 */
  private numRow(
    label: string,
    desc: string,
    value: number,
    opt: {
      unit: string; min: number; max: number; step: number;
      toDisplay: (v: number) => number;
      fromDisplay: (v: number) => number;
    },
    onChange: (v: number) => void,
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'padding:6px 8px;border-radius:6px;';
    const head = document.createElement('div');
    head.textContent = label;
    const d = document.createElement('div');
    d.textContent = desc;
    d.style.cssText = 'font-size:11px;opacity:0.5;line-height:1.4;margin-bottom:6px;';
    row.appendChild(head);
    row.appendChild(d);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const disp = opt.toDisplay(value);
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(disp);
    input.min = String(opt.min);
    input.max = String(opt.max);
    input.step = String(opt.step);
    input.style.cssText = 'width:78px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);'
      + 'border-radius:5px;padding:3px 6px;font:inherit;text-align:center;';

    /** 提交：夹进 [min,max]，换算回内部值；非法输入回滚到当前值。 */
    const commit = (raw: number) => {
      if (!Number.isFinite(raw)) { input.value = String(opt.toDisplay(value)); return; }
      const clamped = Math.max(opt.min, Math.min(opt.max, raw));
      input.value = String(clamped);
      onChange(opt.fromDisplay(clamped));
    };

    const step = (delta: number) => {
      const cur = Number(input.value);
      commit((Number.isFinite(cur) ? cur : opt.toDisplay(value)) + delta * opt.step);
    };

    const mkBtn = (text: string, delta: number) => {
      const b = document.createElement('div');
      b.textContent = text;
      b.style.cssText = 'width:24px;height:24px;line-height:22px;text-align:center;cursor:pointer;'
        + 'background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:5px;user-select:none;';
      b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,0.2)'; };
      b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,0.1)'; };
      b.onclick = () => step(delta);
      return b;
    };

    input.onchange = () => commit(Number(input.value));
    input.onkeydown = (e) => { if (e.key === 'Enter') { commit(Number(input.value)); input.blur(); } };

    const unit = document.createElement('span');
    unit.textContent = opt.unit;
    unit.style.cssText = 'font-size:11px;opacity:0.55;';

    const minus = mkBtn('−', -1);
    const plus = mkBtn('+', 1);
    wrap.appendChild(minus);
    wrap.appendChild(input);
    wrap.appendChild(plus);
    wrap.appendChild(unit);
    row.appendChild(wrap);
    return row;
  }
}
