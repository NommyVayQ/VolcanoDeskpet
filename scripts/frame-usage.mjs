// 反向查询：某张图片（帧名）被哪些角色的哪些动作引用（适配四类子目录结构）
// 用法：
//   node scripts/frame-usage.mjs            # 输出全部帧 -> 动作 映射
//   node scripts/frame-usage.mjs shime5     # 只查 shime5 用在哪里
//   node scripts/frame-usage.mjs --orphan  # 只列出 assets 里存在但没被任何动作引用的孤立帧
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const master = JSON.parse(readFileSync(path.join(root, 'config', 'config.json'), 'utf8'));
const roles = Array.isArray(master.characters) ? master.characters : [];

// 组装出 [{ id, actions, images }]
const chars = [];
for (const id of roles) {
  const act = JSON.parse(readFileSync(path.join(root, 'config', 'actions', `${id}.json`), 'utf8')).actions || {};
  const img = JSON.parse(readFileSync(path.join(root, 'config', 'images', `${id}.json`), 'utf8')) || {};
  chars.push({ id, actions: act, images: img });
}

const filter = process.argv[2] || null;
const onlyOrphan = filter === '--orphan';

// 1. 建立 frame -> [{char, action, behavior}] 反向索引
const usage = new Map();
for (const ch of chars) {
  for (const [actionId, def] of Object.entries(ch.actions)) {
    const behavior = def.behavior || '?';
    // 纯触发型动作（如菜单「配对」入口：pairTrigger 标记、无 frames）不是动画，跳过
    if (!Array.isArray(def.frames) && !Array.isArray(def.rightFrames)
      && !Array.isArray(def.hoverFrames) && !Array.isArray(def.hoverRightFrames)) continue;
    // 四套帧集都要入索引：frames（左/通用）+ rightFrames（右套）
    // + hoverFrames/hoverRightFrames（飞行悬停相位）—— 漏了会误报成「孤立帧」。
    // 帧可以是字符串，也可以是 {name, ms/vx/vy/scale} 对象 → 统一取 name。
    const sets = [['frames', def.frames], ['rightFrames', def.rightFrames],
      ['hoverFrames', def.hoverFrames], ['hoverRightFrames', def.hoverRightFrames]];
    for (const [setName, arr] of sets) {
      if (!Array.isArray(arr)) continue;
      for (const f of arr) {
        const name = typeof f === 'string' ? f : (f && typeof f.name === 'string' ? f.name : String(f));
        if (!usage.has(name)) usage.set(name, []);
        usage.get(name).push({ char: ch.id, action: actionId, behavior, set: setName });
      }
    }
  }
}
const usedFrames = new Set(usage.keys());

if (onlyOrphan) {
  console.log('=== 孤立帧（assets 有 PNG 但没有任何动作引用）===');
  let count = 0;
  for (const ch of chars) {
    const dir = path.join(root, 'assets', ch.id);
    if (!existsSync(dir)) continue;
    const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''));
    const orphans = pngs.filter((p) => !usedFrames.has(p));
    if (orphans.length) {
      console.log(`${ch.id} (${orphans.length}):`);
      orphans.forEach((o) => console.log('   ' + o));
      count += orphans.length;
    }
  }
  console.log(`\n共 ${count} 个孤立帧`);
  process.exit(0);
}

const keys = [...usage.keys()].sort();
for (const f of keys) {
  if (filter && f !== filter) continue;
  const list = usage.get(f);
  const refs = list.map((u) => `${u.char}.${u.action}(${u.behavior}${u.set === 'frames' ? '' : '/' + u.set})`).join('  |  ');
  console.log(`${f}\n    -> ${refs}`);
}

if (filter) {
  if (!usage.has(filter)) console.log(`\n未找到帧 "${filter}" 被任何动作引用（可能是孤立帧，用 --orphan 查）。`);
} else {
  console.log(`\n共 ${keys.length} 个被引用的帧。用 "node scripts/frame-usage.mjs <帧名>" 单独查某张图，`);
  console.log(`用 "node scripts/frame-usage.mjs --orphan" 查未被使用的图片。`);
}
