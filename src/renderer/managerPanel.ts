import { spawnPet, removePet, listPets, listConfigCharacters } from './app';
import type { SupervisorPanel } from './supervisor/SupervisorPanel';
import { checkForUpdates, openExternal, getUpdaterConfig, getPendingUpdate, setPendingUpdate, UpdateCheckResult } from './updater';

/**
 * 角色管理面板：列出配置里全部可用角色，在场的可删除、不在场的可召唤。
 * 不重复约束由 spawnPet 内部保证（已存在则忽略）。
 * 由系统托盘「管理面板」菜单项通过 IPC 'open-manager-panel' 打开。
 * 穿透控制已统一到 app.ts 的 reconcile()（面板打开 = 阻塞态，强制窗口捕获点击）。
 */
export class ManagerPanel {
  private el: HTMLDivElement;
  /** 面板是否打开中：供 app.ts reconcile() 判定阻塞态，防止面板显示时被切回穿透态。 */
  public static isOpen = false;
  /** 监管浮窗（可选）：提供后会在面板顶部加一个「🔧 调试」按钮用于唤出 Supervisor */
  private supervisor: SupervisorPanel | null = null;

  constructor(supervisor?: SupervisorPanel) {
    if (supervisor) this.supervisor = supervisor;
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'z-index:9998', 'display:none', 'width:280px',
      'background:rgba(30,30,35,0.97)', 'color:#fff', 'font:13px/1.5 sans-serif',
      'border-radius:10px', 'padding:16px', 'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'user-select:none',
    ].join(';');
    document.body.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
    // 注意：面板打开的 IPC 监听在 app.ts 中统一处理（打开后调用 reconcile 强制切捕获态）。
  }

  show() {
    this.render();
    this.el.style.display = 'block';
    ManagerPanel.isOpen = true;
  }

  hide() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
    ManagerPanel.isOpen = false;
  }

  private render() {
    const present = listPets();
    const all = listConfigCharacters();
    this.el.innerHTML = '';

    // 标题行：左侧标题 + 右侧监管按钮（仅当 supervisor 已注入时显示）
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    const title = document.createElement('div');
    title.textContent = '角色管理面板';
    title.style.cssText = 'font-weight:bold;font-size:15px;';
    titleRow.appendChild(title);
    if (this.supervisor) {
      const devBtn = document.createElement('button');
      devBtn.textContent = '🔧 调试';
      devBtn.title = '打开监管面板（Ctrl+Shift+D）';
      devBtn.style.cssText = 'cursor:pointer;background:rgba(125,211,252,0.12);color:#7dd3fc;border:1px solid rgba(125,211,252,0.3);border-radius:4px;padding:2px 8px;font-size:11px;font-family:ui-monospace,Consolas,monospace;';
      devBtn.onclick = () => { this.supervisor!.show(); };
      titleRow.appendChild(devBtn);
    }
    this.el.appendChild(titleRow);

    for (const id of all) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 4px;';
      const label = document.createElement('span');
      label.textContent = id + (present.includes(id) ? '（在场）' : '');
      row.appendChild(label);

      const btn = document.createElement('button');
      if (present.includes(id)) {
        btn.textContent = '删除';
        // removePet 先播退场动画再真正移除；这里延迟重渲染，等动画收尾后按钮状态才切换
        btn.onclick = () => {
          removePet(id);
          this.render();
          window.setTimeout(() => this.render(), 1300);
        };
      } else {
        btn.textContent = '召唤';
        btn.onclick = () => { spawnPet(id); this.render(); };
      }
      btn.style.cssText = 'cursor:pointer;background:#4a7dff;color:#fff;border:none;border-radius:5px;padding:4px 12px;';
      row.appendChild(btn);
      this.el.appendChild(row);
    }

    // —— 版本更新（方案 A：仅提示 + 下载页）——
    const updCfg = getUpdaterConfig();
    if (updCfg && updCfg.checkUrl) {
      const updRow = document.createElement('div');
      updRow.style.cssText = 'margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12);';
      const updTitle = document.createElement('div');
      updTitle.textContent = '版本更新';
      updTitle.style.cssText = 'font-weight:bold;font-size:13px;margin-bottom:6px;';
      updRow.appendChild(updTitle);

      const updArea = document.createElement('div');
      updArea.style.cssText = 'font-size:12px;line-height:1.5;margin-bottom:8px;color:#cbd5e1;white-space:pre-wrap;';
      updRow.appendChild(updArea);

      const checkBtn = document.createElement('button');
      checkBtn.textContent = '检查更新';
      checkBtn.style.cssText = 'cursor:pointer;background:#22c55e;color:#06280f;border:none;border-radius:5px;padding:4px 12px;font-weight:bold;';
      checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = '检查中…';
        updArea.textContent = '正在检查更新…';
        const r = await checkForUpdates();
        if (r.hasUpdate && r.info) setPendingUpdate(r);
        renderUpdateArea(updArea, r);
        checkBtn.disabled = false;
        checkBtn.textContent = '检查更新';
      };
      updRow.appendChild(checkBtn);

      // 启动静默检查已发现新版本：直接展示，免去用户手动点
      const pend = getPendingUpdate();
      if (pend && pend.hasUpdate) renderUpdateArea(updArea, pend);

      this.el.appendChild(updRow);
    }

    const close = document.createElement('div');
    close.textContent = '关闭 (Esc)';
    close.style.cssText = 'margin-top:12px;text-align:center;cursor:pointer;color:#9ab4ff;';
    close.onclick = () => this.hide();
    this.el.appendChild(close);
  }
}

/** 把检查更新结果渲染到指定容器：已最新 / 发现新版本（含前往下载按钮）/ 失败。 */
function renderUpdateArea(el: HTMLDivElement, r: UpdateCheckResult) {
  el.innerHTML = '';
  if (!r.ok) {
    const tip = document.createElement('div');
    tip.style.cssText = 'color:#fca5a5;';
    tip.textContent = '检查失败：' + (r.error || '未知错误') + '（请确认 config.json 的 update.checkUrl 已配置为你的 version.json 地址）';
    el.appendChild(tip);
    return;
  }
  if (r.hasUpdate && r.info) {
    const info = r.info;
    const head = document.createElement('div');
    head.style.cssText = 'color:#fbbf24;font-weight:bold;';
    head.textContent = '发现新版本 v' + info.version + (info.pubDate ? '（' + info.pubDate + '）' : '');
    el.appendChild(head);
    if (info.notes) {
      const notes = document.createElement('div');
      notes.style.cssText = 'margin:4px 0;max-height:120px;overflow:auto;';
      notes.textContent = info.notes;
      el.appendChild(notes);
    }
    const go = document.createElement('button');
    go.textContent = '前往下载';
    go.title = info.downloadUrl || '';
    go.style.cssText = 'cursor:pointer;background:#4a7dff;color:#fff;border:none;border-radius:5px;padding:4px 12px;margin-top:4px;font-weight:bold;';
    go.onclick = () => openExternal(info.downloadUrl || '');
    el.appendChild(go);
  } else {
    const ok = document.createElement('div');
    ok.style.cssText = 'color:#86efac;';
    ok.textContent = '已是最新（v' + r.current + '）';
    el.appendChild(ok);
  }
}
