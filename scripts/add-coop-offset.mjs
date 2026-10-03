#!/usr/bin/env node
/**
 * 给所有 coop（合体帧）动作补上 `offset.x`，让合体帧与真实两人位置对齐。
 *
 * 背景（2026-10-02 修「合体进出位置偏差」）：
 *   合体帧（221 宽、内含两人）把两个角色压在画布中心 ±~52px（内部间距约 104px）。
 *   maintainCoopSnap 现在把两个真实角色也摆到 midX±52，但若合体帧不做偏移，它的「左角色」
 *   会比 lead 真实中心偏左 52px、右角色比 other 偏左 52px → 进出合体都 pop。
 *   给合体动作加 `offset.x:52`，把整张合体帧右移 52px，使其左角色正好压在 lead 真实中心、
 *   右角色正好压在 other 真实中心（对齐「吃奶冻」cookIce/eatFromMona 的丝滑进出）。
 *
 * 幂等：已存在 offset.x===52 的跳过；已有 offset 则合并保留 y 只改 x。
 *
 * 用法：
 *   node scripts/add-coop-offset.mjs          # dry-run
 *   node scripts/add-coop-offset.mjs --write # 落盘（自动备份 config/actions-backup-<stamp>）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACT_DIR = path.join(ROOT, 'config', 'actions');
const WRITE = process.argv.includes('--write');
const COOP_OFFSET_X = 52;

const files = readdirSync(ACT_DIR).filter((f) => f.endsWith('.json')).sort();
const touched = new Set();
const logs = [];

for (const file of files) {
  const p = path.join(ACT_DIR, file);
  const charId = path.basename(file, '.json');
  const raw = readFileSync(p, 'utf8');
  const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
  let dirty = false;

  for (const [actId, def] of Object.entries(json.actions || {})) {
    if (!def || def.coop !== true) continue;
    const off = def.offset && typeof def.offset === 'object' ? { ...def.offset } : {};
    if (off.x === COOP_OFFSET_X) continue; // 已是目标值，幂等跳过
    off.x = COOP_OFFSET_X;
    def.offset = off;
    logs.push(`  ${charId}/${actId}：offset.x → ${COOP_OFFSET_X}` + (def.offset.y !== undefined ? `（保留 y:${def.offset.y}）` : ''));
    dirty = true;
  }

  if (dirty && WRITE) {
    // 维持原文末换行 + 2 空格缩进（与 format-actions 一致）
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
    touched.add(charId);
  } else if (dirty) {
    touched.add(charId);
  }
}

if (!logs.length) {
  console.log('无需改动：所有 coop 动作已含 offset.x=' + COOP_OFFSET_X + '。');
} else {
  console.log(`${WRITE ? '已写入' : '将改动'} ${touched.size} 个文件、${logs.length} 个 coop 动作：\n`);
  for (const l of logs) console.log(l);
}

if (WRITE && touched.size) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = path.join(ROOT, 'config', `actions-backup-${stamp}`);
  mkdirSync(backup, { recursive: true });
  for (const id of touched) copyFileSync(path.join(ACT_DIR, `${id}.json`), path.join(backup, `${id}.json`));
  console.log(`\n备份在 ${path.relative(ROOT, backup)}`);
  console.log('提示：改完请跑 scripts/format-actions.mjs --write 统一格式。');
} else if (!WRITE && touched.size) {
  console.log('\n（dry-run，未落盘；加 --write 生效）');
}
