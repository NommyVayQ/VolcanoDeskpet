#!/usr/bin/env node
/**
 * fix-carry-frames.mjs —— 修正「扛着窗口走路」的帧配置（2026-10-01）
 *
 * 问题：`carryWindow` 是投掷演出里的 **WalkWithIe / RunWithIe** 段 —— 角色扛着窗口
 *       **走向屏幕另一侧**（位移由 WindowInteract 驱动，动作只负责走路动画）。
 *       新源「抛掷」目录的三帧语义是：
 *          throw-1 / throw-2 = 扛着窗口的**走路循环两帧**（交替 = 走起来）
 *          throw-3           = 甩出
 *       早先 add-throw-actions 把 carryWindow 配成了单帧 throw-2 → 扛着窗口**定格不动**，
 *       看起来是"举着窗口平移"，不走。
 *
 * 修正：
 *   - 所有角色 carryWindow = [throw-1, throw-2]（左右各一套）循环播放，frameMs 走走路节奏。
 *   - nina 的 throwWindow 原本写的是 throw-1；新源同步后 throw-1 已是「扛窗走路第1帧」，
 *     甩出帧应为 throw-3 —— 一并修正（否则甩出时会突然变回扛窗姿势）。
 *   - nina 自带旧版 carry-1/2 两帧，本来就是走路循环，保持不动。
 *
 * 用法：
 *   node scripts/fix-carry-frames.mjs          # dry-run
 *   node scripts/fix-carry-frames.mjs --write  # 落盘（自动备份到 config/actions-backup-<stamp>）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACT_DIR = path.join(ROOT, 'config', 'actions');
const IMG_DIR = path.join(ROOT, 'config', 'images');
const WRITE = process.argv.includes('--write');

const IDS = ['rose', 'nina', 'rebeza', 'mona', 'gwen'];
/** 扛窗走路的帧时长：两帧一圈，比普通走路(500ms/帧 ×4)快，像扛着东西赶路。 */
const CARRY_FRAME_MS = 200;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// 键存在性校验：避免写进不存在的帧名（会导致动作加载失败/空图）
const hasKey = (id, key) => {
  const m = readJson(path.join(IMG_DIR, `${id}.json`));
  return Object.prototype.hasOwnProperty.call(m, key);
};

const acts = {};
for (const id of IDS) acts[id] = readJson(path.join(ACT_DIR, `${id}.json`));

const changes = [];

for (const id of IDS) {
  const a = acts[id].actions || {};

  // —— 1. carryWindow → 两帧走路循环 ——
  const carry = a.carryWindow;
  if (!carry) { console.log(`${id}: 无 carryWindow，跳过`); continue; }
  const L1 = 'L-throw-1', L2 = 'L-throw-2';
  const R1 = 'R-throw-1', R2 = 'R-throw-2';
  if (!hasKey(id, L1) || !hasKey(id, L2)) {
    console.log(`${id}: 缺少 ${L1}/${L2} 帧映射，跳过 carryWindow 修正`);
  } else {
    const wantL = [L1, L2];
    const wantR = (hasKey(id, R1) && hasKey(id, R2)) ? [R1, R2] : undefined;
    const curL = (carry.frames || []).map((f) => (typeof f === 'string' ? f : f.name));
    // nina 用自带的 carry-1/2（旧版走路循环），不强行改成 throw-1/2
    const isOwnCarry = curL.some((n) => /carry/i.test(n || ''));
    if (!isOwnCarry && (JSON.stringify(curL) !== JSON.stringify(wantL) || carry.frameMs !== CARRY_FRAME_MS)) {
      changes.push({ id, action: 'carryWindow', from: JSON.stringify(carry.frames) + ' fm=' + carry.frameMs, to: JSON.stringify(wantL) + ' fm=' + CARRY_FRAME_MS });
      carry.frames = wantL;
      if (wantR) carry.rightFrames = wantR;
      carry.loop = true;
      carry.frameMs = CARRY_FRAME_MS;
    }
  }

  // —— 2. throwWindow → 必须是 throw-3（甩出） ——
  const tw = a.throwWindow;
  if (tw && hasKey(id, 'L-throw-3')) {
    const curL = (tw.frames || []).map((f) => (typeof f === 'string' ? f : f.name));
    if (curL[0] !== 'L-throw-3') {
      const wantR = hasKey(id, 'R-throw-3') ? ['R-throw-3'] : undefined;
      changes.push({ id, action: 'throwWindow', from: JSON.stringify(tw.frames), to: '["L-throw-3"]' });
      tw.frames = ['L-throw-3'];
      if (wantR) tw.rightFrames = wantR;
    }
  }
}

if (changes.length === 0) {
  console.log('已是最新的两帧扛窗配置，无需改动。');
  process.exit(0);
}

for (const c of changes) console.log(`~ ${c.id}/${c.action}: ${c.from}  ->  ${c.to}`);

if (!WRITE) { console.log('\n[dry-run] 未写入。加 --write 落盘。'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(ROOT, 'config', `actions-backup-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
const touched = new Set(changes.map((c) => c.id));
for (const id of touched) fs.copyFileSync(path.join(ACT_DIR, `${id}.json`), path.join(backup, `${id}.json`));
for (const id of touched) fs.writeFileSync(path.join(ACT_DIR, `${id}.json`), JSON.stringify(acts[id], null, 2) + '\n', 'utf8');
console.log(`\n已写入 ${touched.size} 个文件；备份在 ${path.relative(ROOT, backup)}`);
