/**
 * 「自定义可互动窗口」面板 —— 对齐原版 Shimeji 的菜单项「自定义可互动窗口...」
 * （language_zh.properties: ChooseInteractiveWindows / InteractiveWindows / AddInteractiveWindow /
 *  InteractiveWindowHintMessage，对应 SettingsWindow 里的 lstInteractiveWindows +
 *  btnAddInteractiveWindow / btnRemoveInteractiveWindow，最终写回 settings.properties）。
 *
 * 用途：维护「可以被角色搬走/投掷」的窗口标题名单。原版语义是 **标题包含即命中**，
 * 所以这里既可以手输标题片段，也可以从当前打开的窗口里点选，避免把标题敲错。
 *
 * 写回 config/config.json 的 window.whitelist / window.throwEnabled，保存后立即生效
 * （名单在每次发起演出时实时透传给主进程枚举，不需要重启）。
 */
import { loadWindowConfig, saveWindowConfig, WindowConfig } from './config';

const req: any = (window as any).require;
const { ipcRenderer } = req('electron');

export class WindowListPanel {
  /** 面板是否打开中：供 app.ts 的 reconcile() 判定阻塞态（打开时必须捕获鼠标，否则点不动）。 */
  public static isOpen = false;

  private el: HTMLDivElement;
  private configDir: string;
  private cfg: WindowConfig;
  private onChange: (cfg: WindowConfig) => void;
  private openWins: string[] = [];
  private status = '';
  private statusOk = true;
  private input = '';

  constructor(configDir: string, initial: WindowConfig, onChange: (cfg: WindowConfig) => void) {
    this.configDir = configDir;
    this.cfg = { ...initial, whitelist: initial.whitelist.slice() };
    this.onChange = onChange;

    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'z-index:9999', 'display:none', 'width:380px', 'max-height:82vh', 'overflow:auto',
      'background:rgba(30,30,35,0.97)', 'color:#fff', 'font:13px/1.5 sans-serif',
      'border-radius:10px', 'padding:16px', 'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'user-select:none',
    ].join(';');
    document.body.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  async show() {
    this.status = '';
    const cur = loadWindowConfig(this.configDir);
    this.cfg = { ...cur, whitelist: cur.whitelist.slice() };
    this.el.style.display = 'block';
    WindowListPanel.isOpen = true;
    try { ipcRenderer.send('focus-pet-window'); } catch { /* ignore */ }
    this.render();
    await this.refreshOpenWindows();
  }

