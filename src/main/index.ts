import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { logBoot, attachBootLog } from './bootlog';
import { listWindows, getWindowRect, moveWindow, throwWindow, restoreWindows, cancelThrows, initWinApi, isWinApiAvailable, getTaskbarRect } from './winapi';
import type { RemoteVersion, UpdateCheckResult } from '../shared/updateTypes';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let exiting = false; // 退出流程进行中：避免重复触发 exit 动画 / 多次 destroy

/** 请求退出：先让渲染层播完退场动画，再真正销毁窗口（兜底超时强制关）。 */
function requestExit() {
  if (exiting) return;
  exiting = true;
  // ① 退出意图一确立就归还所有被本程序移动/抛出的窗口。
  //    放在最前、不依赖 before-quit / app.quit 是否被后续退出链触发，避免任何路径下漏还
  //    （退场动画卡死、window-all-closed 未触发等都曾导致 before-quit 没跑到）。
  //    before-quit 仍作为兜底；账本首次 restore 后清空，二次调用为幂等空操作。
  try {
    cancelThrows(); // 先停掉后台还在跑的抛出动画，否则它会把刚移回的窗口又甩出去
    const n = restoreWindows();
    logBoot('requestExit: 触发自动归还，恢复 ' + n + ' 个窗口');
  } catch (e) {
    logBoot('requestExit: 自动归还失败 ' + (e && (e as Error).message || String(e)));
  }
  // ② 播退场动画（渲染层回 exit-ready 后真正销毁）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('request-exit');
    // 兜底：渲染层若未回 exit-ready（动画异常/卡死），3s 后强制销毁全部窗口，保证关得掉
    setTimeout(() => {
      BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.destroy(); });
    }, 3000);
  } else {
    // 主窗口已没了：直接销毁全部残留窗口并退出
    BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.destroy(); });
    app.quit();
  }
}

/** 优先用 exe 旁边的 Data/ 目录作为日志落盘处；不可写时回退 userData。 */
function getLogDir(): string {
  try {
    const exeDir = path.dirname(process.execPath); // 打包后是 DeskPet.exe 所在目录（解压目录）
    const dataDir = path.join(exeDir, 'Data');
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.deskpet-write-test');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return dataDir;
  } catch {
    // 沙箱/开发模式：exe 在 node_modules/electron/dist 下，往往不可写
    return app.getPath('userData');
  }
}

/** 资源目录：打包后在 resources/assets，开发时在项目根 assets */
function getAssetDir(): string {
  const packed = path.join(process.resourcesPath, 'assets');
  if (fs.existsSync(packed)) return packed;
  return path.join(app.getAppPath(), 'assets');
}

/** 用户可调参数目录：打包后在 DeskPet.exe 同级的 config/，开发时在项目根 config/ */
function getConfigDir(): string {
  const packed = path.join(path.dirname(process.execPath), 'config');
  if (fs.existsSync(packed)) return packed;
  return path.join(app.getAppPath(), 'config');
}

