#!/usr/bin/env node
/**
 * 动作时长统一治理：消除「动作过长 / 播一半被切 / 兜底一刀切」三类问题。
 *
 * 规则（与 Pet.ts 的轮末对齐机制配套）：
 *  1. 位移类（walk/climb/ceiling/chase/fly）：靠到达目标结束，只留兜底定时器，不加 loopCount
 *     （加了会播完一轮就停，走路 2 秒就站住）。
 *  2. 静止多帧类：改「播完一轮即收尾」—— loopCount:1 + durationMs:0，
 *     完全不再依赖定时器，从根本上不会被切一半。
 *  3. 静止单帧类：没有可播完的中间态，显式给 durationMs（sit/stand 2500，其余 0）。
 *  4. 一轮超过 DURATION_CEILING_MS 的，压缩 frameMs 把一轮压到上限内（只调快播放，不动帧）。
 *
 * 用法：node scripts/tune-action-durations.mjs [--apply]   （默认 dry-run，只打印计划）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

const DURATION_CEILING_MS = 6000; // 静止类动作一轮时长上限
const MOVE_ROUND_CEILING_MS = 3000; // 位移类一轮上限：位移动作靠定时器兜底收尾，
                                    // 一轮太长会让「轮末对齐」额外多等一整轮
const MIN_FRAME_MS = 500;           // 压缩下限：低于此值动作会显得急促（尊重原始美术节奏）
// 位移类的兜底超时：语义是「异常卡死时强制收尾」，**不是**正常时长。
// 必须大于「最坏一段正常位移」的耗时，否则会把爬到一半/走到一半的角色硬切回站立：
//   walk/creep 局部游走最大 ±2×wanderRangePx(320) = 640px，moveSpeed 1.2 → 约 8.9s
//   climb 单腿最多爬满屏高（1080p 约 1080px）→ 约 13.5s；这里取 25000 是为了**严格大于 climbMaxMs(20000)**，
//     让「攀爬会话到期 → 掉落 / 起飞」的逻辑先于动作级兜底触发（两者同时到点会随机绕过起飞出口）
// fly 例外：它本身就是「飞一会儿」语义，到达后重选目标会无限飞，5000 是真实时长。
// 注意：flyMode='ceiling' 的「贴顶飞行」不算位移类 —— 它是**会话驱动**（见 isSessionDriven），
//       durationMs 必须是 0，绝不能被本脚本改回 5000。
const DISPLACEMENT_FALLBACK = { walk: 10000, creep: 10000, climb: 25000, ceiling: 20000, chase: 10000, fly: 5000 };
// 占比审计专用：位移类是「走到目标就停」，兜底值（10–20s）几乎用不到，
// 按 wanderRangePx 的一半距离 / moveSpeed 估算典型时长，否则会把 walk 的占比严重高估。
const TYPICAL_MOVE_MS = 2500;
const MOVE_FALLBACK_MAX_MS = 25000; // 位移类兜底超时的宽松上限，超过这个数说明配置不合理
const SINGLE_FRAME_HOLD = { sit: 5000, stand: 2500 }; // 单帧「保持类」动作的停留时长
// walk 是骨架行为（用户要求它的权重至少占一半），所以占比门禁分两档：
// 位移类允许更高（walk 本来就该最多），静止类仍然防「单一动作垄断屏幕」。
const WALK_WEIGHT_MIN_PCT = 50;         // walk 在 wanderActions 里的权重占比下限
const STATIC_SHARE_MAX_PCT = 40;        // 静止类动作的屏幕时间占比上限
const DISPLACEMENT_SHARE_MAX_PCT = 60;  // 位移类的屏幕时间占比上限（放宽）（sit 5000：坐一会儿的观感）

const IDS = ['rose', 'nina', 'rebeza', 'gwen'];

/** 把一轮时长压到上限内：只调 frameMs，不动帧数 */
function fitFrameMs(frames, frameMs, ceiling = DURATION_CEILING_MS) {
  const round = frames * frameMs;
  if (round <= ceiling) return frameMs;
  return Math.max(MIN_FRAME_MS, Math.floor(ceiling / frames / 50) * 50);
}

/** 由外部事件驱动结束、不靠定时器的动作：待机 / 拖拽 / 空中 / 触发即走的一次性动作 */
function isExternal(id, def, ch) {
  const externalIds = new Set([
    ch.defaultAction, ch.fallAction, ch.landAction, ch.spawnAction,
    ch.dragAction, ch.dragLeftAction, ch.dragRightAction, ch.dragIdleAction,
  ].filter(Boolean));
  return def.behavior === 'drag' || externalIds.has(id);
}

