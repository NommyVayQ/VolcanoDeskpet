/**
 * Win32 窗口枚举/移动（koffi FFI，N-API 免编译，Electron 主进程可用）。
 * 供桌宠「搬运窗口 / 挂窗沿」交互使用。koffi 缺失（打包不完整）时全部降级返回空值，
 * 渲染层据 isAvailable() 隐藏窗口系菜单，其余功能不受影响。
 */
import { logBoot } from './bootlog';

/**
 * 坐标系统一（DPI 修正，2026-09-26）：
 * Win32 的 GetWindowRect/SetWindowPos 返回/接受**物理像素**（Electron 主进程是 per-monitor
 * DPI aware）；而渲染层 PixiJS（window.innerWidth）与 Electron 的 screen API 用的是
 * **逻辑像素（DIP / CSS px）**。两套单位混用正是「角色离窗口太远 / 窗口速度与角色不匹配 /
 * 窗口没被甩出屏幕」三问题的共同根因——本机 150% 缩放下 1 物理 px = 1.5 逻辑 px，所有窗口
 * 几何被放大 1.5×、移动量被缩小 1/1.5、甩出判定在屏幕正中就触发。
 *
 * 解决：所有跨 IPC 的窗口坐标一律走 DIP，只在调用 Win32 API 前（写）后（读）做
 * 物理↔DIP 换算（乘以/除以所在显示器的 scaleFactor = dpi/96）。渲染层本就用 DIP，无需改动。
 */
let electronScreen: any = null;
function getScreen(): any {
  if (electronScreen === null) {
    try { electronScreen = require('electron').screen; } catch { electronScreen = false; }
  }
  return electronScreen || null;
}
/** 取某点所在显示器的 物理/DIP 换算比（scaleFactor）。入参坐标可物理可逻辑——
 *  本函数只用它定位「哪个显示器」，scaleFactor 是该显示器固有属性，与坐标空间无关。 */
function scaleAt(x: number, y: number): number {
  const s = getScreen();
  if (!s) return 1;
  try { const d = s.getDisplayNearestPoint({ x, y }); return d && d.scaleFactor ? d.scaleFactor : 1; }
  catch { return 1; }
}

export interface WinInfo {
  hwnd: number;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Z 序索引：EnumWindows 按 Z 序顶→底枚举、先 push 的更靠前（z 越小越在顶层）。
   *  选窗用「最小 z」= 取最上层的交互窗口，避免层层叠叠时抓到被压住的不可见窗口。 */
  z: number;
  /** 是否被更高 Z 序的窗口完全遮住（采样点全被覆盖）。
   *  典型场景：白名单窗口被一个**最大化**的非白名单窗口（最大化窗口按原版规则不可互动）
   *  盖住 → 用户看不见它，抓它就是「空手抛掷」。选窗时应跳过；若全部被遮则放弃演出。 */
  occluded: boolean;
}

interface User32Api {
  EnumWindows: (cb: any, lparam: any) => boolean;
  IsWindowVisible: (hwnd: number) => boolean;
  IsIconic: (hwnd: number) => boolean;
  IsZoomed: (hwnd: number) => boolean;
  GetWindowRect: (hwnd: number, out: any[]) => boolean;
  GetWindowTextW: (hwnd: number, buf: Buffer, max: number) => number;
  SetWindowPos: (hwnd: number, after: number, x: number, y: number, w: number, h: number, flags: number) => boolean;
  IsWindow: (hwnd: number) => boolean;
  FindWindowA: (cls: string | null, title: string | null) => number;
  /** 取窗口所属进程 PID（遮挡判定时排除桌宠自己的透明窗——它铺满全屏但不渲染任何内容） */
  GetWindowThreadProcessId: (hwnd: number, outPid: Buffer) => number;
  /** 查某屏幕坐标点下最顶层的可命中窗口（遮挡判定的官方语义：不算矩形，直接问「这个点是谁」） */
  WindowFromPoint: (pt: { x: number; y: number }) => number;
  /** 取窗口祖先（GA_ROOT=2）：WindowFromPoint 命中的可能是子窗，向上找到根再和候选比对 */
  GetAncestor: (hwnd: number, flag: number) => number;
}

let user32: User32Api | null = null;
let dwmCloaked: ((hwnd: number) => boolean) | null = null; // DWM 幽灵窗检测（UWP 挂起/虚拟桌面外=不可见但 IsWindowVisible 仍真）
let enumProto: any = null;
let available = false;