function createWindow() {
  // 窗口铺满整个显示器 bounds（而非 workAreaSize）：任务栏显示/隐藏切换时不裁剪角色，
  // 角色的「地面」由渲染层按主进程下发的 workArea 底边动态计算（见 Pet.setFloor）。
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false, // 简化 MVP 开发，允许渲染进程直接读文件/IPC
    },
  });
  // 置顶级别升级：screen-saver 级 + level 1，压过任务管理器等其他置顶窗口
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  logBoot('BrowserWindow created (full display bounds ' + width + 'x' + height + ')');

  mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));

  // 默认开启穿透，除非鼠标悬停在角色身上
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.webContents.on('did-finish-load', () => logBoot('renderer did-finish-load'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 拦截关闭：先播退场动画（渲染层回 exit-ready 后才真正销毁），不直接杀进程
  mainWindow.on('close', (e: Electron.Event) => {
    if (!exiting) {
      e.preventDefault();
      requestExit();
    }
  });
}

/** 生成一个占位托盘图标（纯色方块），避免依赖外部图片资源。 */
function makeTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 80;     // R
    buf[i * 4 + 1] = 140; // G
    buf[i * 4 + 2] = 255; // B
    buf[i * 4 + 3] = 255; // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/** 创建系统托盘：右键菜单含「角色管理面板」「设置」「窗口归还」「关于」「退出」。 */
function createTray() {
  try {
    tray = new Tray(makeTrayIcon());
    const ctx = Menu.buildFromTemplate([
      {
        label: '角色管理面板',
        click: () => mainWindow?.webContents.send('open-manager-panel'),
      },
      {
        // 与右键菜单同名同序：设置（含窗口互动配置）/ 关于
        label: '设置',
        click: () => mainWindow?.webContents.send('open-settings-panel'),
      },
      {
        // 一次性动作，与「设置」并列，不藏在配置里（2026-09-26 拍板）
        label: '窗口归还',
        click: () => mainWindow?.webContents.send('win-restore-request'),
      },
      {
        label: '关于',
        click: () => mainWindow?.webContents.send('open-about-panel'),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => requestExit(),
      },
    ]);
    tray.setToolTip('DeskPet');
    tray.setContextMenu(ctx);
  } catch (e) {
    logBoot('createTray failed: ' + (e && (e as Error).message || String(e)));
  }
}

// 渲染进程转发的日志
ipcMain.on('renderer-log', (_event, level: string, msg: string) => {
  logBoot('[renderer:' + level + '] ' + msg);
});

// 渲染进程请求资源目录
ipcMain.handle('get-asset-dir', () => getAssetDir());

// 渲染层退场动画播放完毕 → 真正销毁全部窗口（含面板），彻底退出
ipcMain.on('exit-ready', () => {
  BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.destroy(); });
});

// 渲染进程请求用户可调参数目录
ipcMain.handle('get-config-dir', () => getConfigDir());

// 渲染进程请求当前版本号
ipcMain.handle('get-app-version', () => app.getVersion());

// 「自定义可互动窗口」面板需要键盘输入标题 → 把焦点交给宠物窗口（否则输入框收不到键盘）。
// 面板关闭后不需要归还焦点：用户切回自己的程序时系统会正常夺焦。
ipcMain.on('focus-pet-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
});

// 渲染进程请求当前工作区（任务栏隐藏/显示、auto-hide 弹出都会改变有效工作区，角色「地面」跟随其底边）
ipcMain.handle('get-work-area', () => computeWorkArea());

// ---- 更新检查（方案 A：仅提示 + 下载页）----
// 在**主进程**用 Node 的 fetch 拉取 version.json，避免渲染层跨域/CORS 问题；
// 与 app.getVersion()（= package.json version）做语义化版本比较，返回结构化结果给渲染层。
function compareSemver(a: string, b: string): number {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

ipcMain.handle('check-update', async (_event, checkUrl: string) => {
  const current = app.getVersion();
  if (!checkUrl || !/^https?:\/\//.test(checkUrl)) {
    return { ok: false, error: '未配置有效的更新地址', current, hasUpdate: false } as UpdateCheckResult;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(checkUrl, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: 'HTTP ' + res.status, current, hasUpdate: false } as UpdateCheckResult;
    }
    const data = (await res.json()) as RemoteVersion;
    if (!data || typeof data.version !== 'string') {
      return { ok: false, error: '版本清单格式错误', current, hasUpdate: false } as UpdateCheckResult;
    }
    const hasUpdate = compareSemver(data.version, current) > 0;
    return {
      ok: true,
      current,
      latest: data.version,
      hasUpdate,
      info: hasUpdate ? data : undefined,
    } as UpdateCheckResult;
  } catch (err) {
    return { ok: false, error: String(err && (err as any).message ? (err as any).message : err), current, hasUpdate: false } as UpdateCheckResult;
  }
});

