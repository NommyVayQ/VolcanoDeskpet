/**
 * 互动互斥（meetLock.ts）的 headless 单元测试 + app.ts 接线静态断言。
 *
 * 跑法：node scripts/test-meet-exclusion.mjs
 *
 * 背景（2026-10-11 用户报的 bug）：A、B 在互动时，C、D 就永远触发不了互动。
 * 根因是占用判定写成了**全局锁**（旧 `isAnyCoopActive()` 扫描全场角色），
 * 正确语义是**谁被占用谁才互斥**。
 *
 * 做什么：
 *   1. 把 meetLock.ts 单独编译成 CommonJS（它只 `import type { Pet }`，无运行时依赖 → 不需要 stub）；
 *   2. 用假 Pet 验证三种占用态与「不相关的第三组不受影响」的核心语义；
 *   3. 对 app.ts 做静态断言：全局锁不得复活、五处调用点都要走按角色判定、
 *      挑搭档必须排除已在互动/合体中的角色。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.tmp-meetlock');
const srcFile = path.join(root, 'src/renderer/meetLock.ts');

// ---------------------------------------------------------------- 编译
function compile() {
  const out = path.join(outDir, 'meetLock.js');
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(srcFile).mtimeMs) return out;
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  try {
    execFileSync(process.execPath, [tsc, 'src/renderer/meetLock.ts',
      '--outDir', '.tmp-meetlock', '--module', 'commonjs', '--target', 'es2020',
      '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop'],
      { cwd: root, stdio: 'pipe' });
  } catch (e) {
    // 沙箱下 node 派生子进程常报 EBUSY。此时若有上次产物就复用（并提示手工刷新），否则真失败。
    if (fs.existsSync(out)) {
      console.log('! tsc 子进程被拦（' + (e.code || 'spawn 失败') + '），复用已有产物；'
        + '改了 meetLock.ts 请先手工编译：npx tsc src/renderer/meetLock.ts --outDir .tmp-meetlock '
        + '--module commonjs --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop');
      return out;
    }
    throw e;
  }
  return out;
}

// ---------------------------------------------------------------- 断言器
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

// ---------------------------------------------------------------- 假 Pet
/** 只实现 meetLock 用到的三个方法 + _pending* 字段。 */
function mk(o = {}) {
  return {
    isInCoop: () => !!o.inCoop,
    isApproaching: () => !!o.approaching,
    config: { actions: o.actions || {} },
    _pendingIsPair: o.pendingIsPair,
    _pendingAction: o.pendingAction,
  };
}

const { isCoopBusyFor, isCoopBusyForPair } = (await import('file://' + compile()));

console.log('\n[1] 占用态判定（单只角色）');
check('T1a 空闲角色不占用', isCoopBusyFor(mk()) === false);
check('T1b 正在播合体帧（isInCoop）→ 占用', isCoopBusyFor(mk({ inCoop: true })) === true);
check('T1c 配对动作走近中（_pendingIsPair）→ 占用',
  isCoopBusyFor(mk({ approaching: true, pendingIsPair: true })) === true);
check('T1d 旧式 coop 走近中（_pendingAction 指向 coop）→ 占用',
  isCoopBusyFor(mk({ approaching: true, pendingAction: 'interact', actions: { interact: { coop: true } } })) === true);
check('T1e 普通互动走近中（_pendingAction 指向非 coop）→ **不**占用（普通相遇本就允许并发）',
  isCoopBusyFor(mk({ approaching: true, pendingAction: 'interact', actions: { interact: {} } })) === false);
check('T1f 有 _pendingAction 但动作不存在 → 不占用',
  isCoopBusyFor(mk({ approaching: true, pendingAction: 'ghost' })) === false);
check('T1g 站着不动但有 coop 标记 → 不占用（只在走近中才算）',
  isCoopBusyFor(mk({ pendingAction: 'interact', actions: { interact: { coop: true } } })) === false);

