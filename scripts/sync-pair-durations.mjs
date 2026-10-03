#!/usr/bin/env node
/**
 * sync-pair-durations.mjs —— 把「配对动作」两侧的时长**四向**对齐（2026-10-01）
 *
 * 背景（用户诉求）：
 *   1. 「两个角色总时长要一样」——配对时两人必须**同时开始、同时结束**，
 *      否则先播完的那个会先切回 idle，另一方还在原地吃/做，观感断裂。
 *   2. 「莫娜的补帧就是干这个的，看着对方吃完」——莫娜做饭动作末端的 `L-sup-*`
 *      就是「端着食物看对方吃」的等待帧；对方吃饭动作开头的 `L-sup-*` 是
 *      「等莫娜把食物拿出来」的等待帧。两段等待帧的长度必须由数据算出来，不能拍脑袋。
 *
 * 数据模型（约定）：
 *   做饭方（mona cookX）  = [准备帧…, 拿出食物帧(-4), 尾巴等待帧(sup)]     ↑尾巴 = 看对方吃
 *   进食方（X eatFromMona）= [开头等待帧(sup)…, 吃饭帧…]                   ↑开头 = 等食物拿出来
 *
 * 对齐公式（设做饭方 A、进食方 B）：
 *   revealA = total(A) - tailSup(A)          // A 拿出食物的时刻
 *   eatB    = total(B) - headSup(B)          // B 真正吃饭的时长
 *   令 tailSup(A) = eatB、headSup(B) = revealA
 *   ⇒ total(A) = total(B) = revealA + eatB = T
 *
 * ⚠️ 必须「四向对齐」：
 *   配对时两人面对面，**谁站左边谁用 rightFrames —— 朝向是运行时动态决定的**。
 *   只对齐 frames 会让「站左边的那个」用 rightFrames 提前播完，观感就是
 *   「莫娜补帧还没等对方吃完就先走了」（mona 四个做饭动作的 rightFrames 尾补
 *   还是老值 2400ms，比 frames 短 1600~5600ms）。所以四个时长必须全部相等：
 *       A.frames = A.rightFrames = B.frames = B.rightFrames = T
 *
 * 只动 sup 帧的 ms；拿不到 sup 帧（如合照类 coop 动作）就跳过并提示，
 * 绝不把「吃饭帧/合照帧」拉长（那样会变成定格卡帧）。
 *
 * 用法：
 *   node scripts/sync-pair-durations.mjs          # dry-run，只打印将要改什么
 *   node scripts/sync-pair-durations.mjs --write  # 落盘（自动备份到 config/actions-backup-<stamp>）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAR_DIR = path.join(ROOT, 'config', 'characters');
const ACT_DIR = path.join(ROOT, 'config', 'actions');

const WRITE = process.argv.includes('--write');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ids = fs.readdirSync(CHAR_DIR).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));

/** 帧时长：帧对象自带 ms 优先，否则动作级 frameMs，否则 speed 反推（与 Pet.perFrameMs 同口径）。 */
function frameMsOf(def, i, side = 'frames') {
  const f = (def[side] || [])[i];
  if (f && typeof f === 'object' && typeof f.ms === 'number' && f.ms > 0) return f.ms;
  if (typeof def.frameMs === 'number' && def.frameMs > 0) return def.frameMs;
  const fps = (def.speed ?? 0.1) * 60;
  return 1000 / Math.max(1, fps);
}
const frameName = (f) => (typeof f === 'string' ? f : f?.name ?? '');
const totalMs = (def, side = 'frames') => (def[side] || []).reduce((s, _f, i) => s + frameMsOf(def, i, side), 0);
const isSup = (f) => /sup/i.test(frameName(f));
/** 某动作在某侧的总时长（无该侧帧时返回 null）。 */
const sideMs = (def, side) => (def[side] && def[side].length ? totalMs(def, side) : null);

