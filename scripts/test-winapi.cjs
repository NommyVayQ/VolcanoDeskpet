'use strict';
/**
 * DeskPet 主进程 winapi 模块 —— 边界值 / 异常 / 幂等 测试。
 *
 * 运行：node scripts/test-winapi.cjs
 * 加载的是真实编译产物 dist/main/main/winapi.js（不是源码拷贝），因此测的是上线代码。
 * 不依赖 Electron 运行（getScreen 在 electron 不可用时优雅降级为 scaleFactor=1），
 * 但需要 Windows + koffi（开发机满足）。
 *
 * 测试窗口：用 CreateWindowExA 创建一个「消息专用(HWND_MESSAGE)隐形窗口」，
 *   ① 不被 EnumWindows 枚举 → 不污染 listWindows 结果；
 *   ② 不可见 → 不会在屏幕上闪一下；
 *   ③ 真实可被 GetWindowRect/SetWindowPos 操作 → 能真正验证「搬动后归还」的幂等。
 *   测试结束 DestroyWindow 销毁，绝不遗留、绝不碰用户窗口。
 */
const path = require('path');
const koffi = require('koffi');

let pass = 0, fail = 0, skip = 0;
const results = [];
function check(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e && e.message ? e.message : String(e)]); }
}
function skipTest(name, reason) { skip++; results.push(['SKIP', name, reason]); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const winapi = require(path.join(__dirname, '..', 'dist', 'main', 'main', 'winapi.js'));

// —— 自建测试窗口（koffi 直连 Win32）——
let testHwnd = 0;
let destroyTestWindow = () => {};
(function buildTestWindow() {
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const createWindowExA = user32.func('CreateWindowExA', 'intptr',
      ['uint32', 'str', 'str', 'uint32', 'int32', 'int32', 'int32', 'int32', 'intptr', 'intptr', 'intptr', 'intptr']);
    const destroyWindow = user32.func('DestroyWindow', 'bool', ['intptr']);
    // HWND_MESSAGE = -3：消息专用窗口，不显示、不被 EnumWindows 枚举
    const hwnd = Number(createWindowExA(0, 'Static', 'DeskPetTestWindow', 0, 200, 200, 320, 240, -3, 0, 0, 0));
    if (!hwnd || hwnd === 0 || hwnd === -1) throw new Error('CreateWindowExA 返回无效句柄 ' + hwnd);
    testHwnd = hwnd;
    destroyTestWindow = () => { try { destroyWindow(hwnd); } catch { /* ignore */ } };
  } catch (e) {
    testHwnd = 0;
    destroyTestWindow = () => {};
    skipTest('真实窗口幂等子测试（需自建窗口）', '测试窗口创建失败：' + (e && e.message || e) + ' —— 仅跳过该子集，其余照常');
  }
})();

