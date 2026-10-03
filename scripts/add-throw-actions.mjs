#!/usr/bin/env node
/**
 * 给「除 nina 之外」的角色补齐窗口投掷动作（全员投掷窗口）。
 *
 * 背景：
 *   nina 早先已有一整套窗口动作（jumpWindow / grabWindow / carryWindow / throwWindow / windowThrow），
 *   app.ts 的 maybeThrowWindow() 因此只挑得出 nina（hasThrowFrames 过滤）。
 *   新美术源（2026-10-01 同步）里 5 个角色都有 L/R-throw-1/2/3 三帧，
 *   语义为「捂脸 → 扛起 → 甩出」的连贯抛掷（150x150 画布、内容底边=150，与既有帧完全一致，无需 repad）。
 *
 * 本脚本做的事（纯数据，不改代码）：
 *   1. 为 rose / rebeza / mona / gwen 写入 jumpWindow / grabWindow / carryWindow / throwWindow / windowThrow 五个动作；
 *   2. 把 windowThrow 挂进各角色的 actionGroups 动作组（与 nina 同款 menuOrder:1001）；
 *   3. 若角色还没有 menuGroup 归属，把 throw 系动作归到「合体」之外 —— 不，抛掷是独立能力，
 *      因此只给 windowThrow 显式 menu:true + menuOrder:1001（右键菜单里排在动作下方），
 *      其余四段（jump/grab/carry/throw）menu:false，仅由 WindowInteract 状态机内部调用。
 *
 * 帧映射（对齐新源语义 + 现有静态帧的复用）：
 *   jumpWindow   : L/R-climb-1       （起跳：单帧，同 nina）
 *   grabWindow   : L/R-throw-1       （抓住 = 捂脸发力那一帧）
 *   carryWindow  : L/R-throw-2       （扛着走 = 扛起那一帧）
 *   throwWindow  : L/R-throw-3       （甩出 = 撒手那一帧）
 *   windowThrow  : L/R-throw-2       （菜单条目的「缩略图」，实际演出由 WindowInteract 驱动）
 *   ⚠️ 这四个动作**必须每个角色都单独存在**，否则 maybeThrowWindow() 的 hasThrowFrames 过滤会跳过该角色。
 *
 * 幂等：已存在同名动作时默认覆盖为脚本定义（保证多角色一致）；
 *       已一致则不动（不产生 diff）。dry-run 默认，`--write` 才落盘。
 *
 * 用法：
 *   node scripts/add-throw-actions.mjs            # 预演
 *   node scripts/add-throw-actions.mjs --write    # 落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ACTIONS_DIR = path.join(ROOT, 'config', 'actions');
const WRITE = process.argv.includes('--write');

/** 需要补窗口动作的角色（nina 已有，跳过以免动到既有节奏）。 */
const TARGETS = ['rose', 'rebeza', 'mona', 'gwen'];

/** 每个角色在跳上/扛走/甩出时展示的静态帧名。默认都用 throw 三帧（新源语义最贴切）。 */
const FRAMES = {
  jumpWindow: 'climb-1',   // 起跳 → 复用攀爬首帧（单帧举起姿态）
  grabWindow: 'throw-1',   // 抓住 → 捂脸发力
  carryWindow: 'throw-2',  // 扛着走 → 扛起
  throwWindow: 'throw-3',  // 甩出 → 撒手
  windowThrow: 'throw-2',  // 菜单条目缩略（实际演出由 WindowInteract 驱动）
};

/** 各动作的时长/节奏（对齐 nina 既有配置，改这里即全角色统一）。 */
const TIMING = {
  jumpWindow: { frameMs: 200, loop: true },
  grabWindow: { frameMs: 260, loop: true },
  carryWindow: { frameMs: 150, loop: true },
  throwWindow: { frameMs: 650, loop: false },
  windowThrow: { frameMs: 150, loop: true },
};

const LABELS = {
  jumpWindow: '跳向窗口下角',
  grabWindow: '抓住窗口',
  carryWindow: '扛着窗口',
  throwWindow: '甩出窗口',
  windowThrow: '抛掷窗口',
};

/** 构造一个窗口动作定义（双套帧集）。 */
function mk(id, side, frameKey) {
  const frame = `${side}-${frameKey}`;
  const t = TIMING[id];
  const def = {
    behavior: 'static',
    frames: [frame],
    rightFrames: [`R-${frameKey}`],
    loop: t.loop,
    menu: id === 'windowThrow',
    label: LABELS[id],
    frameMs: t.frameMs,
    durationMs: 0,
  };
  if (id === 'windowThrow') {
    def.menuOrder = 1001;
    def.windowMode = 'throw';
  }
  return def;
}

const summary = [];
for (const fid of TARGETS) {
  const p = path.join(ACTIONS_DIR, `${fid}.json`);
  const raw = fs.readFileSync(p, 'utf8');
  const doc = JSON.parse(raw);
  const acts = doc.actions ?? doc;
  const changes = [];

  for (const id of Object.keys(FRAMES)) {
    const next = mk(id, 'L', FRAMES[id]);
    const cur = acts[id];
    if (!cur) { changes.push(`+ ${id}`); acts[id] = next; continue; }
    if (JSON.stringify(cur) !== JSON.stringify(next)) changes.push(`~ ${id}（覆盖）`);
    acts[id] = next;
  }

  if (changes.length === 0) { summary.push(`${fid}: 已最新，无需改动`); continue; }
  summary.push(`${fid}: ${changes.join(' / ')}`);

  if (WRITE) {
    // 保持 2 空格缩进 + 末尾换行（与仓库其它 config 一致）
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }
}

console.log((WRITE ? '[write] ' : '[dry-run] ') + 'add-throw-actions');
for (const line of summary) console.log('  ' + line);
if (!WRITE) console.log('\n（预演完成，加 --write 落盘）');
