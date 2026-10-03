#!/usr/bin/env node
/**
 * 把「吃」动作一分为二：独处吃的 `eat`（无补帧） + 合体吃的 `eatFromMona`（带补帧）。
 *
 * 背景（2026-10-01 用户提出）：
 *   `eat` 一个动作同时被三处引用 ——
 *     1) 右键菜单「吃东西」（menu:true）
 *     2) 漫步随机（characters/*.json 的 wanderActions 权重）
 *     3) mona 合体配对里对方演的动作（mona.meetRules 的 other:"eat"）
 *   之前为了「莫娜递吃的 → 对方接过来」的过渡，把补帧(sup)插进了 eat 头部，
 *   结果 1)2) 两个独处场景也会凭空先播一个「接过来」的动作，语义不通。
 *
 * 本脚本做的事（纯数据，不改代码）：
 *   1. 把 eat 里的 sup 帧摘出来 → eat 恢复纯净（菜单/漫步用）；
 *   2. 新增 eatFromMona = sup + eat 帧，menu:false（不进菜单，只由合体配对调用）；
 *   3. mona.meetRules 里四条吃饭配对的 other:"eat" → other:"eatFromMona"。
 *
 * ⚠️ 关键安全点：菜单里「和莫娜一起吃」「做面包给露丝吃」这类入口用的是 `pairId`，
 *    而 pairId 按 meetRules 里配对的 **id 字段**匹配（app.ts: list.find(p => p.id === pairId)），
 *    不是按动作 id 匹配。所以这里只改 `other`、**保留 `id:"eat"` 不动**，菜单入口不会断链。
 *
 * 幂等：已拆分的角色（eat 无 sup 且 eatFromMona 已存在且帧一致）不再产生 diff。
 *       dry-run 默认，`--write` 落盘。
 *
 * ⚠️ 不要再跑 scripts/apply-sup-transitions.mjs —— 它会把 sup 重新插回 eat，与本脚本互为反向操作。
 *
 * 用法：
 *   node scripts/split-eat-pair.mjs          # 预演
 *   node scripts/split-eat-pair.mjs --write  # 落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ACTIONS_DIR = path.join(ROOT, 'config', 'actions');
const CHARS_DIR = path.join(ROOT, 'config', 'characters');
const WRITE = process.argv.includes('--write');

/** 需要拆分的角色：都是 mona 的「吃饭」配对对方（mona 自己只做饭，不参与）。 */
const EATERS = ['rose', 'nina', 'rebeza', 'gwen'];
const PAIR_ID = 'eat';        // meetRules 里配对的 id（保持不变，菜单 pairId 靠它匹配）
const NEW_ACTION = 'eatFromMona';

/** 帧名是否补帧（L/R-sup-N）。帧可能是字符串或 {name, ms} 对象。 */
const isSup = (f) => {
  const n = typeof f === 'string' ? f : f?.name;
  return typeof n === 'string' && /(^|-)sup-\d+$/.test(n);
};
const nameOf = (f) => (typeof f === 'string' ? f : f?.name);

const log = [];
const changed = [];

for (const fid of EATERS) {
  const p = path.join(ACTIONS_DIR, `${fid}.json`);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const acts = doc.actions ?? doc;
  const eat = acts.eat;
  if (!eat) { log.push(`${fid}: 无 eat 动作，跳过`); continue; }

  const supFrames = eat.frames.filter(isSup);
  const plainFrames = eat.frames.filter((f) => !isSup(f));
  const supR = (eat.rightFrames || []).filter(isSup);
  const plainR = (eat.rightFrames || []).filter((f) => !isSup(f));

  // ⚠️ 已拆分态（eat 里没补帧了）必须直接跳过 —— 补帧已被摘到 eatFromMona 里，
  //    此时若还按「supFrames=[] + plainFrames」重算 pairEat，会把 eatFromMona 的补帧抹掉
  //    （幂等 bug：第二跑 --write 就丢补帧）。补帧只能从 eat 首次摘取，不可二次推导。
  if (supFrames.length === 0) {
    if (acts[NEW_ACTION]) { log.push(`${fid}: 已拆分（eat 无补帧 + ${NEW_ACTION} 已存在），无需改动`); continue; }
    log.push(`${fid}: ⚠️ eat 无补帧且缺 ${NEW_ACTION}，补帧已无从还原，跳过（请从备份/重跑 apply-sup-transitions 恢复）`);
    continue;
  }

  // 1) eat 恢复纯净（只保留非补帧；其余字段原样）
  const cleanEat = { ...eat, frames: plainFrames, rightFrames: plainR };
  // 2) 合体版 = 补帧 + 原帧，不进菜单
  const pairEat = {
    ...eat,
    frames: [...supFrames, ...plainFrames],
    rightFrames: [...supR, ...plainR],
    menu: false,
    label: '吃莫娜做的（合体）',
  };
  // 菜单/漫步用的 eat 不该带合体语义标签，保持原 label
  delete pairEat.menuGroup;

  const diffs = [];
  if (JSON.stringify(eat) !== JSON.stringify(cleanEat)) diffs.push(`eat: -${supFrames.length} 补帧`);
  if (!acts[NEW_ACTION]) diffs.push(`+ ${NEW_ACTION}`);
  else if (JSON.stringify(acts[NEW_ACTION]) !== JSON.stringify(pairEat)) diffs.push(`~ ${NEW_ACTION}`);

  if (diffs.length === 0) { log.push(`${fid}: 已拆分，无需改动`); continue; }

  acts.eat = cleanEat;
  acts[NEW_ACTION] = pairEat;
  changed.push(`${fid}: ${diffs.join(' / ')}`);

  if (WRITE) fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

// ---- mona 的 meetRules：吃饭配对的 other 指向合体版（只动 id==='eat' 那条，sing 等不动）----
const monaPath = path.join(CHARS_DIR, 'mona.json');
const mona = JSON.parse(fs.readFileSync(monaPath, 'utf8'));
const mr = mona.meetRules || {};
let mrDiff = 0;

for (const otherId of Object.keys(mr)) {
  const rule = mr[otherId];
  if (!rule || typeof rule !== 'object') continue;

  // 归一化成数组统一处理：pairs 数组 / 单 pair 对象（向后兼容）
  const list = Array.isArray(rule.pairs) ? rule.pairs
    : rule.pair ? [rule.pair] : [];

  for (const pair of list) {
    // 只改「吃饭」这条：有 id 时必须等于 'eat'；无 id 的单 pair 用 other==='eat' 判定
    const isEatPair = pair.id ? pair.id === PAIR_ID : pair.other === PAIR_ID;
    if (!isEatPair || pair.other !== PAIR_ID) continue;
    if (EATERS.includes(otherId)) {
      pair.other = NEW_ACTION;
      mrDiff++;
    }
  }
}

if (mrDiff > 0) {
  changed.push(`mona/meetRules: ${mrDiff} 条配对的 other → ${NEW_ACTION}`);
  if (WRITE) fs.writeFileSync(monaPath, JSON.stringify(mona, null, 2) + '\n', 'utf8');
} else {
  log.push('mona/meetRules: 已指向 ' + NEW_ACTION + '，无需改动');
}

console.log((WRITE ? '[write] ' : '[dry-run] ') + 'split-eat-pair');
for (const line of changed) console.log('  ✓ ' + line);
for (const line of log) console.log('  · ' + line);
if (!WRITE) console.log('\n（预演完成，加 --write 落盘）');