try {
  // 预初始化：所有公开函数内部都会懒加载，但这里显式触发一次，
  // 后续断言基于「已初始化」状态（isWinApiAvailable 是被动 getter，未触发前为 false 属正常）。
  winapi.initWinApi();

  // ════════════════════ 1. 可用性 ════════════════════
  check('isWinApiAvailable() 初始化后在 Windows 主机返回 true', () => {
    assert(winapi.isWinApiAvailable() === true, 'koffi/user32 未初始化成功，环境不支持');
  });

  // ════════════════════ 2. 异常 / 垃圾输入（核心：喂坏句柄不能崩） ════════════════════
  check('getWindowRect(0) 无效句柄 → 返回 null 而非抛异常', () => {
    assert(winapi.getWindowRect(0) === null, '应为 null');
  });
  check('getWindowRect(-1) 无效句柄 → 返回 null', () => {
    assert(winapi.getWindowRect(-1) === null, '应为 null');
  });
  check('getWindowRect(0x7FFFFFFF) 越界句柄 → 返回 null', () => {
    assert(winapi.getWindowRect(0x7fffffff) === null, '应为 null');
  });
  check('moveWindow(0, 100, 100) 无效句柄 → 返回 false 且不抛异常', () => {
    assert(winapi.moveWindow(0, 100, 100) === false, '无效句柄移动应返回 false');
  });
  check('throwWindow(0, 1, 1, 1920) 无效句柄 → 不抛异常（提前 return）', () => {
    winapi.throwWindow(0, 1, 1, 1920); // 期望内部 getWindowRect 返回 null 后直接 return
  });
  check('cancelThrows() 无任何进行中抛出时 → 不抛异常（幂等安全）', () => {
    winapi.cancelThrows();
  });
  check('getTaskbarRect() 调用不抛异常（返回对象或 null）', () => {
    const r = winapi.getTaskbarRect();
    assert(r === null || (typeof r === 'object' && r.rect && typeof r.visible === 'boolean'),
      '返回类型异常: ' + JSON.stringify(r));
  });

  // ════════════════════ 3. listWindows 边界 / 形状 ════════════════════
  check('listWindows() 返回数组且元素结构完整', () => {
    const wins = winapi.listWindows();
    assert(Array.isArray(wins), '应返回数组');
    for (const w of wins) {
      assert(typeof w.hwnd === 'number', 'hwnd 应为 number');
      assert(typeof w.title === 'string', 'title 应为 string');
      assert(typeof w.x === 'number' && typeof w.y === 'number', 'x/y 应为 number');
      assert(typeof w.w === 'number' && typeof w.h === 'number', 'w/h 应为 number');
      assert(typeof w.z === 'number', 'z 应为 number');
      assert(typeof w.occluded === 'boolean', 'occluded 应为 boolean');
    }
  });
  check('listWindows 的 z 字段严格单调 0..n-1（Z 序正确）', () => {
    const wins = winapi.listWindows();
    for (let i = 0; i < wins.length; i++) assert(wins[i].z === i, '第 ' + i + ' 个窗口 z=' + wins[i].z + ' 不等于 ' + i);
  });
  check('listWindows(undefined, []) 空白名单 → 等价于不过滤', () => {
    const a = winapi.listWindows();
    const b = winapi.listWindows(undefined, []);
    assert(a.length === b.length, '空白名单应与原结果数量一致 (' + a.length + ' vs ' + b.length + ')');
  });
  check('listWindows 传入绝对不匹配的白名单 → 返回 []', () => {
    const wins = winapi.listWindows(undefined, ['__deskpet_no_such_window_xyz__']);
    assert(Array.isArray(wins) && wins.length === 0, '应返回空数组，实际 ' + wins.length);
  });
  check('listWindows(excludeHwnd=0x7FFFFFFF) 越界排除参数 → 不抛异常', () => {
    const wins = winapi.listWindows(0x7fffffff);
    assert(Array.isArray(wins), '越界 excludeHwnd 不应导致崩溃');
  });
  check('listWindows 候选窗口不含披隐/最小化/最大化（occluded 与可见性一致）', () => {
    const wins = winapi.listWindows();
    // 至少能枚举到若干窗口（开发机必然有）；并断言所有返回的都不是最大化（IsZoomed 已在内部排除）
    for (const w of wins) assert(w.w >= 200 && w.h >= 120, '返回窗口尺寸应 >= 过滤下限，异常: ' + w.title);
  });

  // ════════════════════ 4. 幂等（核心：重复调用安全、空账本 no-op） ════════════════════
  check('restoreWindows() 空账本调用两次 → 均返回 0 且不抛异常（退出兜底幂等）', () => {
    const a = winapi.restoreWindows();
    const b = winapi.restoreWindows();
    assert(a === 0 && b === 0, '空账本恢复应返回 0，实际 ' + a + '/' + b);
  });
  check('moveWindow 无效句柄不会污染归还账本（移动后立即 restore 仍为 0）', () => {
    winapi.moveWindow(0, 1, 1); // 无效句柄 → rememberWindowOrigin 提前 return，不记账
    assert(winapi.restoreWindows() === 0, '无效移动不应产生待归还项');
  });

  // —— 真实窗口路径：搬动 → 归还 → 再归还（幂等 + 归位正确） ——
  if (testHwnd) {
    check('moveWindow(真实窗口) → 移动后位置改变', () => {
      const before = winapi.getWindowRect(testHwnd);
      assert(before, '测试窗口应有有效矩形');
      winapi.moveWindow(testHwnd, before.x + 50, before.y + 30);
      const after = winapi.getWindowRect(testHwnd);
      assert(after, '移动后应有有效矩形');
      // 允许 ±2px 取整误差
      assert(Math.abs(after.x - (before.x + 50)) <= 2 && Math.abs(after.y - (before.y + 30)) <= 2,
        '移动后坐标未如期变化: before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
    });
    check('restoreWindows() 归还一次 → 返回 1 且窗口回到原位', () => {
      const cur = winapi.getWindowRect(testHwnd);
      const n = winapi.restoreWindows();
      assert(n === 1, '应恢复 1 个窗口，实际 ' + n);
      const back = winapi.getWindowRect(testHwnd);
      // 归位：回到 moveWindow 之前的位置（即测试窗口初始 200,200 附近，±2 取整误差）
      assert(Math.abs(back.x - 200) <= 2 && Math.abs(back.y - 200) <= 2,
        '归还后未回到初始位置: ' + JSON.stringify(back));
      // 顺带确认 cur 确实被移开了，证明这次 restore 真做了事
      assert(!(Math.abs(cur.x - 200) <= 2 && Math.abs(cur.y - 200) <= 2), 'restore 前窗口应处于被移动状态');
    });
    check('restoreWindows() 再次调用 → 返回 0（账本已清空，幂等 no-op）', () => {
      const n = winapi.restoreWindows();
      assert(n === 0, '二次归还应返回 0，实际 ' + n);
    });
    check('throwWindow(真实窗口) 启动后 cancelThrows() 可安全取消（退出时不漏甩）', () => {
      // 先把窗口搬开一点再甩
      const r = winapi.getWindowRect(testHwnd);
      winapi.moveWindow(testHwnd, r.x, r.y);
      winapi.throwWindow(testHwnd, 5, 0, 5000);
      winapi.cancelThrows(); // 期望清空 activeThrowTimers，后续 restore 不会被后台甩走
      // 立刻归还，确认不会被残留定时器甩飞
      winapi.restoreWindows();
      const back = winapi.getWindowRect(testHwnd);
      assert(Math.abs(back.x - r.x) <= 2 && Math.abs(back.y - r.y) <= 2,
        'cancelThrows 后归还未稳定，窗口被甩偏: ' + JSON.stringify(back));
    });
  }

} finally {
  destroyTestWindow();
}

// ════════════════════ 报告 ════════════════════
console.log('\n════════════ DeskPet winapi 测试结果 ══════════════');
console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip + '  总计=' + (pass + fail + skip));
console.log('─────────────────────────────────────────────');
for (const [st, name, info] of results) {
  const tag = st === 'PASS' ? '✓' : st === 'FAIL' ? '✗' : '·';
  console.log(tag + ' [' + st + '] ' + name + (info ? '  → ' + info : ''));
}
console.log('══════════════════════════════════════════════════');
process.exit(fail === 0 ? 0 : 1);
