#!/usr/bin/env node
/**
 * 把「等待补帧(sup)」从「每张各定格一大段」改成「多张交替轮播、**段总时长不变**」。
 *
 * 背景（2026-10-02 用户）：
 *   rose / nina / rebeza 的 `eatFromMona` 头补是 **2 张** sup（L-sup-1 / L-sup-2）。
 *   早先为了让补帧「撑到莫娜拿出食物」，按帧数把总时长均分 → 每张定格 2750ms(rose/nina)
 *   / 3000ms(rebeza)，观感是「一张图僵在那里将近 3 秒」。
 *   用户要求：两张 **交替播放** 直到补帧段结束（rose/nina 5500ms、rebeza 6000ms）。
 *
 * 做法：
 *   把「开头/结尾连续 sup 段」按「动作级 frameMs（正常帧长）」交替展开（1,2,1,2,...），**总时长严格不变**。
 *   例：rose frameMs=650 → 5500ms / 650 ≈ 8 帧交替（每段 ~688ms）；nina frameMs=800 → 7200/800≈9~10 帧。
 *   展开后每帧写 `{ name, ms }`（ms 按节奏算，必须显式写）。
 *
 * ⚠️ 节奏基准（2026-10-02 用户补：「交替的节奏和正常帧长一致就行」）：
 *   默认用动作级 `frameMs`（rose 650 / nina 800 / rebeza 650），不再是写死的 250ms；
 *   可用 `--cycle <ms>` 强制覆盖（调试用）。frameMs 缺失时退回 250 兜底。
 *
 * 幂等：
 *   段已等于「目标展开（同名交替 + 同 ms）」则跳过；否则用当前段总时长重算展开并替换。
 *   因此即使段已被旧版 250ms 展开过，重跑本脚本也会改写成 frameMs 节奏，且再跑不再变。
 *
 * 只处理「连续 sup 段里唯一帧名 ≥ 2」的情况 —— mona / gwen 各只有 1 张 sup（`L-sup-1`），
 * 天然是单帧定格，本脚本不动它们。
 *
 * 与 `sync-pair-durations.mjs` 兼容：后者只「把目标总时长均分到段内各帧」，
 * 展开后四向仍 Δ=0；本脚本只改 sup 段内部的帧数与节奏、不动段总时长，两者互不打架。
 * 但**不要再跑 `retune-pair-sup.mjs`**（那个会按帧数重建 sup 段、把交替打回「每张一大段」）。
 *
 * 用法：
 *   node scripts/loop-sup-frames.mjs                # dry-run，只打印将要改什么
 *   node scripts/loop-sup-frames.mjs --write        # 落盘（自动备份 config/actions-backup-<stamp>）
 *   node scripts/loop-sup-frames.mjs --cycle 400    # 强制每帧停留 400ms（覆盖动作级 frameMs）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACT_DIR = path.join(ROOT, 'config', 'actions');
const WRITE = process.argv.includes('--write');
const cycleArg = process.argv.indexOf('--cycle');
const CYCLE_OVERRIDE = cycleArg >= 0 ? Math.max(50, Number(process.argv[cycleArg + 1]) || 250) : null;
const charArg = process.argv.indexOf('--char');
const CHAR_FILTER = charArg >= 0 ? (process.argv[charArg + 1] || '') : null;

const nameOf = (f) => (typeof f === 'string' ? f : (f?.name ?? ''));
const isSup = (f) => /sup/i.test(nameOf(f));

/** 帧时长：帧对象 ms 优先，否则动作级 frameMs，否则 speed 反推（与 Pet.perFrameMs 同口径）。 */
function frameMsOf(def, arr, i) {
  const f = arr[i];
  if (f && typeof f === 'object' && typeof f.ms === 'number' && f.ms > 0) return f.ms;
  if (typeof def.frameMs === 'number' && def.frameMs > 0) return def.frameMs;
  return 1000 / Math.max(1, (def.speed ?? 0.1) * 60);
}

/** 开头(fromStart) / 结尾(!fromStart) 连续 sup 帧的下标。 */
function supRun(arr, fromStart) {
  const idx = [];
  const n = arr.length;
  if (fromStart) {
    for (let i = 0; i < n; i++) { if (!isSup(arr[i])) break; idx.push(i); }
  } else {
    for (let i = n - 1; i >= 0; i--) { if (!isSup(arr[i])) break; idx.unshift(i); }
  }
  return idx;
}

