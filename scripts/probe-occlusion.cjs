/** 只读探针：验证 WindowFromPoint 遮挡判定（不移动任何窗口）。 */
const koffi = require('koffi');
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const PT = koffi.struct('DESKPET_POINT', { x: 'long', y: 'long' });
const lib = koffi.load('user32.dll');
// 对齐 Electron 主进程的 DPI 口径：不声明的话 node 是 DPI-unaware，
// GetWindowRect/WindowFromPoint 坐标被系统虚拟化缩放，对 DirectComposition 窗口（QQ 等）判定会失真
lib.func('SetProcessDPIAware', 'bool', [])();

const user32 = {
  EnumWindows: lib.func('EnumWindows', 'bool', ['intptr', 'intptr']),
  IsWindowVisible: lib.func('IsWindowVisible', 'bool', ['intptr']),
  IsIconic: lib.func('IsIconic', 'bool', ['intptr']),
  IsZoomed: lib.func('IsZoomed', 'bool', ['intptr']),
  GetWindowRect: lib.func('GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]),
  GetWindowTextW: lib.func('GetWindowTextW', 'int', ['intptr', 'void*', 'int']),
  GetWindowThreadProcessId: lib.func('GetWindowThreadProcessId', 'uint32', ['intptr', 'void*']),
  WindowFromPoint: lib.func('WindowFromPoint', 'intptr', [PT]),
  GetAncestor: lib.func('GetAncestor', 'intptr', ['intptr', 'uint32']),
};
const enumProto = koffi.pointer(koffi.proto('bool __stdcall EnumProc(intptr hwnd)'));
const GetWindowLongW = lib.func('GetWindowLongW', 'long', ['intptr', 'int']);
const GetClassNameW = lib.func('GetClassNameW', 'int', ['intptr', 'void*', 'int']);
const classNameOf = (h) => {
  const buf = Buffer.allocUnsafe(512);
  const n = GetClassNameW(h, buf, 256);
  return n > 0 ? String(koffi.decode(buf, 'char16_t', n)) : '?';
};
const dwm = koffi.load('dwmapi.dll');
const getCloaked = dwm.func('DwmGetWindowAttribute', 'long', ['intptr', 'uint32', 'void*', 'uint32']);
const isCloaked = (h) => {
  const out = Buffer.alloc(4);
  if (getCloaked(h, 14, out, 4) !== 0) return false;
  return out.readInt32LE(0) !== 0;
};

const wins = [];
let zIdx = 0;
const cb = (hwndPtr) => {
  const hwnd = Number(hwndPtr);
  if (!user32.IsWindowVisible(hwnd) || user32.IsIconic(hwnd)) return true;
  const arr = [null];
  if (!user32.GetWindowRect(hwnd, arr)) return true;
  const r = arr[0];
  const w = r.right - r.left, h = r.bottom - r.top;
  if (w < 200 || h < 120 || r.left < -2000 || r.top < -2000) return true;
  const buf = Buffer.allocUnsafe(1024);
  const n = user32.GetWindowTextW(hwnd, buf, 256);
  if (n <= 0) return true;
  const title = String(koffi.decode(buf, 'char16_t', n));
  if (!title || title === 'Program Manager' || title === 'Windows Input Experience') return true;
  wins.push({ hwnd, title, r, w, h, z: zIdx++ });
  return true;
};
const cbRef = koffi.register(cb, enumProto);
try { user32.EnumWindows(cbRef, 0); } finally { koffi.unregister(cbRef); }

const isOwnPid = (h) => {
  const pb = Buffer.alloc(4);
  user32.GetWindowThreadProcessId(h, pb);
  const pid = pb.readUInt32LE(0);
  return pid === process.pid || pid === deskpetPid;
};
// 探针进程不等于 DeskPet 进程：动态找 DeskPet 透明窗（标题 DeskPet MVP）的 PID 当「自己」
let deskpetPid = 0;
for (const win of wins) {
  if (win.title === 'DeskPet MVP' || win.title.includes('DeskPet')) {
    const pb = Buffer.alloc(4);
    user32.GetWindowThreadProcessId(win.hwnd, pb);
    deskpetPid = pb.readUInt32LE(0);
    break;
  }
}
console.log('DeskPet pid =', deskpetPid);
const pointVisible = (px, py, self) => {
  const hit = Number(user32.WindowFromPoint({ x: px, y: py }));
  if (!hit || isOwnPid(hit)) return true;
  return Number(user32.GetAncestor(hit, 2)) === self;
};

console.log('候选窗口数:', wins.length);
const titleOf = (h) => {
  const buf = Buffer.allocUnsafe(512);
  const n = user32.GetWindowTextW(h, buf, 256);
  return n > 0 ? String(koffi.decode(buf, 'char16_t', n)) : ('(无标题#' + h + ')');
};
for (const win of wins) {
  const sx = [0.5, 0.25, 0.75, 0.25, 0.75];
  const sy = [0.5, 0.25, 0.25, 0.75, 0.75];
  const pts = sx.map((f, i) => [Math.round(win.r.left + win.w * f), Math.round(win.r.top + win.h * f)]);
  const hits = pts.map(([x, y]) => {
    const hit = Number(user32.WindowFromPoint({ x, y }));
    const root = hit ? Number(user32.GetAncestor(hit, 2)) : 0;
    return x + ',' + y + '→' + (hit ? titleOf(root) + (hit !== root ? '(子窗)' : '') : 'null');
  });
  const visiblePts = pts.filter(([x, y]) => pointVisible(x, y, win.hwnd)).length;
  const style = GetWindowLongW(win.hwnd, -16) >>> 0;
  const exstyle = GetWindowLongW(win.hwnd, -20) >>> 0;
  console.log(
    (visiblePts > 0 ? '可见' : '遮挡') + '  可见采样点 ' + visiblePts + '/5',
    '「' + win.title + '」', win.w + 'x' + win.h, '@' + win.r.left + ',' + win.r.top,
    '| class=' + classNameOf(win.hwnd),
    'disabled=' + (!!(style & 0x08000000)),
    'transparent=' + (!!(exstyle & 0x20)),
    'cloaked=' + isCloaked(win.hwnd)
  );
  if (visiblePts === 0) {
    console.log('   z=' + win.z + ' 命中明细:', hits.join(' | '));
    // 密集扫描：在窗口矩形内 8x8 网格逐点问 WindowFromPoint，统计命中自身/其他
    let selfHits = 0, otherHits = new Map();
    for (let ix = 0; ix < 8; ix++) for (let iy = 0; iy < 8; iy++) {
      const px = Math.round(win.r.left + win.w * (ix + 0.5) / 8);
      const py = Math.round(win.r.top + win.h * (iy + 0.5) / 8);
      const hit = Number(user32.WindowFromPoint({ x: px, y: py }));
      if (!hit) continue;
      const root = Number(user32.GetAncestor(hit, 2));
      if (root === win.hwnd) selfHits++;
      else otherHits.set(titleOf(root), (otherHits.get(titleOf(root)) || 0) + 1);
    }
    console.log('   8x8 密集扫描: 命中自身 ' + selfHits + '/64，其他: ' + JSON.stringify([...otherHits.entries()]));
  }
}
