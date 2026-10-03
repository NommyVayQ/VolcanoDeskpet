#!/usr/bin/env node
/**
 * ⛔️【已废弃 · 请勿再运行】2026-10-02
 *   职责已被两个脚本接管，本脚本的「按帧数均分、每张各定格一大段」做法与当前表现冲突：
 *     · 补帧段要做「多张交替轮播」→ 用 `scripts/loop-sup-frames.mjs`
 *     · 补帧段总时长要对齐配对双方 → 用 `scripts/sync-pair-durations.mjs`
 *   危害：本脚本把 SUP_TOTAL_MS 硬编码 5500，而 rebeza 那套实际需要 6000，
 *   一旦 `--write` 会把它 24 帧交替（250ms）压成 24 × 229ms，整段错乱。
 *   （rose/nina 因「总时长恰为 5500」会被幂等闸跳过，不受影响，但仍不建议跑。）
 *   保留文件仅为留档；确认无用后可直接删除。
 *
 * ---------------------------------------------------------------------------
 * 重设「吃的一方」合体动作（`eatFromMona`）里补帧(sup)的时长。
 *
 * 背景（2026-10-01 用户定的语义）：
 *   合体演出的时序是 **mona 做饭 → 做到「拿出食物」那一帧 → 对方才开始吃**。
 *   mona 侧 cookXxx 的「拿出食物」帧是 `-4`（如 L-milk-4 / L-bread-4 / L-ice-4 / L-meat-4），
 *   实测该帧结束于 5500ms（wine 那道是 6000ms）。
 *   所以对方补帧(sup)的作用就是「**撑到 mona 拿出食物为止**」，之后才播吃的帧。
 *
 * 修前的问题：对方 sup 只有 2400ms → 对方在 t=2400 就开吃，比 mona 拿出食物（5500ms）
 *   早了约 3.1 秒，观感是「食物还没拿出来就开始吃」。
 *
 * 本脚本把对方 sup 的**总时长**设为 SUP_TOTAL_MS（5500ms），按可用帧数均分：
 *   rose / nina / rebeza 各 2 张 sup → 每张 2750ms
 *   gwen 只有 1 张 sup → 单张 5500ms
 *
 * 只动 `eatFromMona`（合体专用）；独处的 `eat` 没有补帧，不受影响。
 *
 * 幂等：已符合目标时长则跳过。dry-run 默认，`--write` 落盘。
 *
 * 用法：
 *   node scripts/retune-pair-sup.mjs          # 预演
 *   node scripts/retune-pair-sup.mjs --write  # 落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ACTIONS_DIR = path.join(ROOT, 'config', 'actions');
const WRITE = process.argv.includes('--write');

/** 补帧段的目标总时长(ms)：= mona cook 动作「拿出食物」帧(-4)结束的时刻。 */
const SUP_TOTAL_MS = 5500;

/** 吃的一方（mona 只做饭，不参与）。 */
const EATERS = ['rose', 'nina', 'rebeza', 'gwen'];
const ACTION_ID = 'eatFromMona';

const nameOf = (f) => (typeof f === 'string' ? f : f?.name);
const isSup = (f) => {
  const n = nameOf(f);
  return typeof n === 'string' && /(^|-)sup-\d+$/.test(n);
};

for (const fid of EATERS) {
  const p = path.join(ACTIONS_DIR, `${fid}.json`);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const acts = doc.actions ?? doc;
  const a = acts[ACTION_ID];
  if (!a) { console.log(`  · ${fid}: 无 ${ACTION_ID}，跳过`); continue; }

  const idx = (a.frames || []).map(isSup);
  const nSup = idx.filter(Boolean).length;
  if (nSup === 0) { console.log(`  · ${fid}: ${ACTION_ID} 无补帧，跳过`); continue; }

  const each = Math.round(SUP_TOTAL_MS / nSup);

  /** 把帧数组里的补帧重写成 { name, ms } 形式（其余帧原样保留）。 */
  const retune = (frames) => (frames || []).map((f) => {
    if (!isSup(f)) return f;
    return { name: nameOf(f), ms: each };
  });

  const nextFrames = retune(a.frames);
  const nextRight = a.rightFrames ? retune(a.rightFrames) : undefined;

  const before = (a.frames || []).filter(isSup)
    .map((f) => (typeof f === 'string' ? a.frameMs : f.ms)).reduce((s, v) => s + (v || 0), 0);

  const same = JSON.stringify(a.frames) === JSON.stringify(nextFrames)
    && JSON.stringify(a.rightFrames ?? null) === JSON.stringify(nextRight ?? null);

  if (same || before === SUP_TOTAL_MS) {
    console.log(`  = ${fid}/${ACTION_ID}: 补帧已为 ${SUP_TOTAL_MS}ms（${nSup} 张 × ${each}ms），无需改动`);
    continue;
  }

  a.frames = nextFrames;
  if (nextRight !== undefined) a.rightFrames = nextRight;
  // 补帧现在都显式写了 ms，frameMs 只作用于非补帧；保留原值不动。
  console.log(`  ~ ${fid}/${ACTION_ID}: 补帧 ${before}ms → ${SUP_TOTAL_MS}ms（${nSup} 张 × ${each}ms）`);

  if (WRITE) fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

console.log((WRITE ? '[write] ' : '[dry-run] ') + 'retune-pair-sup  (目标 ' + SUP_TOTAL_MS + 'ms)');
if (!WRITE) console.log('\n（预演完成，加 --write 落盘）');
