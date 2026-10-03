// 渲染进程通过 electron 的 node 集成访问 IPC（renderer 不能静态 import 'electron'，
// 否则 webpack target:web 会尝试打包 electron 包、其内部依赖 fs 导致构建失败；统一用运行时 window.require）
const req: any = (window as any).require;
const { ipcRenderer } = req('electron');
import type { UpdateConfig } from './config';
import type { RemoteVersion, UpdateCheckResult } from '../shared/updateTypes';
export type { RemoteVersion, UpdateCheckResult };

// 更新配置（由 app.ts 启动时从 config.json 载入并写入）
let updaterConfig: UpdateConfig = { autoCheck: true, channel: 'stable' };
// 启动静默检查发现的新版本（ManagerPanel 打开时直接展示，免去用户手动点检查）
let pendingUpdate: UpdateCheckResult | null = null;

export function setUpdaterConfig(cfg: UpdateConfig) {
  updaterConfig = cfg || { autoCheck: true, channel: 'stable' };
}
export function getUpdaterConfig(): UpdateConfig {
  return updaterConfig;
}
export function setPendingUpdate(r: UpdateCheckResult | null) {
  pendingUpdate = r;
}
export function getPendingUpdate(): UpdateCheckResult | null {
  return pendingUpdate;
}

/** 向主进程请求检查更新（主进程用 Node fetch 拉 version.json 并做语义化比较）。 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const checkUrl = updaterConfig.checkUrl;
  if (!checkUrl) {
    const current: string = await ipcRenderer.invoke('get-app-version').catch(() => '?');
    return { ok: false, error: '未配置更新地址', current, hasUpdate: false };
  }
  try {
    return (await ipcRenderer.invoke('check-update', checkUrl)) as UpdateCheckResult;
  } catch (err) {
    const current: string = await ipcRenderer.invoke('get-app-version').catch(() => '?');
    return { ok: false, error: String(err), current, hasUpdate: false };
  }
}

/** 用系统浏览器打开外部链接（下载页 / 下载地址）。 */
export function openExternal(url: string): void {
  if (!url) return;
  ipcRenderer.invoke('open-external', url).catch(() => { /* ignore */ });
}