/**
 * 把 names 交替铺满 totalMs，返回帧数组；总时长严格 = totalMs（累积取整，零漂移）。
 * 帧数取 round(totalMs / cycleMs)，使每帧停留 ≈ 动作级 frameMs（节奏与正常帧长一致），
 * 名称按 1,2,1,2,... 循环（1 张多/少时视觉无感）。
 */
function expand(names, totalMs, cycleMs) {
  const count = Math.max(names.length, Math.round(totalMs / cycleMs));
  const out = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const target = Math.round((totalMs * (i + 1)) / count);
    out.push({ name: names[i % names.length], ms: target - acc });
    acc = target;
  }
  return out;
}

const files = readdirSync(ACT_DIR).filter((f) => f.endsWith('.json')).sort();
const touched = new Set();
const logs = [];

for (const file of files) {
  const charId = path.basename(file, '.json');
  if (CHAR_FILTER && charId !== CHAR_FILTER) continue; // --char 只处理指定角色
  const p = path.join(ACT_DIR, file);
  const raw = readFileSync(p, 'utf8');
  const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
  let dirty = false;

  for (const [actId, def] of Object.entries(json.actions || {})) {
    // 交替节奏基准：--cycle 优先，否则动作级 frameMs，缺失退回 250。
    const baseCycle = CYCLE_OVERRIDE ?? (typeof def.frameMs === 'number' && def.frameMs > 0 ? def.frameMs : 250);
    for (const side of ['frames', 'rightFrames']) {
      const arr = def[side];
      if (!Array.isArray(arr) || arr.length < 2) continue;

      const head = supRun(arr, true);
      const tail = supRun(arr, false);
      // 整段全是 sup 时，head 与 tail 指向同一段 —— 只处理一次
      const wholeIsSup = head.length > 0 && head.length === arr.length;
      const targets = wholeIsSup ? [['全段', head]] : [['尾补', tail], ['头补', head]];

      for (const [tag, idx] of targets) {
        if (idx.length < 2) continue;
        const names = idx.map((i) => nameOf(arr[i]));
        const uniq = [...new Set(names)];
        if (uniq.length < 2) continue;              // 只有 1 张 sup（mona/gwen）→ 单帧定格，不动

        const totalMs = Math.round(idx.reduce((s, i) => s + frameMsOf(def, arr, i), 0));
        const expanded = expand(uniq, totalMs, baseCycle);
        // 幂等：当前段已等于「目标展开（同名交替 + 同 ms）」则跳过（支持把旧 250ms 节奏改写成 frameMs 节奏后稳定）
        let same = idx.length === expanded.length;
        if (same) {
          for (let k = 0; k < idx.length; k++) {
            if (nameOf(arr[idx[k]]) !== expanded[k].name
              || Math.abs(frameMsOf(def, arr, idx[k]) - expanded[k].ms) >= 1) { same = false; break; }
          }
        }
        if (same) continue;

        const avg = Math.round(totalMs / expanded.length);
        logs.push(`  ${charId}/${actId} [${side}] ${tag}：${uniq.join(',')} `
          + `(${idx.length} 帧/${totalMs}ms) → 交替 ${expanded.length} 帧 × ~${avg}ms（节奏 ${baseCycle}ms）= ${totalMs}ms`);
        arr.splice(idx[0], idx.length, ...expanded);
        dirty = true;
      }
    }
  }

  if (dirty && WRITE) {
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
    touched.add(charId);
  } else if (dirty) {
    touched.add(charId);
  }
}

// —— 输出 ——
if (!logs.length) {
  console.log('无需改动：没有「多张 sup 各自定格」的补帧段（可能已按 frameMs 节奏交替，或只有单张 sup）。');
} else {
  console.log(`${WRITE ? '已写入' : '将改动'} ${touched.size} 个文件、${logs.length} 处 sup 段：\n`);
  for (const l of logs) console.log(l);
}

if (WRITE && touched.size) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = path.join(ROOT, 'config', `actions-backup-${stamp}`);
  mkdirSync(backup, { recursive: true });
  for (const id of touched) copyFileSync(path.join(ACT_DIR, `${id}.json`), path.join(backup, `${id}.json`));
  console.log(`\n备份在 ${path.relative(ROOT, backup)}`);
  console.log('提示：改完请跑 scripts/format-actions.mjs --write 统一格式，再跑 scripts/check-pair-durations.mjs 确认四向仍对齐。');
} else if (!WRITE && touched.size) {
  console.log('\n（dry-run，未落盘；加 --write 生效）');
}
