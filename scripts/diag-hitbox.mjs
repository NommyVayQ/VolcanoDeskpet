#!/usr/bin/env node
/**
 * 命中框（鼠标穿透捕获区）诊断：对比「命中框 = 当前帧整块画布盒」与「可见内容 bbox」。
 *
 * 背景：穿透的唯一输入是 `Pet.petAt(x,y)` → `container.getBounds()` = 当前帧 body 的显示矩形
 * （= 整块 PNG 画布，**含四周透明留白**），所以：
 *   命中框比可见内容大多少，就代表「角色旁边有多少像素的桌面点不动」。
 *   命中框比角色框（config.size）大多少，就代表该动作让捕获区超出了角色自身的占位。
 *
 * 复刻 `Pet.applySpriteSize` 的算法（不依赖 Electron / PIXI，直接读 PNG 扫 alpha）：
 *   targetH = actionDef.height ?? size.height ; maxW = actionDef.width ?? size.width
 *   scale   = 帧自带 scale ?? min(targetH/srcH, maxW/srcW)
 *   无 offset 时：body 底边贴容器底边(targetH)、水平居中于 size.width → 局部框 = [W/2-dw/2, W/2+dw/2] × [targetH-dh, targetH]
 *   有 offset 时：body 居中于 (size.width/2+off.x, size.height/2+off.y)
 *
 * 用法：
 *   node scripts/diag-hitbox.mjs                # 全部角色
 *   node scripts/diag-hitbox.mjs gwen           # 只看某个角色
 *   node scripts/diag-hitbox.mjs gwen --flags   # 只列「超出角色框」的动作
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 解码 8bit RGBA / 非隔行 PNG，返回 {w,h,px}。其他编码抛错（当前项目美术均为 8bit RGBA）。 */
function decodeRGBA(file) {
  const b = fs.readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  if (b[24] !== 8 || b[25] !== 6 || b[28] !== 0) throw new Error('非 8bit RGBA 非隔行 PNG: ' + file);
  const idat = [];
  let p = 8;
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0, bb = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      let v = line[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + bb) & 255;
      else if (ft === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (ft === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c))) & 255;
      }
      cur[i] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, px: out };
}

/** 非透明 bbox（alpha 阈值 8，忽略半透明噪声） */
function alphaBBox(file) {
  const { w, h, px } = decodeRGBA(file);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { w, h, minX, minY, maxX, maxY };
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
const frameName = (f) => (typeof f === 'string' ? f : f?.name);
const frameScale = (f) => (typeof f === 'object' && typeof f?.scale === 'number' ? f.scale : null);

function analyze(id) {
  const char = readJson(`config/characters/${id}.json`);
  const actions = readJson(`config/actions/${id}.json`).actions || {};
  const images = readJson(`config/images/${id}.json`);
  let coop = {};
  try { coop = readJson('config/images/coop.json'); } catch { /* 可选 */ }
  const size = char.size || { width: 150, height: 150 };

  const rows = [];
  for (const [actionId, a] of Object.entries(actions)) {
    const targetH = a.height ?? size.height;
    const maxW = a.width ?? size.width;
    const cache = new Map();
    for (const list of [a.frames, a.rightFrames]) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        const name = frameName(f);
        const rel = images[name] ?? coop[name];
        if (!rel) { rows.push({ actionId, name, err: 'manifest 无此帧' }); continue; }
        const abs = path.join(ROOT, 'assets', rel);
        if (!fs.existsSync(abs)) { rows.push({ actionId, name, err: 'PNG 缺失' }); continue; }
        const key = rel + '@' + targetH + 'x' + maxW;
        let bb = cache.get(key);
        if (!bb) { bb = alphaBBox(abs); cache.set(key, bb); }
        const s = frameScale(f) ?? Math.min(targetH / bb.h, maxW / bb.w);
        const dw = bb.w * s, dh = bb.h * s;
        const off = a.offset;
        const left = off ? (size.width / 2 + (off.x ?? 0)) - dw / 2 : size.width / 2 - dw / 2;
        const boxL = left, boxR = left + dw;
        const cL = left + bb.minX * s, cR = left + bb.maxX * s;
        rows.push({
          actionId, name, canvas: `${bb.w}x${bb.h}`, disp: `${dw.toFixed(0)}x${dh.toFixed(0)}`,
          box: [Math.round(boxL), Math.round(boxR)],
          deadL: Math.round(cL - boxL), deadR: Math.round(boxR - cR),
          overL: Math.round(Math.max(0, -boxL)), overR: Math.round(Math.max(0, boxR - size.width)),
          overH: Math.round(Math.max(0, dh - size.height)),
        });
      }
    }
  }
  return { size, rows };
}

const argv = process.argv.slice(2);
const onlyFlags = argv.includes('--flags');
const ids = argv.filter((a) => !a.startsWith('--'));
const targets = ids.length ? ids : ['rose', 'nina', 'rebeza', 'gwen'];

for (const id of targets) {
  let data;
  try { data = analyze(id); } catch (e) { console.log(`跳过 ${id}: ${e.message}`); continue; }
  const { size, rows } = data;
  const bad = rows.filter((r) => r.overL || r.overR || r.overH);
  console.log(`\n===== ${id}  角色框 ${size.width}x${size.height}  帧 ${rows.length}  （命中框=当前帧画布盒，含透明留白）`);
  if (bad.length) {
    console.log('  ⚠ 命中框超出角色框的动作（捕获区会吃掉角色框外的桌面像素）:');
    for (const r of bad) {
      console.log(`    ${r.actionId.padEnd(14)} ${String(r.name).padEnd(16)} 显示${r.disp.padEnd(9)}`
        + ` 命中框[${r.box[0]},${r.box[1]}]  超出 左${r.overL}px 右${r.overR}px 高${r.overH}px`);
    }
  } else {
    console.log('  命中框均未超出角色框 ✓');
  }
  if (!onlyFlags) {
    console.log('  动作/帧              画布       显示       命中框(局部x)     可见内容左右死区');
    for (const r of rows) {
      if (r.err) { console.log(`    ${r.actionId.padEnd(14)} ${String(r.name).padEnd(16)} ${r.err}`); continue; }
      console.log(`    ${(r.actionId + ' ' + r.name).padEnd(32)} ${r.canvas.padEnd(10)} ${r.disp.padEnd(10)}`
        + `[${String(r.box[0]).padStart(4)},${String(r.box[1]).padStart(4)}]     左${String(r.deadL).padStart(4)}px 右${String(r.deadR).padStart(4)}px`);
    }
  }
}
console.log('\n提示：左右死区 = 命中框边缘到可见角色的像素距离（这一段点不到桌面）；'
  + '\n      死区大是「角色旁边桌面点不动」的直接原因，命中框超出角色框则说明该动作显式配了 width/height。');
