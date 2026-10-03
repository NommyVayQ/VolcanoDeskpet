// 只读分析：比对「新美术源」与现有 assets/，产出同步计划报告（不写任何文件）
import fs from 'fs';
import path from 'path';

const ROOT = 'D:/Code/deskpet';
const SRC = 'D:/NommyVayQ/Pictures/桌宠图片/桌宠';
const ASSETS = path.join(ROOT, 'assets');

const CHAR_DIR = {
  '露丝弗莱贝格': 'rose',
  '妮娜汉德': 'nina',
  '雷贝莎洛莱斯': 'rebeza',
  '莫娜阿尔布莱希特': 'mona',
  '格温妮斯克莱蒙德': 'gwen',
};

// 消失动画：disappearN.png -> 角色（沿用现有 bye 分配）
const DISAPPEAR = {
  rose: [1, 2, 3],
  nina: [1, 4, 5],
  rebeza: [1, 6, 7],
  mona: [1, 8, 9],
  gwen: [1, 10, 11],
};
const BUBBLE = { '露丝': 'rose', '妮娜': 'nina', '雷被杀': 'rebeza', '莫娜': 'mona', '格温妮丝': 'gwen' };

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(p.slice(base.length + 1));
  }
  return out;
}

// ---- 收集现有 assets ----
const existing = new Set(walk(ASSETS).filter(f => f.toLowerCase().endsWith('.png')).map(f => f.replace(/\\/g, '/')));

// ---- 收集 config/images 引用 ----
const referenced = new Map(); // relPath -> [keys]
for (const f of fs.readdirSync(path.join(ROOT, 'config/images'))) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/images', f), 'utf8'));
  for (const [k, v] of Object.entries(j)) {
    const rel = String(v).replace(/\\/g, '/');
    if (!referenced.has(rel)) referenced.set(rel, []);
    referenced.get(rel).push(`${f.replace('.json', '')}:${k}`);
  }
}

// ---- 扫描新源，生成映射 ----
const plan = [];       // {src, dst}
const collisions = []; // 同一 dst 多个 src
const dstMap = new Map();
const skipped = [];

for (const rel of walk(SRC)) {
  const relU = rel.replace(/\\/g, '/');
  if (!relU.toLowerCase().endsWith('.png')) { skipped.push(relU); continue; }
  const parts = relU.split('/');
  const file = parts[parts.length - 1];
  let dst = null;

  if (parts[0] === '消失动画') {
    const n = parseInt(file.replace(/[^0-9]/g, ''), 10);
    for (const [id, list] of Object.entries(DISAPPEAR)) {
      if (list.includes(n)) dst = `${id}/disappear-${n}.png`;
    }
  } else if (parts[0] === '对话框') {
    const zh = file.replace('.png', '');
    const id = BUBBLE[zh];
    if (id) dst = `${id}/bubble.png`;
  } else if (parts[0] === '合体动作') {
    const id = parts[1];
    if (CHAR_DIR[Object.keys(CHAR_DIR).find(k => CHAR_DIR[k] === id)] || ['rose','nina','rebeza','mona','gwen'].includes(id)) {
      dst = `${id}/${file}`;
    }
  } else {
    const id = CHAR_DIR[parts[0]];
    if (!id) { skipped.push(relU); continue; }
    let name = file;
    // 已知命名坑：露丝「走路」目录左向帧误命名为 L-swing-N
    if (parts[0] === '露丝弗莱贝格' && parts[1] === '共通' && parts[2] === '走路' && /^L-swing-\d+\.png$/.test(name)) {
      name = name.replace('L-swing-', 'L-walk-');
    }
    dst = `${id}/${name}`;
  }
  if (!dst) { skipped.push(relU); continue; }
  if (dstMap.has(dst)) collisions.push({ dst, a: dstMap.get(dst), b: relU });
  dstMap.set(dst, relU);
  plan.push({ src: relU, dst });
}

// ---- 报告 ----
const planned = new Set(plan.map(p => p.dst));
const willMiss = [...referenced.keys()].filter(r => !planned.has(r)).sort();
const orphanOld = [...existing].filter(e => !planned.has(e) && !referenced.has(e)).sort();
const orphanOldRef = [...existing].filter(e => !planned.has(e) && referenced.has(e)).sort();
const brandNew = [...planned].filter(p => !existing.has(p)).sort();

const lines = [];
const L = (s) => lines.push(s);
L(`新源 PNG 总数: ${plan.length + skipped.filter(s=>!s.toLowerCase().endsWith('.png')).length}`);
L(`跳过(非png): ${skipped.filter(s => !s.toLowerCase().endsWith('.png')).length}`);
L(`跳过(未识别): ${skipped.filter(s => s.toLowerCase().endsWith('.png')).length}`);
skipped.filter(s => s.toLowerCase().endsWith('.png')).forEach(s => L(`   UNMAPPED ${s}`));
L('');
L(`映射后目标文件数: ${planned.size}`);
L(`现有 assets PNG: ${existing.size}`);
L(`config 引用文件数: ${referenced.size}`);
L('');
L(`=== 冲突(同一目标多个源): ${collisions.length} ===`);
collisions.forEach(c => L(`  ${c.dst} <- ${c.a} | ${c.b}`));
L('');
L(`=== ⚠️ 替换后将缺失的【被引用】帧: ${orphanOldRef.length} ===`);
orphanOldRef.forEach(r => L(`  ${r}   ${referenced.get(r).slice(0,3).join(', ')}${referenced.get(r).length>3?' ...':''}`));
L('');
L(`=== ⚠️ 引用了但新源没有、且现在也不存在的帧: ${willMiss.filter(w=>!existing.has(w)).length} ===`);
willMiss.filter(w => !existing.has(w)).forEach(r => L(`  ${r}   ${referenced.get(r).slice(0,3).join(', ')}`));
L('');
L(`=== 现有 assets 中【未被引用且新源没有】的文件: ${orphanOld.length} ===`);
orphanOld.forEach(r => L(`  ${r}`));
L('');
L(`=== 新增文件(现有 assets 没有): ${brandNew.length} ===`);
brandNew.forEach(r => L(`  ${r}`));

fs.writeFileSync('D:/Temp/asset-sync-plan.txt', lines.join('\n'), 'utf8');
console.log('written');
