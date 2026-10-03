/**
 * 关于面板 —— 右键菜单「关于」或设置面板「关于 DeskPet」打开。
 *
 * 只读信息面板：版本 / 运行环境 / 数据目录 / 许可声明 + 更新检查入口。
 * 「检查更新」复用 updater.ts（与角色管理面板同一套逻辑，结果就地展示）。
 */
import { checkForUpdates, getPendingUpdate, setPendingUpdate, openExternal, UpdateCheckResult } from './updater';

// 渲染进程不能静态 import 'electron'（webpack target:web 会把 electron 包及其 fs/path 依赖打进来）
const req: any = (window as any).require;
const { ipcRenderer } = req('electron');

interface AboutInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  portable: boolean;
  configDir: string;
  logDir: string;
  assetDir: string;
}

export class AboutPanel {
  /** 是否打开中：供 app.ts 的 reconcile() 判定阻塞态。 */
  public static isOpen = false;

  private el: HTMLDivElement;
  private info: AboutInfo | null = null;
  private note = '';
  private noteOk = true;
  private updArea: HTMLDivElement | null = null;
  private checking = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'z-index:9998', 'display:none', 'width:360px', 'max-height:84vh', 'overflow:auto',
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
    this.note = '';
    this.render();
    this.el.style.display = 'block';
    AboutPanel.isOpen = true;
    try {
      this.info = (await ipcRenderer.invoke('get-about-info')) as AboutInfo;
    } catch {
      this.info = null;
    }
    if (AboutPanel.isOpen) this.render();
  }

  hide() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
    AboutPanel.isOpen = false;
    window.dispatchEvent(new CustomEvent('context-menu-closed'));
  }

  private render() {
    this.el.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = '关于 DeskPet';
    title.style.cssText = 'font-weight:bold;font-size:15px;margin-bottom:8px;';
    this.el.appendChild(title);

    const tag = document.createElement('div');
    tag.textContent = '可互动的桌面宠物　·　版本 v' + (this.info ? this.info.version : '…');
    tag.style.cssText = 'font-size:12px;opacity:0.7;margin-bottom:12px;';
    this.el.appendChild(tag);

    // —— 版本更新 ——
    const updTitle = this.sectionTitle('版本更新');
    this.el.appendChild(updTitle);
    this.updArea = document.createElement('div');
    this.updArea.style.cssText = 'font-size:12px;line-height:1.5;margin-bottom:8px;color:#cbd5e1;white-space:pre-wrap;';
    this.el.appendChild(this.updArea);

    const checkBtn = this.button('检查更新', 'primary');
    checkBtn.disabled = this.checking;
    checkBtn.onclick = async () => {
      this.checking = true;
      checkBtn.disabled = true;
      checkBtn.textContent = '检查中…';
      this.setUpdateText('正在检查更新…', '');
      const r = await checkForUpdates();
      if (r.hasUpdate && r.info) setPendingUpdate(r);
      this.renderUpdateArea(r);
      this.checking = false;
      checkBtn.disabled = false;
      checkBtn.textContent = '检查更新';
    };
    this.el.appendChild(checkBtn);

    const pend = getPendingUpdate();
    if (pend && pend.hasUpdate) this.renderUpdateArea(pend);
    else this.setUpdateText('当前版本 v' + (this.info ? this.info.version : '?'), '');

    // —— 运行环境 ——
    this.el.appendChild(this.sectionTitle('运行环境'));
    const kv = document.createElement('div');
    kv.style.cssText = 'font-size:12px;line-height:1.8;';
    if (this.info) {
      this.addKV(kv, 'Electron', this.info.electron);
      this.info.chrome && this.addKV(kv, 'Chromium', this.info.chrome);
      this.addKV(kv, 'Node', this.info.node);
      this.addKV(kv, '系统', this.info.platform + ' / ' + this.info.arch + (this.info.portable ? '　（便携版）' : ''));
    } else {
      this.addKV(kv, '状态', '读取中…');
    }
    this.el.appendChild(kv);

    // —— 数据目录（可点击打开）——
    this.el.appendChild(this.sectionTitle('数据目录'));
    this.el.appendChild(this.dirRow('配置目录', 'config', this.info ? this.info.configDir : ''));
    this.el.appendChild(this.dirRow('日志目录', 'log', this.info ? this.info.logDir : ''));
    this.el.appendChild(this.dirRow('美术资源', 'assets', this.info ? this.info.assetDir : ''));

    // —— 许可声明 ——
    const lic = document.createElement('div');
    lic.textContent = '角色美术素材版权归原作者所有；本程序仅做本地展示与互动，不含任何联网上传行为。';
    lic.style.cssText = 'font-size:11px;opacity:0.5;line-height:1.5;margin-top:6px;';
    this.el.appendChild(lic);

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

  private setUpdateText(text: string, color: string) {
    if (!this.updArea) return;
    this.updArea.textContent = text;
    if (color) this.updArea.style.color = color;
  }

  private renderUpdateArea(r: UpdateCheckResult) {
    if (!this.updArea) return;
    this.updArea.innerHTML = '';
    if (!r.ok) {
      const tip = document.createElement('div');
      tip.style.cssText = 'color:#fca5a5;';
      tip.textContent = '检查失败：' + (r.error || '未知错误');
      this.updArea.appendChild(tip);
      return;
    }
    if (r.hasUpdate && r.info) {
      const info = r.info;
      const head = document.createElement('div');
      head.style.cssText = 'color:#fbbf24;font-weight:bold;';
      head.textContent = '发现新版本 v' + info.version + (info.pubDate ? '（' + info.pubDate + '）' : '');
      this.updArea.appendChild(head);
      if (info.notes) {
        const notes = document.createElement('div');
        notes.style.cssText = 'margin:4px 0;max-height:110px;overflow:auto;opacity:0.85;';
        notes.textContent = info.notes;
        this.updArea.appendChild(notes);
      }
      const go = document.createElement('button');
      go.textContent = '前往下载';
      go.title = info.downloadUrl || '';
      go.style.cssText = 'cursor:pointer;background:#4a7dff;color:#fff;border:none;border-radius:5px;padding:4px 12px;margin-top:4px;font-weight:bold;';
      go.onclick = () => openExternal(info.downloadUrl || '');
      this.updArea.appendChild(go);
    } else {
      const ok = document.createElement('div');
      ok.style.cssText = 'color:#86efac;';
      ok.textContent = '已是最新（v' + r.current + '）';
      this.updArea.appendChild(ok);
    }
  }

  private sectionTitle(text: string): HTMLDivElement {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'font-size:11px;letter-spacing:0.08em;opacity:0.5;text-transform:uppercase;'
      + 'margin:12px 0 4px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);';
    return t;
  }

  private addKV(parent: HTMLElement, k: string, v: string) {
    const row = document.createElement('div');
    const key = document.createElement('span');
    key.textContent = k + '　';
    key.style.cssText = 'display:inline-block;min-width:78px;opacity:0.55;';
    const val = document.createElement('span');
    val.textContent = v;
    row.appendChild(key);
    row.appendChild(val);
    parent.appendChild(row);
  }

  /** 一行目录：点击在资源管理器里打开。 */
  private dirRow(label: string, kind: 'config' | 'log' | 'assets', p: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'padding:5px 8px;border-radius:6px;cursor:pointer;';
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.08)'; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    const l = document.createElement('div');
    l.textContent = '打开' + label;
    const d = document.createElement('div');
    d.textContent = p || '…';
    d.title = p;
    d.style.cssText = 'font-size:11px;opacity:0.45;line-height:1.4;word-break:break-all;';
    row.appendChild(l);
    row.appendChild(d);
    row.onclick = async () => {
      try {
        const r = await ipcRenderer.invoke('open-path', kind);
        this.note = r && r.ok ? '已在资源管理器中打开：' + r.path : '打开失败：' + ((r && r.error) || '未知错误');
        this.noteOk = !!(r && r.ok);
      } catch (e) {
        this.note = '打开失败：' + String(e);
        this.noteOk = false;
      }
      this.render();
    };
    return row;
  }

  private button(text: string, kind: 'primary' | 'ghost' = 'ghost'): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = kind === 'primary'
      ? 'cursor:pointer;background:#22c55e;color:#06280f;border:none;border-radius:5px;padding:4px 12px;font-weight:bold;'
      : 'cursor:pointer;background:rgba(255,255,255,0.12);border:none;border-radius:5px;color:#fff;padding:4px 12px;';
    return b;
  }
}
