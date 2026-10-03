// 把 assets/ 中新增的帧写入 config/images/*.json（只补映射，不改动作）
import fs from 'fs';
import path from 'path';

const ROOT = 'D:/Code/deskpet';
const ASSETS = path.join(ROOT, 'assets');
const IMG_DIR = path.join(ROOT, 'config/images');
const WRITE = process.argv.includes('--write');

// 关键帧在 config 里去掉扩展名，帧名 = 文件名去 .png
const frameName = (f) => f.replace(/\.png$/i, '');

const report = [];
const summary = {};

for (const id of fs.readdirSync(ASSETS)) {
  const dir = path.join(ASSETS, id);
  if (!fs.statSync(dir).isDirectory()) continue;
  const jsonPath = path.join(IMG_DIR, `${id}.json`);
  if (!fs.existsSync(jsonPath)) { report.push(`[skip] ${id}: 无 config/images/${id}.json`); continue; }

  const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const before = Object.keys(cfg).length;
  const added = [];

  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.toLowerCase().endsWith('.png')) continue;
    const key = frameName(file);
    if (cfg[key]) continue;
    cfg[key] = `${id}/${file}`;
    added.push(key);
  }

  // 按 key 排序输出（保持既有风格：L 段、R 段、其它）
  const sorted = {};
  for (const k of Object.keys(cfg).sort()) sorted[k] = cfg[k];

  summary[id] = { before, after: Object.keys(sorted).length, added };
  if (WRITE && added.length) fs.writeFileSync(jsonPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

for (const [id, s] of Object.entries(summary)) {
  report.push(`${id}: ${s.before} -> ${s.after}  (+${s.added.length})`);
  if (s.added.length) report.push('   ' + s.added.join(', '));
}
fs.writeFileSync('D:/Temp/config-sync-report.txt', report.join('\n'), 'utf8');
console.log(report.join('\n'));