/** 懒加载 user32 绑定；失败（koffi 缺失/非 Windows）返回 false。 */
export function initWinApi(): boolean {
  if (user32 !== null) return available;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const PT = koffi.struct('DESKPET_POINT', { x: 'long', y: 'long' });
    const lib = koffi.load('user32.dll');
    user32 = {
      EnumWindows: lib.func('EnumWindows', 'bool', ['intptr', 'intptr']),
      IsWindowVisible: lib.func('IsWindowVisible', 'bool', ['intptr']),
      IsIconic: lib.func('IsIconic', 'bool', ['intptr']),
      // 原版 WindowsEnvironment.isViableIE：IsZoomed（最大化）→ INVALID，直接不算可互动窗口
      IsZoomed: lib.func('IsZoomed', 'bool', ['intptr']),
      GetWindowRect: lib.func('GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]),
      GetWindowTextW: lib.func('GetWindowTextW', 'int', ['intptr', 'void*', 'int']),
      SetWindowPos: lib.func('SetWindowPos', 'bool', ['intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint']),
      IsWindow: lib.func('IsWindow', 'bool', ['intptr']),
      // koffi 的 'str' 是 char*（ANSI），必须配 A 版 API；W 版会把 UTF-8 当宽字符解析成乱码
      FindWindowA: lib.func('FindWindowA', 'intptr', ['str', 'str']),
      // out 参数用裸 Buffer（koffi 共享内存，调用后 readUInt32LE 直接读）
      GetWindowThreadProcessId: lib.func('GetWindowThreadProcessId', 'uint32', ['intptr', 'void*']),
      // POINT 按值传参
      WindowFromPoint: lib.func('WindowFromPoint', 'intptr', [PT]),
      GetAncestor: lib.func('GetAncestor', 'intptr', ['intptr', 'uint32']),
    } as unknown as User32Api;
    enumProto = koffi.pointer(koffi.proto('bool __stdcall EnumProc(intptr hwnd)'));
    // dwmapi：DwmGetWindowAttribute(DWMWA_CLOAKED=14) 检测「披隐」窗口 ——
    // UWP 应用挂起后（如 Windows 设置）、其他虚拟桌面上的窗口，IsWindowVisible 仍返回 true，
    // 但 DWM 已把它们从合成树摘掉（用户看不见）。不排除的话角色会去抓「不存在的窗口」。
    try {
      const dwm = koffi.load('dwmapi.dll');
      const getCloaked = dwm.func('DwmGetWindowAttribute', 'long', ['intptr', 'uint32', 'void*', 'uint32']);
      dwmCloaked = (hwnd: number) => {
        try {
          const out = Buffer.alloc(4);
          if (getCloaked(hwnd, 14, out, 4) !== 0) return false; // 查询失败按「未披隐」处理
          return out.readInt32LE(0) !== 0;
        } catch { return false; }
      };
    } catch { dwmCloaked = null; } // dwmapi 加载失败不影响其余功能
    available = true;
    logBoot('winapi: koffi user32 loaded');
  } catch (e) {
    available = false;
    user32 = null;
    logBoot('winapi unavailable (koffi load failed): ' + (e && (e as Error).message || String(e)));
  }
  return available;
}

export function isWinApiAvailable(): boolean {
  return user32 !== null && available;
}

/**
 * 标题是否命中白名单：**区分大小写、包含即算**。
 * 这是原版 Shimeji 的逐字语义 —— `WindowsEnvironment.isIE()`：
 *   标题非空 && 标题 != "Program Manager" && `title.contains(entry)`（entry 来自
 *   settings.properties 的 `InteractiveWindows`，以 "/" 分隔、逐个 trim、跳过空串）。
 * 注意：原版**没有** lowercase 归一，`Notepad` 匹配不到 `notepad`，因此名单里同时列了
 * 「Notepad」和「记事本」这类写法。这里保持一致，避免"名单看起来生效了其实没匹配上"。
 * whitelist 为空数组 / 未传 = 不过滤（保持旧行为，供内部调试用）。
 */
function titleInWhitelist(title: string, whitelist?: string[]): boolean {
  if (!whitelist || whitelist.length === 0) return true;
  for (const w of whitelist) {
    if (typeof w === 'string' && w.trim().length > 0 && title.includes(w.trim())) return true;
  }
  return false;
}

/** 枚举可见、未最小化、非最大化、有标题的顶层窗口。excludeHwnd 用于排除桌宠自己的透明窗。
 *  whitelist 非空时只返回标题命中的窗口（搬运/投掷窗口的目标范围，见 titleInWhitelist）。 */
