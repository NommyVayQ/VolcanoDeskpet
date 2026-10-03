#!/usr/bin/env node
/**
 * 给「已入库但没配动作」的合体帧补齐合体动作 + 配对规则 + 右键菜单入口。
 *
 * 背景（2026-10-01 用户报「增加了多个角色合体动作，右键菜单里好像没体现」）：
 *   新美术源同步进来一批双人合体帧（每张图内含左右两个角色），但只有 rose↔nina
 *   那条早已配好（rose/interact 引用 rose-nina-*、nina/interact 引用 nina-rose-*）。
 *   其余 6 对帧躺在 assets 里当孤儿帧，既没动作、也没 meetRules 配对 → 菜单看不到。
 *
 * 帧资产全景（每张 221x150，与现有 interact 的 width:221 一致，无需补边）：
 *   rose  : rose-gwn×7  rose-mona×5  rose-nina×9(已用)  rose-rebeza×12
 *   nina  : nina-mona×8  nina-rose×11(已用)
 *   rebeza: rebeza-gwn×12  rebeza-rose×11
 *   mona  : mona-gwn×6  mona-nina×8  mona-rose×5
 *   gwen  : gwn-mona×6  gwn-rebeza×12  gwn-rose×7
 *
 * 本脚本做的事（纯数据，不改代码）：
 *   1. 为每对生成两个「主演方」动作：<own>-<other> 帧 → 动作 id 用 meetRules id（'meet'）；
 *   2. 在「发起方」角色的 meetRules 里加配对（self=主演动作, other=对应方动作）；
 *   3. 在双方 actions 里各加一条 menuGroup:"合体" 的菜单入口（pairTrigger + pairWith + pairId）。
 *
 * ⚠️ 配对单向挂载：meetRules 挂在其中一方即可（app.ts 的 pairListBetween 会双向查）。
 *    这里统一挂「id 字典序较小」的一方，保证幂等且不与现有规则冲突。
 *
 * ⚠️ 菜单入口用 pairId 匹配配对的 **id 字段**（app.ts: list.find(p => p.id === pairId)），
 *    不是动作 id → 新增配对的 id 必须与菜单入口的 pairId 严格一致（本脚本用同一常量，天然一致）。
 *
 * 幂等：已存在的动作/规则/菜单项一律跳过（按 id 判重）。dry-run 默认，`--write` 落盘。
 *
 * 用法：
 *   node scripts/add-coop-pairs.mjs          # 预演
 *   node scripts/add-coop-pairs.mjs --write  # 落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ACTIONS_DIR = path.join(ROOT, 'config', 'actions');
const CHARS_DIR = path.join(ROOT, 'config', 'characters');
const WRITE = process.argv.includes('--write');
const IMAGES_DIR = path.join(ROOT, 'config', 'images');

/** 配对定义：a/b = 角色 id（a 是「主演/发起」方，用自己那套合照帧）。
 *  labelA / labelB = **各自视角**的菜单文案（a 看到 labelA、b 看到 labelB）。
 *    菜单是「我的角色能做什么」，文案必须以自己为主语（gwen 侧看到的不能是「和格温妮斯聊天」）。
 *  ⚠️ 配对 id 与动作名由 a+b 共同派生（见下方 id/actId），避免「同一个 b 与多个 a 配对」
 *     时生成同名动作互相覆盖（如 gwen 同时与 rose、rebeza 配对）。
 *  ⚠️ 同一对角色只写一条（rose↔rebeza 不要反向再写），否则同一对挂两条配对、随机抽到重复演出。 */
const PAIRS = [
  { a: 'rose', b: 'gwen', labelA: '和格温妮斯打招呼', labelB: '和露丝打招呼' },
  { a: 'rose', b: 'mona', labelA: '和莫娜一起吃饭', labelB: '和露丝一起吃饭' },
  { a: 'rose', b: 'rebeza', labelA: '和雷贝莎聊天', labelB: '和露丝聊天' },
  { a: 'nina', b: 'mona', labelA: '和莫娜一起玩', labelB: '和妮娜一起玩' },
  { a: 'rebeza', b: 'gwen', labelA: '和格温妮斯聊天', labelB: '和雷贝莎聊天' },
  // ⚠️ 这一对早先漏配了（素材里 mona-gwn×6 / gwn-mona×6 两套图都在，却没生成动作）
  //    —— 用户 2026-10-01 发现「莫娜和格温妮斯的合体动作是不是少了一个」。补上。
  { a: 'mona', b: 'gwen', labelA: '和格温妮斯一起玩', labelB: '和莫娜一起玩' },
];