  hide() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
    WindowListPanel.isOpen = false;
    // 关闭后立刻按「最后光标坐标」重算穿透态，避免残留捕获态导致桌面点不动
    window.dispatchEvent(new CustomEvent('context-menu-closed'));
    // 从设置面板进入时，回到设置面板（子面板 → 父面板的返回链）
    const back = this.onHidden;
    if (back) back();
  }

  /** 枚举当前打开的窗口标题（不带名单过滤）。koffi 不可用时返回空。 */
  private async refreshOpenWindows() {
    try {
      const wins: { title?: string }[] = await ipcRenderer.invoke('win-list');
      this.openWins = (wins || []).map((w) => w.title || '').filter((t) => t.length > 0);
    } catch { this.openWins = []; }
    if (WindowListPanel.isOpen) this.render();
  }

  /** 落盘 + 通知 app 更新内存配置。失败时在面板上提示（不静默失败）。 */
  private persist() {
    const ok = saveWindowConfig(this.configDir, {
      whitelist: this.cfg.whitelist, throwEnabled: this.cfg.throwEnabled,
    });
    this.statusOk = ok;
    this.status = ok
      ? '已保存到 config/config.json（立即生效）'
      : '写入 config/config.json 失败（目录只读？）—— 本次仅内存生效';
    this.onChange({ ...this.cfg, whitelist: this.cfg.whitelist.slice() });
  }

  private addEntry(title: string) {
    const t = title.trim();
    if (t.length === 0) { this.status = '请输入窗口标题文字'; this.statusOk = false; this.render(); return; }
    if (t.includes('/')) { this.status = '标题里不能有 "/" 字符（原版限制）'; this.statusOk = false; this.render(); return; }
    if (this.cfg.whitelist.includes(t)) { this.status = '「' + t + '」已经在名单里了'; this.statusOk = false; this.render(); return; }
    this.cfg.whitelist.push(t);
    this.persist();
    this.render();
  }

  private removeEntry(title: string) {
    this.cfg.whitelist = this.cfg.whitelist.filter((w) => w !== title);
    this.persist();
    this.render();
  }

  /** 外部（设置面板）可指定「关闭/完成」后回到哪里，避免关掉子面板就把用户丢回桌面。 */
  public onHidden: (() => void) | null = null;

  private render() {
    this.el.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = '自定义可互动窗口';
    title.style.cssText = 'font-weight:bold;font-size:15px;margin-bottom:6px;';
    this.el.appendChild(title);

    const hint = document.createElement('div');
    hint.textContent = '标题「包含」下面任意一条，那个窗口就能被角色搬走／甩出去。'
      + '输入你的标题文字，请不要有 "/" 字符！（区分大小写）';
    hint.style.cssText = 'font-size:11px;opacity:0.65;line-height:1.5;margin-bottom:10px;';
    this.el.appendChild(hint);

    // —— 增加一条 ——
    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = this.input;
    input.placeholder = '窗口标题的一部分，如 微信';
    input.style.cssText = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);'
      + 'border-radius:6px;color:#fff;font:13px sans-serif;padding:6px 8px;outline:none;';
    input.oninput = () => { this.input = input.value; };
    input.onkeydown = (e) => { if (e.key === 'Enter') { this.input = input.value; this.addEntry(input.value); } };
    const addBtn = document.createElement('button');
    addBtn.textContent = '增加';
    addBtn.style.cssText = 'background:#3a6df0;border:none;border-radius:6px;color:#fff;font:13px sans-serif;padding:6px 12px;cursor:pointer;';
    addBtn.onclick = () => this.addEntry(this.input);
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    this.el.appendChild(addRow);

    // —— 名单列表 ——
    const listBox = document.createElement('div');
    listBox.style.cssText = 'max-height:190px;overflow:auto;border:1px solid rgba(255,255,255,0.12);'
      + 'border-radius:6px;padding:4px;margin-bottom:10px;background:rgba(0,0,0,0.18);';
    if (this.cfg.whitelist.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '（名单为空 = 不限制：任何窗口都能被搬走）';
      empty.style.cssText = 'padding:8px;opacity:0.5;font-size:12px;';
      listBox.appendChild(empty);
    }
    for (const w of this.cfg.whitelist) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;';
      row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.08)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const txt = document.createElement('span');
      txt.textContent = w;
      txt.style.flex = '1';
      const del = document.createElement('span');
      del.textContent = '×';
      del.title = '从名单移除';
      del.style.cssText = 'cursor:pointer;opacity:0.6;padding:0 6px;font-size:15px;';
      del.onmouseenter = () => { del.style.opacity = '1'; };
      del.onmouseleave = () => { del.style.opacity = '0.6'; };
      del.onclick = () => this.removeEntry(w);
      row.appendChild(txt);
      row.appendChild(del);
      listBox.appendChild(row);
    }
    this.el.appendChild(listBox);

    // —— 从当前打开的窗口里点选 ——
    const subHead = document.createElement('div');
    subHead.style.cssText = 'font-size:12px;opacity:0.75;margin-bottom:4px;';
    subHead.textContent = '当前打开的窗口（点一下加入名单）';
    this.el.appendChild(subHead);
    const openBox = document.createElement('div');
    openBox.style.cssText = 'max-height:150px;overflow:auto;border:1px solid rgba(255,255,255,0.12);'
      + 'border-radius:6px;padding:4px;margin-bottom:10px;background:rgba(0,0,0,0.18);';
    if (this.openWins.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '（没枚举到窗口；未最大化且有标题的窗口才会出现在这里）';
      empty.style.cssText = 'padding:8px;opacity:0.5;font-size:12px;';
      openBox.appendChild(empty);
    }
    for (const t of this.openWins) {
      const inList = this.cfg.whitelist.some((w) => t.includes(w));
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;cursor:pointer;';
      row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.08)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const mark = document.createElement('span');
      mark.textContent = inList ? '✔' : '＋';
      mark.style.cssText = 'width:12px;text-align:center;opacity:' + (inList ? '0.9' : '0.5') + ';';
      const txt = document.createElement('span');
      txt.textContent = t;
      txt.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      txt.title = t;
      row.appendChild(mark);
      row.appendChild(txt);
      // 已在名单里 → 点一下移除（移除的是「能匹配到它的那条」）；不在 → 把完整标题加进名单
      row.onclick = () => {
        if (inList) {
          const hit = this.cfg.whitelist.find((w) => t.includes(w));
          if (hit) this.removeEntry(hit);
        } else {
          this.addEntry(t);
        }
      };
      openBox.appendChild(row);
    }
    this.el.appendChild(openBox);

    // —— 投掷窗口开关（原版菜单项 Throwing / ThrowingWindows）——
    const toggle = document.createElement('label');
    toggle.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = this.cfg.throwEnabled;
    chk.onchange = () => { this.cfg.throwEnabled = chk.checked; this.persist(); this.render(); };
    const chkTxt = document.createElement('span');
    chkTxt.textContent = '投掷窗口（自动随机搬走窗口，默认关）';
    chkTxt.style.fontSize = '12px';
    toggle.appendChild(chk);
    toggle.appendChild(chkTxt);
    this.el.appendChild(toggle);

    // —— 状态行 ——
    if (this.status) {
      const st = document.createElement('div');
      st.textContent = this.status;
      st.style.cssText = 'font-size:11px;margin-bottom:8px;opacity:0.85;color:' + (this.statusOk ? '#8ee28e' : '#ffb0b0') + ';';
      this.el.appendChild(st);
    }

    // —— 底部按钮 ——
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const refresh = document.createElement('button');
    refresh.textContent = '刷新窗口列表';
    refresh.style.cssText = 'background:rgba(255,255,255,0.12);border:none;border-radius:6px;color:#fff;'
      + 'font:12px sans-serif;padding:6px 10px;cursor:pointer;';
    refresh.onclick = () => { void this.refreshOpenWindows(); };
    const done = document.createElement('button');
    done.textContent = this.onHidden ? '← 返回设置' : '完成';
    done.style.cssText = 'background:#3a6df0;border:none;border-radius:6px;color:#fff;font:13px sans-serif;padding:6px 14px;cursor:pointer;';
    done.onclick = () => this.hide();
    foot.appendChild(refresh);
    foot.appendChild(done);
    this.el.appendChild(foot);
  }
}
