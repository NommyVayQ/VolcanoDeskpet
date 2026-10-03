// 量出某角色「合体收尾默认帧(L-stand)」身体在画布里的左右偏移，
// 供 endCoop 用「身体边缘」而非「画布边缘」算间距。输出 px（已换算到角色框 size.width 空间）。
import { readFileSync } from 'fs';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ids = process.argv.slice(2);

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

function bbox(file) {
  const { w, h, alpha } = decode(file);
  let x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  return { w, h, x0, x1 };
}

for (const id of ids) {
  const man = JSON.parse(readFileSync(join(ROOT, `config/images/${id}.json`), 'utf-8'));
  const cc = JSON.parse(readFileSync(join(ROOT, `config/characters/${id}.json`), 'utf-8'));
  const frame = 'L-stand';
  const rel = man[frame];
  if (!rel) { console.log(`${id}: 找不到 ${frame}`); continue; }
  const b = bbox(join(ROOT, 'assets', rel));
  const sizeW = cc.size.width;
  const fLeft = b.x0 / b.w;
  const fRightMargin = (b.w - 1 - b.x1) / b.w;
  const leftPx = Math.round(fLeft * sizeW);
  const rightMarginPx = Math.round(fRightMargin * sizeW);
  console.log(`${id} ${frame}: 源画布 ${b.w}x${b.h} 身体x[${b.x0}..${b.x1}]`);
  console.log(`   左缘偏移 fLeft=${fLeft.toFixed(3)} → ${leftPx}px(角色框空间)  右缘留白 ${rightMarginPx}px`);
  console.log(`   建议 coopBodyInsetX = ${leftPx}  (lead朝右时内缘=角色框-该值=${(sizeW - leftPx)}px)`);
}