export function listWindows(excludeHwnd?: number, whitelist?: string[]): WinInfo[] {
  if (!initWinApi()) return [];
  const u = user32!;
  const wins: WinInfo[] = [];
  let z = 0; // Z 序计数器：EnumWindows 按 Z 序顶→底枚举，先 push 的更靠前（z 越小越在顶层）
  // —— 遮挡判定（2026-09-29 方案②，v2：WindowFromPoint 实测）——
  // v1 用「更高 Z 序窗口矩形求交」，被 IsWindowVisible 但**不渲染画面**的系统窗误伤
  // （Windows Input Experience 等输入法窗矩形常盖住大半屏，导致看得见的窗口也被判全遮）。
  // v2 改为对采样点直接调 WindowFromPoint 问「这个点实际命中的是谁」——命中候选自身
  // （或其子窗）= 该点真看得见；命中别的窗口 = 被遮挡。官方语义，隐形窗不会捣乱。
  const isOwnPid = (h: number): boolean => {
    try {
      const pb = Buffer.alloc(4);
      u.GetWindowThreadProcessId(h, pb);
      return pb.readUInt32LE(0) === process.pid;
    } catch { return false; }
  };
  const pointVisible = (px: number, py: number, self: number): boolean => {
    try {
      const hit = Number(u.WindowFromPoint({ x: px, y: py }));
      if (!hit || isOwnPid(hit)) return true; // 没有窗口 / 桌宠自己的透明 overlay → 不算遮挡
      if (dwmCloaked && dwmCloaked(hit)) return true; // 命中了披隐窗 = 它不渲染，看到的其实是候选
      return Number(u.GetAncestor(hit, 2 /* GA_ROOT */)) === self; // 命中自身或其子窗 → 可见
    } catch { return true; } // 查询失败按可见处理（宁可演也别罢工）
  };
  const cb = (hwndPtr: any) => {
    const hwnd = Number(hwndPtr);
    if (excludeHwnd !== undefined && hwnd === excludeHwnd) return true;
    if (!u.IsWindowVisible(hwnd) || u.IsIconic(hwnd)) return true;
    // UWP 挂起/其他虚拟桌面的「披隐」窗口：用户看不见，不能当投掷目标（2026-09-27 修「抓不存在的窗口」）
    if (dwmCloaked && dwmCloaked(hwnd)) return true;
    const arr = [null];
    if (!u.GetWindowRect(hwnd, arr)) return true;
    const r = arr[0] as unknown as { left: number; top: number; right: number; bottom: number };
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (w <= 0 || h <= 0) return true;
    // 最小化甩到 -32000 的幽灵窗：不能当投掷目标
    if (r.left < -2000 || r.top < -2000) return true;
    // —— 以下才是「可互动窗口候选」筛选 ——
    // 原版 isViableIE 把最大化窗口判为 INVALID（不可互动）—— 最大化窗口铺满屏幕，搬起来没有意义
    if (u.IsZoomed(hwnd)) return true;
    // 过滤：太小的、桌面(Program Manager 不带工具窗口态过滤不掉，按尺寸+位置近似)
    if (w < 200 || h < 120) return true;
    const buf = Buffer.allocUnsafe(1024);
    const n = u.GetWindowTextW(hwnd, buf, 256);
    if (n <= 0) return true;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const title = String(koffi.decode(buf, 'char16_t', n));
    if (!title || title === 'Program Manager' || title === 'Windows Input Experience') return true;
    if (!titleInWhitelist(title, whitelist)) return true;
    // 物理 → DIP：除以所在显示器 scaleFactor（本机 150% → ÷1.5），与渲染层 innerWidth 同口径
    const s = scaleAt(r.left + w / 2, r.top + h / 2);
    const dipX = r.left / s, dipY = r.top / s, dipW = w / s, dipH = h / s;
    // 完全在所有显示器之外（半截在屏外的仍算可见，原版如此）→ 用户看不见，排除
    const scr = getScreen();
    if (scr) {
      try {
        const intersects = scr.getAllDisplays().some((d: any) =>
          dipX < d.bounds.x + d.bounds.width && dipX + dipW > d.bounds.x
          && dipY < d.bounds.y + d.bounds.height && dipY + dipH > d.bounds.y);
        if (!intersects) return true;
      } catch { /* 屏幕枚举失败按可见处理 */ }
    }
    // 遮挡采样：中心 + 四角内侧（25%/75%），任一点 WindowFromPoint 命中自身 = 至少能看见一部分
    const sx = [r.left + w * 0.5, r.left + w * 0.25, r.left + w * 0.75, r.left + w * 0.25, r.left + w * 0.75];
    const sy = [r.top + h * 0.5, r.top + h * 0.25, r.top + h * 0.25, r.top + h * 0.75, r.top + h * 0.75];
    const occluded = !sx.some((x, i) => pointVisible(x, sy[i], hwnd));
    wins.push({ hwnd, title, x: dipX, y: dipY, w: dipW, h: dipH, z: z++, occluded });
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi');
  const cbRef = koffi.register(cb, enumProto);
  try { u.EnumWindows(cbRef, 0); } finally { koffi.unregister(cbRef); }
  return wins;
}

/** 取单个窗口当前矩形；窗口已销毁返回 null。 */
export function getWindowRect(hwnd: number): { x: number; y: number; w: number; h: number } | null {
  if (!initWinApi()) return null;
  const u = user32!;
  if (!u.IsWindow(hwnd)) return null;
  const arr = [null];
  if (!u.GetWindowRect(hwnd, arr)) return null;
  const r = arr[0] as unknown as { left: number; top: number; right: number; bottom: number };
  // 物理 → DIP（÷scaleFactor），见文件顶部说明
  const w = r.right - r.left, h = r.bottom - r.top;
  const s = scaleAt(r.left + w / 2, r.top + h / 2);
  return { x: r.left / s, y: r.top / s, w: w / s, h: h / s };
}

/**
 * 取任务栏（Shell_TrayWnd）当前矩形 + 可见性。用于解决「auto-hide 任务栏弹出不触发 workArea 变化」的问题：
 * Electron 的 workArea 在 auto-hide 模式下始终返回全屏（不预留任务栏），因此任务栏弹出时角色不会自动上移。
 * 这里主动探测任务栏当前是否在屏幕可见区内（隐藏态会移出屏幕），供主进程据此上移角色地面。
 * koffi 缺失时返回 null，主进程退化为「直接信任 workArea」。
 */
export function getTaskbarRect(): { rect: { x: number; y: number; w: number; h: number }; visible: boolean } | null {
  if (!initWinApi()) return null;
  const u = user32!;
  let hwnd: number;
  try {
    hwnd = Number(u.FindWindowA('Shell_TrayWnd', null));
  } catch {
    return null;
  }
  if (!hwnd || !u.IsWindow(hwnd) || !u.IsWindowVisible(hwnd)) return null;
  const r = getWindowRect(hwnd);
  if (!r) return null;
  // auto-hide 隐藏态：任务栏整窗移出屏幕外（top/bottom 落在屏幕边界外），视为不可见
  const visible = r.y < 32767 && r.y > -32768 && r.h > 1 && r.w > 1;
  return { rect: r, visible };
}

const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;

/**
 * 「窗口归还」的账本：hwnd → **本程序动手前**的原始位置。
 *
 * 在第一次移动某窗口时记录，之后无论被搬/被扔到哪，都能一键移回原处
 * （对齐原桌宠 Shimeji 的 RestoreWindows：把被移动过的 IE 全部恢复原位）。
 * 位置无关「是否还在白名单里」——白名单只决定谁能被搬，归还只认「我们动过谁」。
 */
const movedOrigins = new Map<number, { x: number; y: number }>();

/** 记录窗口原始位置（仅首次；之后覆盖无效）。窗口不存在/已销毁则忽略。 */
function rememberWindowOrigin(hwnd: number) {
  if (movedOrigins.has(hwnd)) return;
  const r = getWindowRect(hwnd);
  if (!r) return;
  movedOrigins.set(hwnd, { x: r.x, y: r.y });
}

/**
 * 「窗口归还」：把所有被本程序移动过的窗口移回原位，并清空账本。
 * 窗口已被用户关掉的直接从账本丢弃。返回成功恢复的数量。
 */
export function restoreWindows(): number {
  if (!initWinApi()) return 0;
  const u = user32!;
  let restored = 0;
  for (const [hwnd, pos] of movedOrigins) {
    if (!u.IsWindow(hwnd)) continue;
    // pos 是 DIP（由 getWindowRect 记录）；乘 scaleFactor 还原物理后再写回
    const s = scaleAt(pos.x, pos.y);
    if (u.SetWindowPos(hwnd, 0, Math.round(pos.x * s), Math.round(pos.y * s), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)) restored++;
  }
  const total = movedOrigins.size;
  movedOrigins.clear();
  logBoot('winapi: restoreWindows 恢复 ' + restored + '/' + total + ' 个窗口');
  return restored;
}

/** 移动窗口（不改尺寸、不改 Z 序、不激活）。首次移动前先记下原位，供「窗口归还」用。
 *  x/y 为**逻辑像素(DIP)**（来自渲染层）；调用 SetWindowPos 前乘 scaleFactor 还原为物理像素。 */
export function moveWindow(hwnd: number, x: number, y: number): boolean {
  if (!initWinApi()) return false;
  rememberWindowOrigin(hwnd);
  const r = getWindowRect(hwnd); // DIP
  const s = r ? scaleAt(r.x + r.w / 2, r.y + r.h / 2) : 1; // 用窗口当前位置定位显示器，取换算比
  return user32!.SetWindowPos(hwnd, 0, Math.round(x * s), Math.round(y * s), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

// 原版 com.group_finity.mascot.Manager.TICK_INTERVAL = 40ms（javap -constants 实测）
const SHIMEJI_TICK_MS = 40;
// 原版 ThrowIe 的 Pose Duration="40" → 演出最多 40 个 tick；此处放宽到 150 作安全上限
// （仍由 fullyOff 真实结束：窗口完全移出屏幕即停）。DPI 修正后坐标走 DIP，40 tick×32 DIP
// 在 150% 缩放下 = 1920 物理 px，宽屏/大窗口才能确保真正甩出屏幕外（2026-09-26 修正）。
const THROW_TICKS = 150;
// 原版 ThrowIe 的 Gravity="0.5"（每 tick 的垂直增量里线性增长的那一项）
const THROW_GRAVITY = 0.5;

/**
 * 抛出窗口 —— 逐字复刻 Shimeji 的 `com.group_finity.mascot.action.ThrowIE`。
 *
 * 原版每个 tick(40ms) 执行（ThrowIE.tick 反编译所得，注意用的是**当前位置**做增量）：
 *   new Point(IE.left + InitialVX, IE.top + InitialVY + (int)(time * Gravity))
 * 即：水平恒定 vx=±32 px/tick（= 800px/s）；垂直每 tick 递增 `-10 + 0.5·t`，40 tick 累计只下坠 10px
 * （视觉上几乎是一条水平直线，不是抛物线）。
 *
 * 结束条件（原版 ThrowIE.hasNext）：`Animate.hasNext() && activeIE.isVisible()` ——
 * **窗口一旦完全移出屏幕，演出立即结束**（此后环境枚举不到它，isVisible=false）。
 *
 * ⚠️ 原版**不做任何边界夹取**：窗口会被真的甩出屏幕外（这正是原桌宠「甩窗口」的观感，
 * 也是它必须提供 `RestoreWindows=窗口归还` 的原因）。本实现保持一致；
 * `movedOrigins` 账本已在抛出前记下原位，右键菜单「窗口归还」可一键拉回。
 *
 * 单位（DPI 修正，2026-09-26）：vx / vy / screenW 均为**逻辑像素(DIP)**，与渲染层
 * window.innerWidth 同口径；窗口位置经 `getWindowRect`(DIP) 读出、`moveWindow`(DIP→物理)
 * 写回，因此 32px/tick 是真实的 CSS px/tick，甩出判定 `nx >= screenW` 也用 DIP 边界，
 * 窗口会真正飞到屏幕边缘外才停下（不再在屏幕正中误判 fullyOff）。
 */
/** 进行中的抛出动画定时器集合：退出桌宠时统一取消，避免 restore 把窗口移回原位后，
 *  后台 setInterval 又继续把它甩出屏幕（那样「自动归还」会看起来没生效）。 */
const activeThrowTimers = new Set<ReturnType<typeof setInterval>>();

/** 取消所有进行中的窗口抛出动画（退出桌宠时调用）。 */
export function cancelThrows() {
  for (const t of activeThrowTimers) clearInterval(t);
  activeThrowTimers.clear();
}

export function throwWindow(hwnd: number, vx: number, vy: number, screenW: number) {
  if (!initWinApi()) return;
  const rect = getWindowRect(hwnd);
  if (!rect) return;
  // 兜底：正常流程下 carry 阶段的 win-move 已经记过原位；若本函数被直接调用（跳过 carry），
  // 此时窗口仍在原位，这里补记 —— 必须在下面 setInterval 逐帧 moveWindow 之前。
  rememberWindowOrigin(hwnd);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    const r = getWindowRect(hwnd);
    if (!r) { clearInterval(timer); activeThrowTimers.delete(timer); return; } // 窗口被关掉/销毁
    const nx = r.x + vx;
    const ny = r.y + vy + THROW_GRAVITY * ticks;
    moveWindow(hwnd, nx, ny);
    // 原版 hasNext(): 窗口完全移出屏幕 → 演出结束（此时已无可枚举的 activeIE）
    const fullyOff = (nx + r.w <= 0) || (nx >= screenW);
    if (fullyOff || ticks >= THROW_TICKS) { clearInterval(timer); activeThrowTimers.delete(timer); }
  }, SHIMEJI_TICK_MS);
  activeThrowTimers.add(timer);
}