/** 开头连续的 sup 帧下标（等待帧必须在最前才认）。 */
function headSupIdx(def, side = 'frames') {
  const arr = def[side] || [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (!isSup(arr[i])) break;
    out.push(i);
  }
  return out;
}
/** 结尾连续的 sup 帧下标。 */
function tailSupIdx(def, side = 'frames') {
  const arr = def[side] || [];
  const out = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!isSup(arr[i])) break;
    out.unshift(i);
  }
  return out;
}
/** 若干帧的已有 ms 之和。 */
const sumMs = (def, idxList, side = 'frames') => idxList.reduce((s, i) => s + frameMsOf(def, i, side), 0);
/** 把若干帧的 ms 均分到 target（保持它们是 sup 帧，不做别的改动）。 */
function setFramesMs(def, idxList, target, side = 'frames') {
  const per = Math.max(1, Math.round(target / idxList.length));
  for (const i of idxList) {
    const f = def[side][i];
    def[side][i] = { name: frameName(f), ms: per };
  }
  return per * idxList.length;
}

const SIDES = ['frames', 'rightFrames'];

// —— 收集所有配对规则（含旧式单 pair）——
const chars = {};
for (const id of ids) chars[id] = readJson(path.join(CHAR_DIR, `${id}.json`));
const acts = {};
for (const id of ids) if (fs.existsSync(path.join(ACT_DIR, `${id}.json`))) acts[id] = readJson(path.join(ACT_DIR, `${id}.json`)).actions || {};

const rules = []; // {a, b, owner, other, selfAct, otherAct, id}
for (let i = 0; i < ids.length; i++) {
  for (let j = 0; j < ids.length; j++) {
    if (i === j) continue;
    const a = ids[i], b = ids[j];
    const r = chars[a]?.meetRules?.[b];
    if (!r) continue;
    const list = Array.isArray(r.pairs) ? r.pairs : (r.pair ? [r.pair] : []);
    for (const p of list) {
      if (!p || (!p.self && !p.other)) continue;
      rules.push({ a, b, owner: a, other: b, selfAct: p.self, otherAct: p.other, id: p.id });
    }
  }
}

const changes = [];   // {rule, cook, eater, T, sides:[{char, act, def, side, idx, from, to}]}
const skipped = [];

