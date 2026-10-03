/**
 * 扫描每个动作「显示后」的人物尺寸，定位「人物忽大忽小」类问题。
 *
 * 原理：自解码 PNG（zlib + 反滤波，支持 8bit colorType 0/2/3/4/6）取非透明像素包围盒 = 人物实际占的像素，
 * 再乘以 applySpriteSize 的 contain-fit 系数 min(高约束/源高, 宽约束/源宽)，得到屏幕上的真实大小。
 *
 * 用法：node scripts/analyze-sprite-size.mjs <角色id>
 *
 * 判读：
 *   - 「缩放」列 < 1：该动作被整体压小 → 画布比角色框大（如钓鱼 198x150 塞进 150 宽），
 *     修法是动作级 "width": <画布宽>（applySpriteSize 按 size.width/2 居中，横向溢出不会偏位）。
 *   - 「显示人物高」帧间跳变 > 3px：同一动作内人物大小不一致，需统一画布（scripts/repad-frame.mjs）。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const id = process.argv[2];
if (!id) { console.error('用法: node scripts/analyze-sprite-size.mjs <角色id>'); process.exit(1); }

function decode(file) {
  const buf = readFileSync(file);
  let off = 8, w = 0, h = 0, ctype = 0, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!bpp) throw new Error('unsupported color type ' + ctype);
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * bpp;
    if (ctype === 6) alpha[i] = out[p + 3];
    else if (ctype === 4) alpha[i] = out[p + 1];
    else if (ctype === 3) { const idx = out[p]; alpha[i] = trns && idx < trns.length ? trns[idx] : 255; }
    else alpha[i] = 255;
  }
  return { w, h, alpha };
}

const cache = new Map();
function bbox(file) {
  if (cache.has(file)) return cache.get(file);
  const { w, h, alpha } = decode(file);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const r = { w, h, bw: x1 - x0 + 1, bh: y1 - y0 + 1, bottom: y1 };
  cache.set(file, r);
  return r;
}

const man = JSON.parse(readFileSync(join(ROOT, `config/images/${id}.json`), 'utf-8'));
const cc = JSON.parse(readFileSync(join(ROOT, `config/characters/${id}.json`), 'utf-8'));
const acts = JSON.parse(readFileSync(join(ROOT, `config/actions/${id}.json`), 'utf-8')).actions;
const sizeW = cc.size.width, sizeH = cc.size.height;

console.log(`角色 ${id}　角色框 ${sizeW}x${sizeH}　显示人物高 = 包围盒高 × min(高约束/源高, 宽约束/源宽)`);
console.log('动作'.padEnd(12) + '源画布'.padEnd(12) + '缩放'.padEnd(8) + '显示人物高(最小..最大)'.padEnd(24) + '脚底余量');
for (const [aid, a] of Object.entries(acts)) {
  const targetH = a.height ?? sizeH;
  const maxW = a.width ?? sizeW;
  const names = new Set();
  for (const key of ['frames', 'rightFrames']) for (const f of a[key] || []) names.add(typeof f === 'string' ? f : f.name);
  let mn = 1e9, mx = -1, scale = 1;
  const canvases = new Set(), gaps = new Set();
  for (const n of names) {
    const rel = man[n];
    if (!rel) continue;
    const p = join(ROOT, 'assets', rel);
    let b;
    try { b = bbox(p); } catch { continue; }
    scale = Math.min(targetH / b.h, maxW / b.w);
    mn = Math.min(mn, b.bh * scale);
    mx = Math.max(mx, b.bh * scale);
    canvases.add(`${b.w}x${b.h}`);
    gaps.add(Math.round((b.h - 1 - b.bottom) * scale));
  }
  const jump = mx - mn > 3 ? '  <<< 帧间跳变' : '';
  const small = scale < 0.999 ? '  <<< 被压小' : '';
  console.log(aid.padEnd(12) + [...canvases].join(',').padEnd(12) + scale.toFixed(3).padEnd(8) +
    `${mn.toFixed(1)} .. ${mx.toFixed(1)}`.padEnd(24) + [...gaps].join(',') + jump + small);
}