/** 摔倒类：动画只有几百毫秒，播完需要「躺一会儿」才起来，用角色级 tripDurationMs 定格 */
function isTripping(id, def) {
  return def.loop === false && /trip|land|knock/i.test(id);
}

/** 会话驱动：由 Pet 内部的状态机决定何时收尾，**不靠 durationMs**。
 *  目前只有「贴顶飞行」(behavior:'fly' + flyMode:'ceiling')：
 *  贴到屏幕上缘后左右巡逻，`ceilingMaxMs`（默认 20000）到期才下落 —— 与攀爬会话同一套思路。
 *  ⚠️ 它的 durationMs 必须是 0：旧配置写的 5000 比「从地面升到顶」所需时间还短，
 *    表现为「飞到一半就掉下来」。本脚本必须把它排除在「位移类兜底」之外，
 *    否则 `--apply` 会把 0 改回 5000，等于把这个 bug 改回来。 */
function isSessionDriven(def) {
  return def.behavior === 'fly' && def.flyMode === 'ceiling';
}

function classify(def) {
  const b = def.behavior;
  if (b === 'walk' || b === 'climb' || b === 'ceiling' || b === 'chase' || b === 'fly') return 'displacement';
  if (b === 'drag') return 'drag';
  const frames = (def.frames || []).length;
  return frames <= 1 ? 'single' : 'multi';
}

function planAction(id, def, ch) {
  const kind = isExternal(id, def, ch) ? 'external'
    : (isSessionDriven(def) ? 'session' : classify(def));
  const frames = (def.frames || []).length;
  const before = {
    frameMs: def.frameMs,
    loopCount: def.loopCount,
    durationMs: def.durationMs,
    roundMs: frames * (def.frameMs || 0),
  };
  const patch = {};

  if (kind === 'displacement') {
    patch.durationMs = DISPLACEMENT_FALLBACK[def.behavior] ?? 6000;
    // 位移类绝不能加 loopCount，否则播完一轮就自己停了
    if (def.loopCount !== undefined) patch.loopCount = undefined;
    // 一轮本身超上限的（如 creep 6 帧 × 1000）也压一下，否则兜底到期后还要多等一整轮才收尾
    const fm = fitFrameMs(frames, def.frameMs || 500, MOVE_ROUND_CEILING_MS);
    if (fm !== def.frameMs) patch.frameMs = fm;
  } else if (kind === 'drag' || kind === 'external') {
    patch.durationMs = 0; // 时长由外部事件决定（松手 / 落地 / 待机掷骰），不设限时
    if (def.loopCount !== undefined) patch.loopCount = undefined;
  } else if (kind === 'session') {
    patch.durationMs = 0; // 贴顶飞：由 Pet.stepFlyCeiling 的会话逻辑收尾（贴顶巡逻 ≤ ceilingMaxMs）
    if (def.loopCount !== undefined) patch.loopCount = undefined;
  } else if (isTripping(id, def)) {
    // 摔倒：帧动画只有几百 ms，用角色级时长让它播完后定格一会儿再爬起来
    patch.durationMs = ch.tripDurationMs ?? 1200;
    if (def.loopCount !== undefined) patch.loopCount = undefined;
  } else if (kind === 'single') {
    patch.durationMs = SINGLE_FRAME_HOLD[id] ?? 0;
  } else {
    // 静止多帧：播完一轮自然收尾
    const fm = fitFrameMs(frames, def.frameMs || 800);
    if (fm !== def.frameMs) patch.frameMs = fm;
    patch.durationMs = 0;
    if (def.loop !== false) patch.loopCount = 1; // loop 动作必须有终止条件，否则永不结束
    else if (def.loopCount !== undefined) patch.loopCount = undefined;
  }

  const afterFrameMs = patch.frameMs !== undefined ? patch.frameMs : before.frameMs;
  const afterLoopCount = 'loopCount' in patch ? patch.loopCount : before.loopCount;
  const afterDurationMs = patch.durationMs;
  let actual;
  if (afterDurationMs > 0) actual = afterDurationMs;
  else if (kind === 'external' || kind === 'drag' || kind === 'session') actual = 0; // 外部事件 / 会话驱动，不算时长
  else if (afterLoopCount) actual = frames * afterFrameMs * afterLoopCount;
  else if (def.loop === false) actual = frames * afterFrameMs;
  else actual = Infinity; // 无终止条件 = 卡死，脚本会报警

  return { kind, frames, before, patch, actual, afterFrameMs, afterLoopCount, afterDurationMs };
}