console.log('\n[2] 核心语义：谁被占用谁才互斥（用户报的 bug）');
const A = mk({ inCoop: true });   // A、B 正在合体
const B = mk({ inCoop: true });
const C = mk();                    // C、D 完全空闲
const D = mk();
check('T2a A↔B 自己被占用（别人插不进来）', isCoopBusyForPair(A, B) === true);
check('T2b ★ C↔D 不受 A↔B 影响，可以互动', isCoopBusyForPair(C, D) === false);
check('T2c ★ C 想找 A 互动 → 被拒（A 在合体中）', isCoopBusyForPair(C, A) === true);
check('T2d ★ D 想找 B 互动 → 被拒（B 在合体中）', isCoopBusyForPair(D, B) === true);
check('T2e 判据对称（参数顺序无关）',
  isCoopBusyForPair(A, C) === isCoopBusyForPair(C, A));

console.log('\n[3] 多组并发（5 角色场景：rose/nina/rebeza/gwen/mona）');
// rose↔nina 合体中；gwen↔mona 空闲；rebeza 空闲
const rose = mk({ inCoop: true }), nina = mk({ inCoop: true });
const gwen = mk(), mona = mk(), rebeza = mk();
check('T3a gwen↔mona 可与 rose↔nina 的合体**同时**进行', isCoopBusyForPair(gwen, mona) === false);
check('T3b rebeza↔gwen 也行', isCoopBusyForPair(rebeza, gwen) === false);
check('T3c rebeza 不能插进 rose↔nina', isCoopBusyForPair(rebeza, rose) === true
  && isCoopBusyForPair(rebeza, nina) === true);
// gwen↔mona 也在演了 → rebeza 只能找剩下的人（没人了）→ 全占用
const gwen2 = mk({ inCoop: true }), mona2 = mk({ inCoop: true });
check('T3d 两组都在演时，rebeza 找谁都被拒', isCoopBusyForPair(rebeza, gwen2) === true
  && isCoopBusyForPair(rebeza, mona2) === true);

// ---------------------------------------------------------------- app.ts 静态接线断言
console.log('\n[4] app.ts 接线（防全局锁复活）');
const appSrc = fs.readFileSync(path.join(root, 'src/renderer/app.ts'), 'utf8');
const code = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // 剥注释

check('T4a 全局锁 isAnyCoopActive 已不存在（连定义都没有）',
  !/isAnyCoopActive\s*\(/.test(code), '仍出现 isAnyCoopActive(...)');
check('T4b 引入 meetLock 模块', /from '\.\/meetLock'/.test(appSrc));

const pairCalls = (code.match(/isCoopBusyForPair\(/g) || []).length;
const singleCalls = (code.match(/isCoopBusyFor\(/g) || []).length;
check('T4c isCoopBusyForPair 用于 startPairedMeet + rollMeet 两处（菜单分支用逐个判的 isCoopBusyFor）',
  pairCalls >= 2, '实际 ' + pairCalls);
check('T4d isCoopBusyFor 至少 2 处调用（菜单 pairTrigger / coop 分支逐个判自己与搭档）',
  singleCalls >= 2, '实际 ' + singleCalls);
check('T4e startPairedMeet 走按角色判定（不再扫全场）',
  /function startPairedMeet[\s\S]{0,300}?isCoopBusyForPair\(a, b\)/.test(code));
check('T4f rollMeet 走按角色判定',
  /const coopBusy = isCoopBusyForPair\(a, b\)/.test(code));
check('T4g 挑搭档时会排除「已在互动/合体中」的角色（否则 startApproach 会静默 return → 点了没反应）',
  /p\.isMeetBusy\(\) \|\| p\.isInCoop\(\)/.test(code));
check('T4h rollMeet 两轮式提交：先掷骰去重（taken），再统一走近（for (const wn of winners)）'
  + ' —— 否则落地闸门延迟进场时，同一个人会被同一轮里的两对同时预定',
  /const taken = new Set<Pet>\(\)/.test(code) && /winners\.push\(\{/.test(code)
  && /for \(const wn of winners\)/.test(code));

console.log('\n————————————————————————');
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `失败 ${fail} / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