// 用系统默认浏览器打开外部链接（下载页 / 下载地址）
ipcMain.handle('open-external', async (_event, url: string) => {
  if (!url || !/^https?:\/\//.test(url)) return false;
  try { await shell.openExternal(url); return true; } catch { return false; }
});

// 在资源管理器里定位一个目录（「关于」面板：打开 config / 日志目录）
ipcMain.handle('open-path', async (_event, kind: 'config' | 'log' | 'assets') => {
  let target = '';
  try {
    if (kind === 'config') target = getConfigDir();
    else if (kind === 'log') target = getLogDir();
    else if (kind === 'assets') target = getAssetDir();
    if (!target || !fs.existsSync(target)) return { ok: false, error: '目录不存在：' + target };
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e && (e as Error).message) || String(e) };
  }
});

// 「关于」面板需要的运行环境信息（版本 / Electron / 系统 / 各目录）
ipcMain.handle('get-about-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
  configDir: getConfigDir(),
  logDir: getLogDir(),
  assetDir: getAssetDir(),
}));

// 「在资源管理器中显示日志文件」：日志目录里定位 boot.log
ipcMain.handle('show-log-file', () => {
  try {
    const p = path.join(getLogDir(), 'boot.log');
    if (!fs.existsSync(p)) return { ok: false, error: '还没生成日志文件' };
    shell.showItemInFolder(p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: (e && (e as Error).message) || String(e) };
  }
});

// ---- workArea 变化推送 ----
// display-metrics-changed 只覆盖分辨率/旋转/缩放变化；任务栏自动隐藏的开关
// 不会触发该事件，因此用 1s 轮询对比 workArea，变化即推送给渲染层并同步窗口尺寸。
// 额外处理：auto-hide 任务栏弹出时 Electron 的 workArea 不变（始终全屏），需主动探测任务栏可见性并据此上移。
let lastWorkArea: Electron.Rectangle | null = null;

/** 计算「有效工作区」：固定任务栏模式直接用 Electron workArea；auto-hide 模式下，若任务栏当前弹出则扣除其占用。 */
function computeWorkArea(): Electron.Rectangle {
  const display = screen.getPrimaryDisplay();
  const baseWA = display.workArea;
  const b = display.bounds;
  // 固定任务栏：Electron 已正确扣除（workArea < bounds）→ 直接信任，不二次探测
  const isAutoHideHidden = baseWA.width >= b.width - 1 && baseWA.height >= b.height - 1;
  if (!isAutoHideHidden) return baseWA;
  // auto-hide 模式（隐藏态 Electron 返回全屏）：探测任务栏是否弹出
  const tb = getTaskbarRect();
  if (!tb || !tb.visible) return baseWA; // 任务栏隐藏 → 角色贴屏幕底
  const r = tb.rect;
  if (r.y >= b.height - 2) return baseWA; // 兜底：仍在屏幕外
  let effY = baseWA.y;
  let effH = baseWA.height;
  let effW = baseWA.width;
  let effX = baseWA.x;
  if (r.y > b.height / 2) {
    // 底部任务栏：占据 [r.y, b.height]
    effH = r.y - effY;
  } else if (r.y <= 2 && r.h < b.height / 2) {
    // 顶部任务栏
    effY = r.y + r.h;
    effH = b.height - effY;
  } else if (r.x <= 2 && r.w < b.width / 2) {
    // 左侧任务栏
    effX = r.x + r.w;
    effW = b.width - effX;
  } else if (r.x >= b.width - 2) {
    // 右侧任务栏
    effW = r.x - effX;
  }
  return { x: effX, y: effY, width: effW, height: effH };
}

function pushWorkArea(force = false) {
  const wa = computeWorkArea();
  const changed = force || !lastWorkArea
    || wa.x !== lastWorkArea.x || wa.y !== lastWorkArea.y
    || wa.width !== lastWorkArea.width || wa.height !== lastWorkArea.height;
  if (!changed) return;
  lastWorkArea = wa;
  // 显示器 bounds 变化时窗口仍需铺满整个显示器
  const b = screen.getPrimaryDisplay().bounds;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }); } catch { /* ignore */ }
  }
  mainWindow?.webContents.send('work-area-changed', wa);
  logBoot('workArea changed -> ' + JSON.stringify(wa));
}