for (const r of rules) {
  const selfDef = acts[r.owner]?.[r.selfAct];
  const otherDef = acts[r.other]?.[r.otherAct];
  if (!selfDef || !otherDef) { skipped.push(`${r.owner}/${r.selfAct} ↔ ${r.other}/${r.otherAct}：动作不存在`); continue; }

  // —— 定角色：做饭方 = 有「结尾补帧」的那个；进食方 = 有「开头等待帧」的那个 ——
  let cook = null, eater = null;
  if (tailSupIdx(selfDef, 'frames').length > 0 && headSupIdx(otherDef, 'frames').length > 0) {
    cook = { char: r.owner, act: r.selfAct, def: selfDef };
    eater = { char: r.other, act: r.otherAct, def: otherDef };
  } else if (tailSupIdx(otherDef, 'frames').length > 0 && headSupIdx(selfDef, 'frames').length > 0) {
    cook = { char: r.other, act: r.otherAct, def: otherDef };
    eater = { char: r.owner, act: r.selfAct, def: selfDef };
  } else {
    // 无 sup 帧（合照类 coop 动作）：只检查四向是否本来就一致，不一致就告警
    const all = [];
    for (const side of SIDES) {
      const a = sideMs(selfDef, side), b = sideMs(otherDef, side);
      if (a !== null) all.push(a);
      if (b !== null) all.push(b);
    }
    const spread = Math.max(...all) - Math.min(...all);
    if (spread > 1) skipped.push(`${r.owner}/${r.selfAct} ↔ ${r.other}/${r.otherAct}：无 sup 等待帧，但四向时长差 ${Math.round(spread)}ms，需手工对齐`);
    continue;
  }

  // —— 基准（用 frames 侧算）：reveal = 拿出食物的时刻，eat = 进食方真正吃饭的时长 ——
  const cookTailL = tailSupIdx(cook.def, 'frames');
  const eaterHeadL = headSupIdx(eater.def, 'frames');
  const reveal = totalMs(cook.def, 'frames') - sumMs(cook.def, cookTailL, 'frames');
  const eat = totalMs(eater.def, 'frames') - sumMs(eater.def, eaterHeadL, 'frames');
  const T = reveal + eat; // 四向共同的总时长

  const sides = [];
  let bad = false;
  for (const side of SIDES) {
    // 做饭方：把该侧「结尾补帧」拉到 T（补帧终点 = 对方吃完 = 动作结束）
    if (cook.def[side] && cook.def[side].length) {
      const idx = tailSupIdx(cook.def, side);
      const rest = totalMs(cook.def, side) - sumMs(cook.def, idx, side);
      const target = T - rest;
      const cur = sumMs(cook.def, idx, side);
      if (!idx.length) { bad = true; skipped.push(`${cook.char}/${cook.act}[${side}]：找不到结尾补帧`); continue; }
      if (target <= 0) { bad = true; skipped.push(`${cook.char}/${cook.act}[${side}]：非补帧部分已 ${Math.round(rest)}ms ≥ 目标 ${Math.round(T)}ms`); continue; }
      if (Math.abs(cur - target) > 1) sides.push({ char: cook.char, act: cook.act, def: cook.def, side, idx, from: cur, to: target, tag: '尾补' });
    }
    // 进食方：把该侧「开头等待帧」拉到 T
    if (eater.def[side] && eater.def[side].length) {
      const idx = headSupIdx(eater.def, side);
      const rest = totalMs(eater.def, side) - sumMs(eater.def, idx, side);
      const target = T - rest;
      const cur = sumMs(eater.def, idx, side);
      if (!idx.length) { bad = true; skipped.push(`${eater.char}/${eater.act}[${side}]：找不到开头等待帧`); continue; }
      if (target <= 0) { bad = true; skipped.push(`${eater.char}/${eater.act}[${side}]：非等待部分已 ${Math.round(rest)}ms ≥ 目标 ${Math.round(T)}ms`); continue; }
      if (Math.abs(cur - target) > 1) sides.push({ char: eater.char, act: eater.act, def: eater.def, side, idx, from: cur, to: target, tag: '头等' });
    }
  }
  if (bad) continue;
  if (!sides.length) continue; // 四向已全部等于 T
  changes.push({ rule: r, cook, eater, reveal, eat, T, sides });
}

// —— 输出 ——
console.log(`配对规则 ${rules.length} 条，需对齐 ${changes.length} 条`);
for (const c of changes) {
  console.log(`\n[${c.rule.id ?? '(无 id)'}] ${c.rule.owner}/${c.rule.selfAct} ↔ ${c.rule.other}/${c.rule.otherAct}`);
  console.log(`  做饭 ${c.cook.char}/${c.cook.act} 拿出食物 @${Math.round(c.reveal)}ms；`
    + `进食 ${c.eater.char}/${c.eater.act} 吃饭 ${Math.round(c.eat)}ms → T=${Math.round(c.T)}ms`);
  for (const s of c.sides) {
    console.log(`  ~ ${s.char}/${s.act}[${s.side}] ${s.tag} ${s.idx.length} 帧  ${Math.round(s.from)}ms → ${Math.round(s.to)}ms`);
  }
}
for (const s of skipped) console.log(`\n  (skip) ${s}`);

if (!WRITE) {
  console.log('\n[dry-run] 未写入。加 --write 落盘。');
  process.exit(0);
}

// —— 落盘（带备份）——
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(ROOT, 'config', `actions-backup-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
const touched = new Set();
for (const c of changes) for (const s of c.sides) touched.add(s.char);
for (const id of touched) {
  const src = path.join(ACT_DIR, `${id}.json`);
  fs.copyFileSync(src, path.join(backup, `${id}.json`));
}

for (const c of changes) {
  for (const s of c.sides) {
    const real = setFramesMs(s.def, s.idx, s.to, s.side);
    console.log(`  ✔ ${s.char}/${s.act}[${s.side}] ${s.tag} → ${real}ms`);
  }
}

for (const id of touched) {
  const p = path.join(ACT_DIR, `${id}.json`);
  const raw = readJson(p);
  raw.actions = acts[id];
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}
console.log(`\n已写入 ${touched.size} 个动作文件；备份在 ${path.relative(ROOT, backup)}`);
