#!/usr/bin/env node
/**
 * 给 PNG 补透明边（统一同一动作内的画布尺寸），用于消除「命中框随帧跳变 / 角色随帧缩放」。
 *
 * 背景：`applySpriteSize` 的 contain-fit 用**画布**尺寸算显示尺寸：
 *   - 同一动作里画布不统一 → 命中框（= body 显示矩形）跟着跳，鼠标捕获区忽大忽小；
 *   - 若动作显式配了 width/height 而未配的短帧会按比例缩小 → 角色突然变小。
 * 补透明边（不改任何可见像素）把画布补齐到同一尺寸即可根治。
 *
 * 补边对「角色在屏幕上的位置」的影响（关键公式）：
 *   targetH = actionDef.height ?? size.height ；maxW = actionDef.width ?? size.width
 *   显示宽 scale 缩放后，body 水平居中于容器 → 内容局部坐标 shift = (padLeft − padRight) / 2
 *   故 **左右等量补边（padLeft == padRight）时角色零位移**，只把命中框撑到新画布宽度。
 *
 * 用法：
 *   node scripts/repad-frame.mjs --left 15 --right 15 assets/gwen/L-work-1.png ...        # 预演（默认不写文件）
 *   node scripts/repad-frame.mjs --left 15 --right 15 --write assets/gwen/L-work-1.png   # 真正写入（原地覆盖）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ---------- PNG 解码（8bit RGBA / 非隔行） ---------- */
function decodeRGBA(file) {
  const b = fs.readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  if (b[24] !== 8 || b[25] !== 6 || b[28] !== 0) throw new Error('仅支持 8bit RGBA 非隔行 PNG: ' + file);
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
  const px = Buffer.alloc(h * stride);
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
    cur.copy(px, y * stride);
    prev = cur;
  }
  return { w, h, px };
}

/* ---------- PNG 编码（全 0 滤波器，最保守） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodeRGBA(w, h, px) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 非透明 bbox（alpha > 8） */
function alphaBBox({ w, h, px }) {
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
  return maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ---------- 主流程 ---------- */
const argv = process.argv.slice(2);
const num = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? parseInt(argv[i + 1], 10) : 0; };
const padL = num('--left'), padR = num('--right'), padT = num('--top'), padB = num('--bottom');
const write = argv.includes('--write');
const files = argv.filter((a, i) => !a.startsWith('--') && !['--left', '--right', '--top', '--bottom'].includes(argv[i - 1]));

if (!files.length || (padL + padR + padT + padB) === 0) {
  console.log('用法: node scripts/repad-frame.mjs --left 15 --right 15 [--top n] [--bottom n] [--write] <png...>');
  process.exit(1);
}

for (const f of files) {
  const abs = path.resolve(f);
  let img;
  try { img = decodeRGBA(abs); } catch (e) { console.log(`✗ ${f}: ${e.message}`); continue; }
  const nw = img.w + padL + padR, nh = img.h + padT + padB;
  const before = alphaBBox(img);
  // 目标画布 + 内容平移
  const out = Buffer.alloc(nw * nh * 4); // 全透明
  for (let y = 0; y < img.h; y++) {
    img.px.copy(out, ((y + padT) * nw + padL) * 4, y * img.w * 4, (y + 1) * img.w * 4);
  }
  const after = alphaBBox({ w: nw, h: nh, px: out });
  // 自校验 1：内容整体平移 (padL, padT)，可见像素逐字节相同
  const shiftedOK = before && after
    && after.minX === before.minX + padL && after.maxX === before.maxX + padL
    && after.minY === before.minY + padT && after.maxY === before.maxY + padT;
  let pixelsOK = true;
  if (before) {
    for (let y = before.minY; y <= before.maxY && pixelsOK; y++) {
      for (let x = before.minX; x <= before.maxX; x++) {
        const s = (y * img.w + x) * 4;
        const d = ((y + padT) * nw + (x + padL)) * 4;
        if (img.px[s] !== out[d] || img.px[s + 1] !== out[d + 1] || img.px[s + 2] !== out[d + 2] || img.px[s + 3] !== out[d + 3]) {
          pixelsOK = false; break;
        }
      }
    }
  }
  // 自校验 2：编码器产物写盘后能被重新解码，且像素与原缓冲逐字节一致
  const buf = encodeRGBA(nw, nh, out);
  const tmp = abs + '.repad-check.tmp.png';
  fs.writeFileSync(tmp, buf);
  let rt = null;
  try { rt = decodeRGBA(tmp); } catch (e) { console.log(`✗ ${f}: 编码产物无法解码 ${e.message}`); fs.unlinkSync(tmp); continue; }
  const roundTripOK = rt.w === nw && rt.h === nh && rt.px.equals(out);
  fs.unlinkSync(tmp);

  const shift = (padL - padR) / 2;
  console.log(`${write ? '写入' : '预演'} ${path.relative(process.cwd(), abs)}: ${img.w}x${img.h} → ${nw}x${nh}`
    + `  可见内容 ${before ? `[${before.minX},${before.minY}]-[${before.maxX},${before.maxY}] → [${after.minX},${after.minY}]-[${after.maxX},${after.maxY}]` : '（全透明）'}`
    + `  角色局部位移 ${shift}px`
    + `  平移校验 ${shiftedOK && pixelsOK ? 'OK' : '✗失败'}  编码回读校验 ${roundTripOK ? 'OK' : '✗失败'}`);
  if (!(shiftedOK && pixelsOK && roundTripOK)) { console.log('  → 校验未通过，跳过该文件'); continue; }
  if (shift === 0) console.log('  ✓ 左右等量补边：角色零位移（仅命中框变宽）');
  else console.log(`  ⚠ 左右不等量：角色会横移 ${shift}px（确认这是你要的再写）`);
  if (write) { fs.writeFileSync(abs, buf); console.log('  已写入'); }
}
if (!write) console.log('\n（预演模式，未改动任何文件；确认无误后加 --write）');