// ---- 窗口交互（koffi/Win32）：枚举 / 查询 / 移动 / 抛出。koffi 缺失时返回空，渲染层降级隐藏菜单 ----
// whitelist 由渲染层传入（来自 config/config.json 的 window.whitelist）：
// 主进程不读配置，只做「按标题包含匹配」的过滤，保持单一配置来源。
ipcMain.handle('win-list', (_e, whitelist?: unknown) => {
  const own = mainWindow ? Number(mainWindow.getNativeWindowHandle().readBigInt64LE()) : 0;
  const wl = Array.isArray(whitelist)
    ? whitelist.filter((s): s is string => typeof s === 'string')
    : undefined;
  return initWinApi() ? listWindows(Number(own), wl) : [];
});
ipcMain.handle('win-available', () => { initWinApi(); return isWinApiAvailable(); });
ipcMain.handle('win-rect', (_e, hwnd: number) => getWindowRect(hwnd));
ipcMain.handle('win-move', (_e, hwnd: number, x: number, y: number) => moveWindow(hwnd, x, y));
ipcMain.handle('win-throw', (_e, hwnd: number, vx: number, vy: number) => {
  const wa = screen.getPrimaryDisplay().workArea;
  throwWindow(hwnd, vx, vy, wa.x + wa.width);
  return true;
});
// 「窗口归还」：把所有被搬走/甩出去的窗口移回原位（原桌宠 Shimeji 的 RestoreWindows）。
// 无需传参：账本在主进程（winapi 的 movedOrigins），只包含本程序真的动过的窗口。
ipcMain.handle('win-restore', () => restoreWindows());

// 监听渲染进程发送的穿透切换请求，并做状态缓存 + 最小间隔节流，
// 防止渲染层 reconcile 震荡时反复调用 setIgnoreMouseEvents 把主线程/渲染 IPC 通道卡死。
let lastIgnoreState: boolean | null = null;
let lastIgnoreTs = 0;
const IGNORE_THROTTLE_MS = 50;
ipcMain.on('set-ignore-mouse-events', (event, ignore: boolean, options?: { forward: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const now = Date.now();
  if (ignore === lastIgnoreState && now - lastIgnoreTs < IGNORE_THROTTLE_MS) {
    // 状态没变且在节流窗口内：直接吞掉，不调用原生 API
    return;
  }
  lastIgnoreState = ignore;
  lastIgnoreTs = now;
  win.setIgnoreMouseEvents(ignore, options);
});

// 崩溃兜底：任何未捕获异常都落盘，便于排查
app.on('render-process-gone', (_event, _wc, details) => logBoot('render-process-gone: ' + JSON.stringify(details)));
process.on('uncaughtException', (err) => logBoot('uncaughtException: ' + (err && (err as Error).stack || String(err))));
process.on('unhandledRejection', (reason) => logBoot('unhandledRejection: ' + (reason && (reason as any).stack || String(reason))));

app.whenReady().then(() => {
  const logDir = getLogDir();
  const bootLogPath = path.join(logDir, 'boot.log');
  try { fs.writeFileSync(bootLogPath, ''); } catch { /* ignore */ }
  attachBootLog(bootLogPath);
  logBoot('app ready, version=' + app.getVersion() + ', log dir=' + logDir);

  createWindow();
  createTray();

  // workArea 轮询 + 显示器指标变化即时推送（任务栏适配）
  screen.on('display-metrics-changed', () => pushWorkArea(true));
  setInterval(pushWorkArea, 1000);
  pushWorkArea(true);

  // 定时重申置顶级别：部分全屏应用/置顶窗口会临时夺取 Z 序，重申保证桌宠始终在最前
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前自动归还所有被本程序移动/抛出的窗口：账本在主进程（winapi.movedOrigins），
// 只含本程序真的动过的窗口；未动过则空账本、restoreWindows 直接返回 0，无副作用。
// 覆盖所有正常退出路径（托盘退出 / 关闭 pet 窗口导致的 app.quit / requestExit 的 app.quit）。
// ⚠️ 强杀进程（任务管理器）不会触发，无法归还——那是用户硬杀，无解。
app.on('before-quit', () => {
  cancelThrows();
  restoreWindows();
});
