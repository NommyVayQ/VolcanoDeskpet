// 更新检查相关的跨进程共享类型：主进程 `check-update` handler 与渲染层 `updater.ts` 共用同一份契约。
// 放在中立目录，避免「主进程依赖渲染层类型」或「字段在两侧各自漂移」导致 IPC 结构不一致。

/** 远端版本清单（version.json）结构 */
export interface RemoteVersion {
  version: string;
  pubDate?: string;
  notes?: string;
  downloadUrl?: string;
  channel?: string;
}

/** 检查更新结果（由主进程 check-update handler 返回） */
export interface UpdateCheckResult {
  ok: boolean;
  error?: string;
  current: string;
  latest?: string;
  hasUpdate: boolean;
  info?: RemoteVersion;
}
