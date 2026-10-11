/**
 * Z 序实测探针（一次性排查工具，不进构建链）。
 *
 * 跑法：node scripts/probe-zorder.mjs
 *
 * 目的：搞清楚「屏幕最上层」在 Win32 里到底怎么问才准 ——
 *   1) EnumWindows 的枚举顺序是否就是 Z 序（顶→底）；
 *   2) 前台窗口 GetForegroundWindow 是否 == z=0 那个；
 *   3) 任务栏 / 输入法 / 悬浮工具窗会不会占掉 z=0，导致"永远站不上去"。
 * 结论要用来决定「站窗顶必须是最上层窗口」这条规则怎么落地。
 */
import koffi from 'koffi';
import os from 'node:os';

const lib = koffi.load('user32.dll');
const RECT = koffi.struct('RECT', {
  left: 'long', top: 'long', right: 'long', bottom: 'long',
});
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const u = {
  EnumWindows: lib.func('EnumWindows', 'bool', ['intptr', 'intptr']),
  IsWindowVisible: lib.func('IsWindowVisible', 'bool', ['intptr']),
  IsIconic: lib.func('IsIconic', 'bool', ['intptr']),
  GetWindowRect: lib.func('GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]),
  GetWindowTextW: lib.func('GetWindowTextW', 'int', ['intptr', 'void*', 'int']),
  GetForegroundWindow: lib.func('GetForegroundWindow', 'intptr', []),
  WindowFromPoint: lib.func('WindowFromPoint', 'intptr', [POINT]),
  GetAncestor: lib.func('GetAncestor', 'intptr', ['intptr', 'uint']),
};
const enumProto = koffi.proto('bool __stdcall EnumWindowsCb(intptr hwnd, intptr lparam)');

const fg = Number(u.GetForegroundWindow());
const rows = [];
let z = 0;
const cbRef = koffi.register((hwndPtr) => {
  const h = Number(hwndPtr);
  if (!u.IsWindowVisible(h) || u.IsIconic(h)) return true;
  const arr = [null];
  if (!u.GetWindowRect(h, arr)) return true;
  const r = arr[0];
  const w = r.right - r.left, ht = r.bottom - r.top;
  if (w <= 0 || ht <= 0) return true;
  if (r.left < -2000 || r.top < -2000) return true;
  const buf = Buffer.allocUnsafe(1024);
  const n = u.GetWindowTextW(h, buf, 256);
  const title = n > 0 ? String(koffi.decode(buf, 'char16_t', n)) : '(无标题)';
  rows.push({
    z: z++, hwnd: h, title: title.slice(0, 40),
    rect: `${r.left},${r.top} ${w}x${ht}`,
    fg: h === fg ? '★前台' : '',
    isSelf: h === fg ? '' : '',
  });
  return true;
}, enumProto);
u.EnumWindows(cbRef, 0);
koffi.unregister(cbRef);

console.log('EnumWindows 顺序（z 小 = 靠前）。前台 hwnd =', fg, '\n');
console.log('z   hwnd       前台  矩形(物理px)             标题');
for (const r of rows.slice(0, 20)) {
  console.log(
    String(r.z).padEnd(4),
    String(r.hwnd).padEnd(11),
    (r.fg || '').padEnd(5),
    r.rect.padEnd(24),
    r.title,
  );
}
console.log('\n共 ' + rows.length + ' 个可见顶层窗口');
const fgRow = rows.find((r) => r.hwnd === fg);
console.log('前台窗口的 z =', fgRow ? fgRow.z : '不在可见列表里', fgRow ? '(' + fgRow.title + ')' : '');
console.log('os.hostname =', os.hostname());
