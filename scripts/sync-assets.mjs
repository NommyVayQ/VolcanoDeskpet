// 资产同步：新美术源 -> assets/ （默认 dry-run，加 --write 才落盘）
// 用法: node scripts/sync-assets.mjs           # 预览
//       node scripts/sync-assets.mjs --write   # 执行
import fs from 'fs';
import path from 'path';

const ROOT = 'D:/Code/deskpet';
const SRC = 'D:/NommyVayQ/Pictures/桌宠图片/桌宠';
const ASSETS = path.join(ROOT, 'assets');
const WRITE = process.argv.includes('--write');

const CHAR_DIR = {
  '露丝弗莱贝格': 'rose',
  '妮娜汉德': 'nina',
  '雷贝莎洛莱斯': 'rebeza',
  '莫娜阿尔布莱希特': 'mona',
  '格温妮斯克莱蒙德': 'gwen',
};
const IDS = new Set(Object.values(CHAR_DIR));
// 合体动作目录里 gwen 用了缩写 gwn
const ALIAS = { gwn: 'gwen' };
// ⚠️ 项目自产资源：不在新源里，但绝不能被同步删除
//   nina 的扛窗帧是从 jar 逐帧提取+底边对齐得来的，新源没有对应素材
const KEEP = [/^nina\/(L|R)-carry-\d+\.png$/];
const DISAPPEAR = { rose: [1, 2, 3], nina: [1, 4, 5], rebeza: [1, 6, 7], mona: [1, 8, 9], gwen: [1, 10, 11] };
const BUBBLE = { '露丝': 'rose', '妮娜': 'nina', '雷被杀': 'rebeza', '莫娜': 'mona', '格温妮丝': 'gwen' };


function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

const plan = new Map();   // dst -> src abs
const unmapped = [];
const collisions = [];

for (const rel of walk(SRC)) {
  if (!rel.toLowerCase().endsWith('.png')) continue;
  const parts = rel.split('/');
  const file = parts[parts.length - 1];
  let dst = null;
  let abs = path.join(SRC, rel);

  if (parts[0] === '消失动画') {
    const n = parseInt(file.replace(/[^0-9]/g, ''), 10);
    // 同一张消失帧可被多个角色共用（如帧1）
    const owners = Object.entries(DISAPPEAR).filter(([, list]) => list.includes(n)).map(([id]) => id);
    for (const id of owners) {
      const d = `${id}/disappear-${n}.png`;
      if (!plan.has(d)) plan.set(d, []);
      plan.get(d).push(abs);
    }
    continue;
  }
  if (parts[0] === '对话框') {
    const id = BUBBLE[file.replace('.png', '')];
    if (id) dst = `${id}/bubble.png`;
  } else if (parts[0] === '合体动作') {
    const id = ALIAS[parts[1]] || parts[1];
    if (IDS.has(id)) dst = `${id}/${file}`;
  } else {
    const id = CHAR_DIR[parts[0]];
    if (id) {
      let name = file;
      // 露丝「走路」目录左向帧被误命名为 L-swing-N，语义应为 walk
      if (parts[0] === '露丝弗莱贝格' && parts[2] === '走路' && /^L-swing-(\d+)\.png$/.test(name)) {
        name = name.replace('L-swing-', 'L-walk-');
      }
      // 补帧保持 L-sup-N 原名。⚠️ 曾误映射 nina 补帧为 L-carry-N，覆盖了 jar 提取的扛窗帧
      //    （2026-10-01 已从备份恢复 carry）。assumptions/nina/L-carry-*.png 不在新源里，
      //    同步时不要动它。
      dst = `${id}/${name}`;
    }
  }
  if (!dst) { unmapped.push(rel); continue; }
  // 同一 dst 允许多个源（如消失动画帧1 被 5 个角色共用），收集成列表
  if (!plan.has(dst)) plan.set(dst, []);
  plan.get(dst).push(abs);
}

// 展平
const flat = new Map();
for (const [dst, list] of plan) flat.set(dst, list);

const existing = new Set(walk(ASSETS).filter(f => f.toLowerCase().endsWith('.png')));
const planned = new Set(flat.keys());
const toReplace = [...planned].filter(p => existing.has(p)).sort();
const toAdd = [...planned].filter(p => !existing.has(p)).sort();
const toDelete = [...existing].filter(e => !planned.has(e) && !KEEP.some(re => re.test(e))).sort();

const totalSrc = [...flat.values()].reduce((n, l) => n + l.length, 0);
console.log(`新源映射: ${flat.size} 目标 / ${totalSrc} 源文件   现有: ${existing.size}`);
console.log(`替换: ${toReplace.length}  新增: ${toAdd.length}  删除: ${toDelete.length}`);
console.log(`冲突: ${collisions.length}  未识别: ${unmapped.length}`);
if (collisions.length) collisions.forEach(c => console.log('  COL', c));
if (unmapped.length) unmapped.forEach(c => console.log('  UNMAPPED', c));

if (!WRITE) {
  const report = [
    `== 本次将删除的 ${toDelete.length} 个旧文件 ==`,
    ...toDelete,
    '',
    `== 本次新增的 ${toAdd.length} 个文件（前 80）==`,
    ...toAdd.slice(0, 80),
  ].join('\n');
  fs.writeFileSync('D:/Temp/asset-sync-dryrun.txt', report, 'utf8');
  console.log('dry-run 报告已写入 D:/Temp/asset-sync-dryrun.txt');
  process.exit(0);
}

// ---- 备份 ----
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(ROOT, `assets-backup-${stamp}`);
console.log(`备份 -> ${backup}`);
fs.cpSync(ASSETS, backup, { recursive: true });

// ---- 删除 + 写入 ----
let delCount = 0;
for (const rel of toDelete) {
  const p = path.join(ASSETS, rel);
  fs.rmSync(p, { force: true });
  delCount++;
}
for (const [dst, list] of flat) {
  const p = path.join(ASSETS, dst);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  for (const abs of list) fs.copyFileSync(abs, p);
}
// 清理空目录
const prune = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const sub = path.join(d, e.name);
      prune(sub);
      if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
    }
  }
};
prune(ASSETS);

console.log(`完成: 删除 ${delCount}, 写入 ${plan.size}`);
console.log(`备份目录保留在 ${backup}（确认无误后可删）`);
