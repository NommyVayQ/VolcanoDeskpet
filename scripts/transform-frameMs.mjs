import fs from 'fs';
import path from 'path';

// 统一动作时长：删除 speed，所有动作 frameMs=1000；清掉逐帧 {name,ms} 覆盖（改为纯帧名）。
const dir = 'd:/Code/deskpet/config/actions';
for (const f of ['rose.json']) {
  const p = path.join(dir, f);
  const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
  for (const key of Object.keys(json.actions)) {
    const a = json.actions[key];
    delete a.speed;
    const norm = (fr) => (typeof fr === 'string' ? fr : (fr && typeof fr.name === 'string' ? fr.name : fr));
    if (Array.isArray(a.frames)) a.frames = a.frames.map(norm);
    if (Array.isArray(a.rightFrames)) a.rightFrames = a.rightFrames.map(norm);
    a.frameMs = 1000;
  }
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
  console.log('updated', f, '(', Object.keys(json.actions).length, 'actions )');
}

// config.ts 内置 DEFAULTS：把动作级 `speed: <num>` 改为 `frameMs: 1000`（不动 moveSpeed: 与 normalize 逻辑）。
const cfg = 'd:/Code/deskpet/src/renderer/config.ts';
let s = fs.readFileSync(cfg, 'utf-8');
const before = (s.match(/\bspeed:\s*[\d.]+\b/g) || []).length;
s = s.replace(/\bspeed:\s*[\d.]+\b/g, 'frameMs: 1000');
fs.writeFileSync(cfg, s);
console.log('config.ts: replaced', before, 'speed: occurrences -> frameMs: 1000');