/** 读一个角色 json（actions 或 characters），返回 { path, doc, body }。 */
function readJson(p) {
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { doc, body: doc.actions ?? doc };
}

const summary = [];
const warnings = [];

for (const pair of PAIRS) {
  const { a, b, labelA, labelB } = pair;
  // 配对 id 带上双方：同一对角色可能有多条配对（rose↔mona 已有 sing/eat），
  // 且同一角色可与多个他人配对 → 只用 b 会撞名（gwen 同时配 rose / rebeza）。
  const id = `${a}_${b}`;

  // —— 用 a 的 images 映射查这对合照帧有哪些帧号（a 侧帧名形如 `${a}-${b}-N`）——
  // 注意 gwen 在合体目录里可能写作 gwn（新源用了缩写），所以两种前缀都试。
  const imgA = JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, `${a}.json`), 'utf8'));
  const bAliases = [b, b === 'gwen' ? 'gwn' : b].filter((v, i, arr) => arr.indexOf(v) === i);
  const found = [];
  for (const key of Object.keys(imgA)) {
    for (const ba of bAliases) {
      const m = key.match(new RegExp(`^${a}-${ba}-(\\d+)$`));
      if (m) { found.push({ key, n: Number(m[1]), alias: ba }); break; }
    }
  }
  found.sort((x, y) => x.n - y.n);

  if (found.length === 0) { warnings.push(`${a}->${b} (${id}): a 侧找不到合照帧，跳过`); continue; }

  const ownFrames = found.map((f) => f.key);
  const alias = found[0].alias;

  // —— b 侧对应帧（帧号一一对应；b 侧的 frames 文件里键名形如 `${alias}-${a}-N`）——
  const imgB = JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, `${b}.json`), 'utf8'));
  const otherPrefix = alias === b ? `${b}-${a}` : `${alias}-${a}`;
  const otherFrames = [];
  for (const f of found) {
    const want = `${otherPrefix}-${f.n}`;
    if (imgB[want]) otherFrames.push(want);
  }
  if (otherFrames.length !== ownFrames.length) {
    warnings.push(`${a}->${b} (${id}): 双方帧数不齐（${ownFrames.length} vs ${otherFrames.length}），按交集处理`);
  }
  const n = Math.min(ownFrames.length, otherFrames.length);
  ownFrames.length = n;
  otherFrames.length = n;
  if (n === 0) { warnings.push(`${a}->${b} (${id}): 交集为空，跳过`); continue; }

  // ⚠️ 动作 id 必须**双方同名**：triggerPairedAction 用 leftPet.config.actions[actionId] 取定义
  //    （app.ts:496），而 leftPet 是按 x 坐标动态决定的 —— 谁在左谁当 lead，就查谁的动作表。
  //    两侧动作不同名 → 随机有一侧取到 undefined，表现为「同一条配对时好时坏」。
  //    所以两侧都注册 actId，各持自己那套合照帧（a 侧帧名 `<a>-<bAlias>-N`，b 侧 `<bAlias>-<a>-N`）。
  const actId = `pair_${a}_${b}`;

  // ---------- 1) 双方各注册同名动作（各持自己那套合照帧）----------
  const pa = path.join(ACTIONS_DIR, `${a}.json`);
  const A = readJson(pa);
  // ⚠️ frameMs 不要写死 800（2026-10-01）：合体总时长由 set-coop-duration.mjs 统一反推
  //    （如 5 帧→1600、12 帧→667），这里硬写 800 会把那次调整**覆盖回 800**，
  //    两个脚本互相打架。动作已存在 → 沿用现有 frameMs；只有新建时才用默认 800。
  const DEFAULT_FRAME_MS = 800;
  const prevFrameMsA = A.body[actId] && typeof A.body[actId].frameMs === 'number'
    ? A.body[actId].frameMs : DEFAULT_FRAME_MS;
  const newActA = {
    behavior: 'static',
    frames: ownFrames,
    width: 221,
    height: 150,
    coop: true,
    lead: a,
    loop: true,
    facePartner: true,
    menu: true,
    menuGroup: '合体',
    menuOrder: 5,
    pairTrigger: true,
    pairWith: b,
    pairId: id,
    label: labelA,
    frameMs: prevFrameMsA,
    loopCount: 1,
    durationMs: 0,
  };

  const pb = path.join(ACTIONS_DIR, `${b}.json`);
  const B = readJson(pb);
  const prevFrameMsB = B.body[actId] && typeof B.body[actId].frameMs === 'number'
    ? B.body[actId].frameMs : DEFAULT_FRAME_MS;
  // 对侧镜像：帧换成 b 侧那套，菜单文案换成 b 的视角。
  const newActB = {
    ...newActA,
    frameMs: prevFrameMsB,
    frames: otherFrames,
    flip: false,          // 两侧帧都已按各自左右站位画好，无需翻转
    pairWith: a,          // b 侧发起时配对的是 a
    label: labelB,
  };

  const diffsA = [];
  const diffsB = [];
  // 幂等：已存在且内容一致 → 不动（避免每次跑都重写文件、产生无意义 diff）。
  if (JSON.stringify(A.body[actId]) === JSON.stringify(newActA)) diffsA.push(`= ${a}/${actId}`);
  else { A.body[actId] = newActA; diffsA.push((A.body[actId] ? '~ ' : '+ ') + `${a}/${actId}(${ownFrames.length}帧)`); }
  if (JSON.stringify(B.body[actId]) === JSON.stringify(newActB)) diffsB.push(`= ${b}/${actId}`);
  else { B.body[actId] = newActB; diffsB.push((B.body[actId] ? '~ ' : '+ ') + `${b}/${actId}(${otherFrames.length}帧)`); }

  // ---------- 3) meetRules 挂到 **a 侧**（主演方发起）----------
  // ⚠️ 语义核对（对照 config/characters/mona.json 既有规则）：
  //    meetRules[<对手id>] = { pairs:[{ id, self, other }] }
  //    其中 `self` = **规则拥有者自己**演的动作，`other` = **对手**演的动作。
  //    所以规则必须挂在主演方 a 上、self 填 a 的动作（actIdA）、other 填 b 的动作（actIdB）。
  //    （初版挂到 b 上、self 却填 a 的动作 → 方向反了，演出时 a 会去调 b 的动作，帧对不上。）
  const ca = path.join(CHARS_DIR, `${a}.json`);
  const CA = JSON.parse(fs.readFileSync(ca, 'utf8'));
  CA.meetRules = CA.meetRules || {};
  const rule = CA.meetRules[b] = CA.meetRules[b] || {};
  // 统一使用 pairs 数组（normalizeMeetRules 会把旧式单 pair 归一，但这里直接写标准形态）
  if (!Array.isArray(rule.pairs)) {
    // 若原来是旧式单 pair，先把它迁进 pairs，避免丢规则
    rule.pairs = rule.pair ? [rule.pair] : [];
    delete rule.pair;
  }
  let added = false;
  if (!rule.pairs.some((p) => p && p.id === id)) {
    // self/other 同名（两侧动作 id 一致），含义仍保留：self=拥有者自己、other=对手。
    rule.pairs.push({ id, self: actId, other: actId });
    added = true;
  }
  const diffsC = added ? [`+ meetRule ${a}.meetRules[${b}].pairs[id=${id}]`] : [`= meetRule ${a}.meetRules[${b}][id=${id}] 已存在`];
  if (rule.chance === undefined) rule.chance = 0.03;
  if (rule.distance === undefined) rule.distance = 200;

  summary.push(`${a} ↔ ${b} [${id}] 帧${n}张: ${diffsA[0]} / ${diffsB[0]} / ${diffsC[0]}`);
  if (WRITE) {
    fs.writeFileSync(pa, JSON.stringify(A.doc, null, 2) + '\n', 'utf8');
    fs.writeFileSync(pb, JSON.stringify(B.doc, null, 2) + '\n', 'utf8');
    fs.writeFileSync(ca, JSON.stringify(CA, null, 2) + '\n', 'utf8');
  }
}

console.log((WRITE ? '[write] ' : '[dry-run] ') + 'add-coop-pairs');
for (const line of summary) console.log('  ✓ ' + line);
if (warnings.length) { console.log('\n⚠ 跳过/告警：'); for (const w of warnings) console.log('  · ' + w); }
if (!WRITE) console.log('\n（预演完成，加 --write 落盘）');