let problems = 0;
let warnings = 0;
for (const cid of IDS) {
  const chPath = join(ROOT, 'config', 'characters', `${cid}.json`);
  const acPath = join(ROOT, 'config', 'actions', `${cid}.json`);
  const ch = JSON.parse(readFileSync(chPath, 'utf8'));
  const ac = JSON.parse(readFileSync(acPath, 'utf8'));
  const actions = ac.actions || ac;
  const ic = ch.interactionDuration ?? 3000;

  console.log(`\n===== ${cid}  (interactionDuration=${ic}) =====`);
  console.log('动作'.padEnd(18), '帧'.padStart(3), '现在'.padStart(8), '→  改后'.padStart(8), ' 变更');
  for (const id of Object.keys(actions)) {
    const def = actions[id];
    const p = planAction(id, def, ch);
    const beforeActual = p.before.durationMs === 0
      ? (p.before.loopCount ? p.before.roundMs * p.before.loopCount : (def.loop === false ? p.before.roundMs : Infinity))
      : (typeof p.before.durationMs === 'number' ? p.before.durationMs : ic);
    const beforeStr = beforeActual === Infinity ? '∞' : (beforeActual === 0 ? '外部' : `${beforeActual}ms`);
    const afterStr = p.actual === Infinity ? '∞卡死' : (p.actual === 0 ? '外部' : `${p.actual}ms`);
    const changes = [];
    if (p.patch.frameMs !== undefined && p.patch.frameMs !== def.frameMs) changes.push(`frameMs ${def.frameMs}→${p.patch.frameMs}`);
    if ('loopCount' in p.patch && p.patch.loopCount !== def.loopCount) changes.push(`loopCount ${def.loopCount ?? '-'}→${p.patch.loopCount ?? '-'}`);
    if (p.patch.durationMs !== def.durationMs) changes.push(`durationMs ${def.durationMs ?? '兜底'}→${p.patch.durationMs}`);
    // 审计：过长 / 无终止条件 / 轮末对齐带来的最坏等待
    const roundMs = p.frames * p.afterFrameMs;
    const needWaitRound = p.afterDurationMs > 0 && def.loop !== false && !p.afterLoopCount;
    const worst = p.actual > 0 ? p.actual + (needWaitRound ? roundMs : 0) : 0;
    const isMove = p.kind === 'displacement';
    if (p.actual === Infinity) { changes.push('✗无终止条件'); problems++; }
    // 位移类的 durationMs 是「异常卡死兜底」，不是正常时长：够宽即可（太窄会把爬到一半的角色硬切）
    else if (isMove) {
      if (p.actual > MOVE_FALLBACK_MAX_MS) { changes.push('✗兜底过长'); problems++; }
    } else if (p.actual > 8000) { changes.push('✗过长'); problems++; }
    if (!isMove && worst > 10000) { changes.push('⚠最坏' + worst + 'ms'); warnings++; }
    console.log(id.padEnd(18), String(p.frames).padStart(3), beforeStr.padStart(8), '→', afterStr.padStart(8), ' ', changes.join(', '));

    if (APPLY) {
      if (p.patch.frameMs !== undefined) def.frameMs = p.patch.frameMs;
      if ('loopCount' in p.patch) {
        if (p.patch.loopCount === undefined) delete def.loopCount;
        else def.loopCount = p.patch.loopCount;
      }
      def.durationMs = p.patch.durationMs;
    }
  }
  // —— 屏幕时间占比审计：权重 × 时长 才是用户实际看到的比例（等权但时长差 5 倍 = 视觉上被垄断）——
  const wander = ch.wanderActions || [];
  const wanderNorm = wander.map((entry) =>
    typeof entry === 'string' ? { id: entry, weight: 1 } : { id: entry.id, weight: entry.weight ?? 1 });
  // —— walk 权重门禁：位移是骨架行为，用户要求 walk 权重占比 ≥ 50% ——
  const walkW = wanderNorm.find((e) => e.id === 'walk');
  const weightTotal = wanderNorm.reduce((s, e) => s + e.weight, 0);
  if (walkW && weightTotal > 0) {
    const wpct = (walkW.weight / weightTotal) * 100;
    if (wpct < WALK_WEIGHT_MIN_PCT) {
      console.log(`  ✗ walk 权重占比 ${wpct.toFixed(1)}%（w=${walkW.weight}/${weightTotal}）低于 ${WALK_WEIGHT_MIN_PCT}%`);
      problems++;
    } else {
      console.log(`  walk 权重占比 ${wpct.toFixed(1)}%（w=${walkW.weight}/${weightTotal}）`);
    }
  }
  const share = [];
  let total = 0;
  for (const e of wanderNorm) {
    const def = actions[e.id];
    if (!def) continue;
    const p = planAction(e.id, def, ch);
    // 位移类用典型时长（走到目标即停）而非兜底上限，否则占比会被高估一倍
    // 会话驱动（贴顶飞）用 ceilingMaxMs 的 75% 作为典型时长 —— 它不靠 durationMs，但确实占屏幕时间
    const ms = p.kind === 'displacement' ? Math.min(p.actual, TYPICAL_MOVE_MS)
      : (p.kind === 'session' ? Math.round((ch.ceilingMaxMs ?? 20000) * 0.75)
        : (p.actual === 0 ? 0 : p.actual));
    const s = e.weight * Math.min(ms, 8000);
    share.push({ id: e.id, weight: e.weight, ms, s, kind: p.kind });
    total += s;
  }
  console.log('  —— 屏幕时间占比（权重 × 时长）——');
  for (const it of share.sort((a, b) => b.s - a.s)) {
    const pct = total > 0 ? (it.s / total) * 100 : 0;
    const bar = '█'.repeat(Math.round(pct / 2));
    const limit = (it.kind === 'displacement' || it.kind === 'session')
      ? DISPLACEMENT_SHARE_MAX_PCT : STATIC_SHARE_MAX_PCT;
    const mark = pct > limit ? `  ⚠占比过高(>${limit}%)` : '';
    if (pct > limit) { problems++; }
    console.log(`  ${it.id.padEnd(18)} w=${String(it.weight).padStart(2)} ${String(it.ms).padStart(5)}ms ${pct.toFixed(1).padStart(5)}%  ${bar}${mark}`);
  }

  // —— 可达性审计：凡是被 wander 抽到、或被 next 链引用的动作，都必须真的能结束 ——
  // 对应运行时的 scheduleActionEnd：单帧 static 动作没有动画可播完，必须显式声明 durationMs，
  // 否则会永久卡住（sit 曾因 wander 路径不消费 durationMs 而长期卡坐）。运行时只有 2500ms 兜底 + warn，
  // 这里要求配置层显式给值，属于门禁而非兜底。
  const reachable = new Set(wander.map((e) => (typeof e === 'string' ? e : e.id)));
  for (const d of Object.values(actions)) {
    for (const nx of (d.next || [])) reachable.add(typeof nx === 'string' ? nx : nx.id);
  }
  for (const rid of reachable) {
    const def = actions[rid];
    if (!def) { console.log(`  ✗ wander/next 引用了不存在的动作: ${rid}`); problems++; continue; }
    if (isExternal(rid, def, ch)) continue; // 待机/下落/拖拽：由物理或用户事件收尾，不靠时长
    if (isSessionDriven(def)) continue; // 贴顶飞：由 Pet.stepFlyCeiling 的会话逻辑收尾（durationMs 必须为 0）
    const n = (def.frames || []).length;
    const selfTerm = ['walk', 'climb', 'ceiling', 'chase', 'fly', 'drag'].includes(def.behavior)
      || (n > 1 && (def.loop === false || (typeof def.loopCount === 'number' && def.loopCount > 0)));
    if (selfTerm) continue;
    if (!(typeof def.durationMs === 'number' && def.durationMs > 0)) {
      console.log(`  ✗ 可被抽到但无终止条件: ${rid}（单帧/无限循环且未声明 durationMs → 运行时永久卡住）`);
      problems++;
    }
  }

  if (APPLY) writeFileSync(acPath, JSON.stringify(ac, null, 2) + '\n', 'utf8');
}

console.log(`\n${APPLY ? '已写入' : 'DRY-RUN（加 --apply 才写入）'}；问题 ${problems} 个，警告 ${warnings} 个`);
process.exit(problems > 0 ? 1 : 0);
