#!/usr/bin/env node
/**
 * 贴顶飞（flyMode='ceiling'）会话仿真 —— 回归用。
 *
 * 背景（本次修的 bug）：旧配置 `durationMs: 5000` 比「从地面升到屏幕上缘」所需时间还短
 * （moveSpeed 1.5px/帧 ≈ 90px/s，1080p 要约 10s），所以定时器先到期 → 走 `next:["fall"]`
 * → 用户看到的就是「飞到一定高度就自动掉下来了」。
 *
 * 修法：改为**会话式**（与攀爬同一套思路）——
 *   ① 上升段不计入贴顶时长，另有 CEILING_RISE_MAX_MS(30000) 安全兜底；
 *   ② 贴上缘那一刻起算巡逻预算 ceilingPatrolMs = ceilingMaxMs × [50%, 100%]，到期才掉落；
 *   ③ 动作级 durationMs 必须为 0（不挂定时器，由行为自收尾）。
 *
 * 本脚本逐帧复刻 Pet.stepFlyCeiling 的时序，对多个屏幕高度 × 起始位置 × 随机种子做蒙特卡洛：
 *  - 必须**每次都贴上缘**（旧行为下会中途掉）
 *  - 贴顶时长必须落在 [50%, 100%] × ceilingMaxMs 内且**不超过上限**
 *  - 掉落**只发生一次**，且绝不发生在贴上缘之前
 *  - 上升超时兜底不能误触发
 *
 * 用法：node scripts/sim-ceiling-fly.mjs [次数=2000]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const N = Number(process.argv[2] || 2000);
const DT_MS = 1000 / 60; // 每帧真实时长
const RISE_MAX_MS = 30000; // 与 Pet.CEILING_RISE_MAX_MS 保持一致

/** 确定性 PRNG（mulberry32），保证仿真可复现 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 复刻一次「贴顶飞」的全过程。
 * @param {number} screenH 屏幕高
 * @param {number} screenW 屏幕宽
 * @param {number} charH   角色高（决定起始 y）
 * @param {number} charW   角色宽（决定 x 上界）
 * @param {number} speed   moveSpeed（px/帧 @60fps）
 * @param {number} ceilingMaxMs 角色级「贴顶最长时长」
 * @param {number} durationMs 动作级 durationMs（新配置应为 0）
 * @param {() => number} rng
 */
function simulate({ screenH, screenW, charH, charW, speed, ceilingMaxMs, durationMs, rng }) {
  const startY = screenH - charH; // baselineY：脚贴地面
  const events = [];

  // —— resetFlySession ——
  let hangUntil = 0;
  let sessionActive = false;
  let startMs = 0;
  let flyEnterMs = 0;
  const hangMs = 500 + rng() * 1000;                            // stepFlyCeiling 阶段2a
  const patrolBudget = ceilingMaxMs * (0.5 + rng() * 0.5);      // resetFlySession 里的随机预算

  let t = 0;
  let y = startY;
  let x = rng() * (screenW - charW);
  let targetX = x; // 贴顶飞切进来时 targetPos = {x: 当前x, y: 0}
  let dropAt = null;
  let dropCause = null;
  let reachTopMs = null;
  let patrolMs = 0;
  let frames = 0;
  let legCount = 0;

  // 动作级定时器：scheduleActionEnd 语义 —— durationMs > 0 才挂定时器
  const durationTimer = durationMs > 0 ? durationMs : Infinity;
  let durationFired = false;

  const MAX_FRAMES = 60 * 300; // 300s 上限，防死循环
  while (frames++ < MAX_FRAMES) {
    if (t >= durationTimer) { durationFired = true; dropAt = t; dropCause = 'durationMs'; break; }

    const dy = 0 - y;
    if (Math.abs(dy) > 4) {
      // 阶段1：垂直上升
      if (t - flyEnterMs > RISE_MAX_MS) { dropAt = t; dropCause = 'rise-timeout'; break; }
      y += Math.sign(dy) * Math.min(Math.abs(dy), speed); // dt=1 帧
      t += DT_MS;
      continue;
    }
    // 已到顶
    y = 0;
    if (!sessionActive) { sessionActive = true; startMs = t; reachTopMs = t; }
    // 阶段2a：悬挂
    if (hangUntil === 0) { hangUntil = t + hangMs; t += DT_MS; continue; }
    if (hangUntil > 0 && t < hangUntil) { t += DT_MS; continue; }
    hangUntil = -1;
    // 阶段2b：巡逻 + 到期判定
    if (t - startMs >= patrolBudget) {
      patrolMs = t - startMs;
      dropAt = t; dropCause = 'timeout';
      break;
    }
    const dx = targetX - x;
    if (Math.abs(dx) < 6) {
      const cur = x;
      targetX = cur < screenW / 2 ? screenW - charW : 0;
      legCount++;
      t += DT_MS;
      continue;
    }
    x += Math.sign(dx) * Math.min(Math.abs(dx), speed);
    t += DT_MS;
  }

  return {
    reachedTop: reachTopMs !== null,
    reachTopMs,
    patrolMs,
    totalMs: dropAt,
    dropCause,
    durationFired,
    legCount,
    startY,
  };
}

