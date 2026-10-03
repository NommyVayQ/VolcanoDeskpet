// 正向映射：动作 -> 使用的图片(PNG路径)（适配四类子目录结构）
// 读取：config/config.json + config/actions/<角色>.json + config/images/<角色>.json
// 用法:
//   node scripts/action-frames.mjs          # 全部角色，并打印到控制台
//   node scripts/action-frames.mjs nina     # 只看某个角色
// 同时会写出 scripts/action-frames-report.txt 供直接打开查看
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const master = JSON.parse(readFileSync(path.join(root, 'config', 'config.json'), 'utf8'));
const roles = Array.isArray(master.characters) ? master.characters : [];
const onlyChar = process.argv[2] || null;
const out = [];
for (const id of roles) {
  if (onlyChar && id !== onlyChar) continue;
  const act = JSON.parse(readFileSync(path.join(root, 'config', 'actions', `${id}.json`), 'utf8')).actions || {};
  const img = JSON.parse(readFileSync(path.join(root, 'config', 'images', `${id}.json`), 'utf8')) || {};
  const base = JSON.parse(readFileSync(path.join(root, 'config', 'characters', `${id}.json`), 'utf8'));
  out.push(`\n========== ${id} (${base.name || id}) ==========`);
  for (const [actionId, def] of Object.entries(act)) {
    const behavior = def.behavior || '?';
    const menu = def.menu ? ' [右键菜单]' : '';
    const files = (def.frames || []).map((f) => img[f] || `!!缺失:${f}`).join(', ');
    out.push(`  ${actionId.padEnd(16)} (${behavior}${menu})  ->  ${files}`);
  }
}
const text = out.join('\n');
writeFileSync(path.join(root, 'scripts', 'action-frames-report.txt'), text + '\n', 'utf8');
console.log(text);
console.log(`\n报告已写出: scripts/action-frames-report.txt`);
