#!/usr/bin/env node
/**
 * set-coop-duration.mjs —— 统一「合体（合照）动作」的演出总时长（2026-10-01）
 *
 * 为什么不能简单地把 frameMs 从 800 全局改成一个更大的数：
 *   rose/interact(rose-nina-*) 是 7 帧、nina/interact(nina-rose-*) 是 11 帧，它们是**同一对**的
 *   两套视角合照。全局固定每帧时长 → 7×1000=7000 vs 11×1000=11000，谁在屏幕左边谁就播 11 秒，
 *   两侧差 4 秒，直接违反「两个角色总时长要一样」。
 *
 * 正确做法：**统一总时长 T**，再按每套合照各自的帧数反推 frameMs = round(T / n)。
 *   - 同一对两侧帧数相同（如 rose-gwn 7 帧 / gwn-rose 7 帧）→ 反推出的 frameMs 也相同 → 天然一致。
 *   - 同一对两侧帧数不同（rose-nina 7 帧 / nina-rose 11 帧）→ 帧时长不同但**总时长相同** → 也一致。
 *
 * 分组键：从帧名提取角色对（`rose-gwn-1` → `gwn|rose`），同对两侧必然同组。
 *
 * 用法：
 *   node scripts/set-coop-duration.mjs                 # dry-run，默认 T=8000ms
 *   node scripts/set-coop-duration.mjs --total 10000   # 指定目标总时长
 *   node scripts/set-coop-duration.mjs --write         # 落盘（自动备份 config/actions-backup-<stamp>）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACT_DIR = path.join(ROOT, 'config', 'actions');
const WRITE = process.argv.includes('--write');

// 目标总时长(ms)：所有合体动作统一演这么久
let TOTAL = 8000;
const ti = process.argv.indexOf('--total');
if (ti >= 0 && process.argv[ti + 1]) TOTAL = Number(process.argv[ti + 1]);
if (!Number.isFinite(TOTAL) || TOTAL <= 0) { console.error('--total 必须是正数'); process.exit(1); }

const IDS = ['rose', 'nina', 'rebeza', 'mona', 'gwen'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const acts = {};
for (const id of IDS) acts[id] = readJson(path.join(ACT_DIR, `${id}.json`));

/** 从帧名提取「角色对」分组键：`rose-gwn-1` → `gwn|rose`；非合照命名返回 null。 */
function pairKeyOf(def) {
  const names = (def.frames || []).map((f) => (typeof f === 'string' ? f : f?.name ?? ''));
  if (names.length === 0 || !names[0]) return null;
  const m = /^(.+)-(\d+)$/.exec(names[0]);
  if (!m) return null;
  const parts = m[1].split('-');
  if (parts.length < 2) return null;
  return parts.slice().sort().join('|');
}

// 收集所有 coop 动作
const groups = new Map(); // key -> [{id, actionId, def, n}]
for (const id of IDS) {
  const a = acts[id].actions || {};
  for (const actionId of Object.keys(a)) {
    const def = a[actionId];
    if (!def || !def.coop) continue;
    const n = (def.frames || []).length;
    if (n === 0) continue;
    const key = pairKeyOf(def);
    if (!key) { console.log(`(skip) ${id}/${actionId}: 帧名不是「角色A-角色B-N」格式，无法归组`); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, actionId, def, n });
  }
}

const changes = [];
for (const [key, list] of groups) {
  for (const it of list) {
    const want = Math.max(1, Math.round(TOTAL / it.n));
    const cur = it.def.frameMs;
    if (cur === want) continue;
    changes.push({ key, ...it, from: cur, to: want, total: want * it.n });
  }
}

console.log(`合体动作组 ${groups.size} 组，目标总时长 ${TOTAL}ms`);
console.log('');
console.log('角色对'.padEnd(14) + '动作'.padEnd(24) + '帧数'.padEnd(6) + '每帧(原 → 新)'.padEnd(20) + '实际总时长');
for (const [key, list] of groups) {
  for (const it of list) {
    const want = Math.max(1, Math.round(TOTAL / it.n));
    console.log(
      key.padEnd(14)
      + `${it.id}/${it.actionId}`.padEnd(24)
      + String(it.n).padEnd(6)
      + `${it.def.frameMs} → ${want}`.padEnd(20)
      + `${want * it.n}ms`,
    );
  }
}

if (changes.length === 0) { console.log('\n已是目标时长，无需改动。'); process.exit(0); }
console.log(`\n将修改 ${changes.length} 个动作：`);
for (const c of changes) console.log(`  ~ ${c.id}/${c.actionId}: frameMs ${c.from} → ${c.to}（总 ${c.total}ms）`);

if (!WRITE) { console.log('\n[dry-run] 未写入。加 --write 落盘。'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(ROOT, 'config', `actions-backup-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
const touched = new Set(changes.map((c) => c.id));
for (const id of touched) fs.copyFileSync(path.join(ACT_DIR, `${id}.json`), path.join(backup, `${id}.json`));
for (const c of changes) c.def.frameMs = c.to;
for (const id of touched) fs.writeFileSync(path.join(ACT_DIR, `${id}.json`), JSON.stringify(acts[id], null, 2) + '\n', 'utf8');
console.log(`\n已写入 ${touched.size} 个文件；备份在 ${path.relative(ROOT, backup)}`);