const chGwen = JSON.parse(readFileSync(join(ROOT, 'config', 'characters', 'gwen.json'), 'utf8'));
const acGwen = JSON.parse(readFileSync(join(ROOT, 'config', 'actions', 'gwen.json'), 'utf8'));
const flyCeiling = (acGwen.actions || acGwen).flyCeiling;
const ceilingMaxMs = chGwen.ceilingMaxMs ?? 20000;
const speed = flyCeiling.moveSpeed ?? chGwen.moveSpeed ?? 1.2;

console.log(`\n=== 贴顶飞会话仿真（${N} 次/场景） ===`);
console.log(`读自 config：ceilingMaxMs=${ceilingMaxMs}ms  moveSpeed=${speed}px/帧`
  + `  flyCeiling.durationMs=${flyCeiling.durationMs}`);
if (flyCeiling.durationMs !== 0) {
  console.log('  ⚠ flyCeiling.durationMs 应为 0（会话驱动，不挂定时器）！当前配置会导致中途掉落。');
}

const scenarios = [
  { name: '1366x768 ', screenW: 1366, screenH: 768 },
  { name: '1920x1080', screenW: 1920, screenH: 1080 },
  { name: '2560x1440', screenW: 2560, screenH: 1440 },
  { name: '3840x2160', screenW: 3840, screenH: 2160 },
];
const CHAR_W = chGwen.size.width, CHAR_H = chGwen.size.height;

let fail = 0;
console.log('\n场景           到达上缘   贴顶时长(min/avg/max)      总时长(max)   折返腿(avg)  掉落原因');
for (const sc of scenarios) {
  const stats = [];
  for (let i = 0; i < N; i++) {
    const rng = mulberry32(i + 1);
    const r = simulate({
      screenW: sc.screenW, screenH: sc.screenH, charW: CHAR_W, charH: CHAR_H,
      speed, ceilingMaxMs, durationMs: flyCeiling.durationMs, rng,
    });
    stats.push(r);
    // —— 断言 ——
    if (!r.reachedTop) { fail++; console.log(`  ✗ ${sc.name} seed=${i + 1} 未贴上缘就掉了（${r.dropCause}）`); }
    else if (r.dropCause !== 'timeout') { fail++; console.log(`  ✗ ${sc.name} seed=${i + 1} 掉落原因异常: ${r.dropCause}`); }
    else if (r.patrolMs > ceilingMaxMs + DT_MS) { fail++; console.log(`  ✗ ${sc.name} seed=${i + 1} 贴顶 ${Math.round(r.patrolMs)}ms 超过上限 ${ceilingMaxMs}ms（+1 帧容差）`); }
    else if (r.patrolMs < ceilingMaxMs * 0.5 - 20) { fail++; console.log(`  ✗ ${sc.name} seed=${i + 1} 贴顶只有 ${Math.round(r.patrolMs)}ms（预算下限 ${ceilingMaxMs * 0.5}ms）`); }
  }
  const ok = stats.filter((s) => s.reachedTop && s.dropCause === 'timeout');
  const patrols = ok.map((s) => s.patrolMs);
  const avg = patrols.reduce((a, b) => a + b, 0) / (patrols.length || 1);
  const legs = stats.map((s) => s.legCount);
  const avgLeg = legs.reduce((a, b) => a + b, 0) / (legs.length || 1);
  const maxTotal = Math.max(...stats.map((s) => s.totalMs ?? 0));
  console.log(`${sc.name}   ${ok.length}/${N}   `
    + `${String(Math.round(Math.min(...patrols))).padStart(5)}/${String(Math.round(avg)).padStart(5)}/${String(Math.round(Math.max(...patrols))).padStart(5)}ms   `
    + `${String(Math.round(maxTotal)).padStart(6)}ms   ${avgLeg.toFixed(2).padStart(8)}   timeout`);
}

// —— 对照：旧配置（durationMs=5000）为什么会「飞到一半就掉」——
console.log('\n=== 对照：旧配置 durationMs=5000（修复前的行为）===');
console.log('场景           到顶率      掉落原因分布');
for (const sc of scenarios) {
  let reached = 0;
  const causes = {};
  for (let i = 0; i < Math.min(N, 300); i++) {
    const rng = mulberry32(i + 1);
    const r = simulate({
      screenW: sc.screenW, screenH: sc.screenH, charW: CHAR_W, charH: CHAR_H,
      speed, ceilingMaxMs, durationMs: 5000, rng,
    });
    if (r.reachedTop) reached++;
    causes[r.dropCause] = (causes[r.dropCause] || 0) + 1;
  }
  const n = Math.min(N, 300);
  const dist = Object.entries(causes).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`${sc.name}   ${String(reached).padStart(3)}/${n}   ${dist}`);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 处失败`}（新配置：贴顶时长恒在 [50%,100%]×`
  + `${ceilingMaxMs}ms 内，且必定先贴上缘再掉）`);
process.exit(fail === 0 ? 0 : 1);
