#!/usr/bin/env node
/**
 * check-pair-durations.mjs —— 只读体检：列出所有配对规则两侧的时长与补帧覆盖情况。
 *
 * 关注两点：
 *   1. 两侧总时长是否相等（不等 ⇒ 先播完的那个先切回 idle，观感断裂）。
 *   2. 做饭方的「结尾补帧」是否真的覆盖到进食方吃完（tailSup 起点 ≤ 进食方开始吃的时刻，
 *      且 tailSup 终点 ≥ 进食方结束时刻）。
 *
 * 用法： node scripts/check-pair-durations.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAR_DIR = path.join(ROOT, 'config', 'characters');
const ACT_DIR = path.join(ROOT, 'config', 'actions');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ids = fs.readdirSync(CHAR_DIR).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));

function frameMsOf(def, i, side = 'frames') {
  const arr = def[side] || [];
  const f = arr[i];
  if (f && typeof f === 'object' && typeof f.ms === 'number' && f.ms > 0) return f.ms;
  if (typeof def.frameMs === 'number' && def.frameMs > 0) return def.frameMs;
  const fps = (def.speed ?? 0.1) * 60;
  return 1000 / Math.max(1, fps);
}
const frameName = (f) => (typeof f === 'string' ? f : f?.name ?? '');
const totalMs = (def, side = 'frames') => (def[side] || []).reduce((s, _f, i) => s + frameMsOf(def, i, side), 0);
const isSup = (f) => /sup/i.test(frameName(f));

function runSup(def, fromStart, side = 'frames') {
  const arr = def[side] || [];
  const n = arr.length;
  const idx = [];
  if (fromStart) {
    for (let i = 0; i < n; i++) { if (!isSup(arr[i])) break; idx.push(i); }
  } else {
    for (let i = n - 1; i >= 0; i--) { if (!isSup(arr[i])) break; idx.unshift(i); }
  }
  if (!idx.length) return null;
  let ms = 0; for (const i of idx) ms += frameMsOf(def, i, side);
  let start = 0; for (let i = 0; i < idx[0]; i++) start += frameMsOf(def, i, side);
  return { idx, ms, start, end: start + ms };
}

const chars = {}; for (const id of ids) chars[id] = readJson(path.join(CHAR_DIR, `${id}.json`));
const acts = {}; for (const id of ids) if (fs.existsSync(path.join(ACT_DIR, `${id}.json`))) acts[id] = readJson(path.join(ACT_DIR, `${id}.json`)).actions || {};

const rules = [];
for (const a of ids) {
  for (const b of ids) {
    if (a === b) continue;
    const r = chars[a]?.meetRules?.[b];
    if (!r) continue;
    const list = Array.isArray(r.pairs) ? r.pairs : (r.pair ? [r.pair] : []);
    for (const p of list) {
      if (!p || (!p.self && !p.other)) continue;
      rules.push({ a, b, selfAct: p.self, otherAct: p.other, id: p.id });
    }
  }
}

/**
 * ⚠️ 四向检查：配对时两人面对面，**谁站左边谁用 rightFrames —— 朝向运行时动态决定**。
 *    只检查 frames 会漏掉「站左边那个提前播完」的 bug，所以必须四个时长全等：
 *        A.frames = A.rightFrames = B.frames = B.rightFrames
 */
console.log('配对时长体检（四向总时长 / 等待帧覆盖）\n');
let bad = 0;
const SIDES = ['frames', 'rightFrames'];
for (const r of rules) {
  const A = acts[r.a]?.[r.selfAct];
  const B = acts[r.b]?.[r.otherAct];
  if (!A || !B) { console.log(`✖ ${r.a}/${r.selfAct} ↔ ${r.b}/${r.otherAct}：动作缺失`); bad++; continue; }

  const all = [];
  const cells = [];
  for (const [who, def, act] of [[r.a, A, r.selfAct], [r.b, B, r.otherAct]]) {
    for (const side of SIDES) {
      if (!def[side] || !def[side].length) continue;
      const t = Math.round(totalMs(def, side));
      all.push(t);
      cells.push({ who, act, side, t });
    }
  }
  const spread = Math.max(...all) - Math.min(...all);
  const flag = spread > 60 ? '✖四向不齐' : '✔';
  if (spread > 60) bad++;

  console.log(`${flag} [${r.id ?? '-'}] ${r.a}/${r.selfAct} ↔ ${r.b}/${r.otherAct}   四向 = ${all.join(' / ')}ms   Δ=${spread}ms`);
  for (const c of cells) {
    const head = runSup(A && c.who === r.a ? A : B, true, c.side);
    const tail = runSup(A && c.who === r.a ? A : B, false, c.side);
    const bits = [];
    if (head) bits.push(`头等 ${Math.round(head.start)}~${Math.round(head.end)}ms(${head.idx.length}帧)`);
    if (tail) bits.push(`尾补 ${Math.round(tail.start)}~${Math.round(tail.end)}ms(${tail.idx.length}帧)`);
    console.log(`     ${c.who}/${c.act}[${c.side}] ${c.t}ms  ${bits.length ? bits.join('  ') : '(无 sup 帧)'}`);
  }
}
console.log(`\n共 ${rules.length} 条配对，异常 ${bad} 条`);
