// 生成示意帧 PNG（不依赖任何第三方库）。
// 输出：assets/nina/{shime1,shime2,shime3}.png（单人，含左右朝向示意）
//       assets/rose/{shime1,shime2,shime3}.png
//       assets/coop/hug_nina.png（合体帧：nina 在左抱 rose，rose 已在帧里）
//       assets/coop/hug_rose.png（合体帧：rose 在左抱 nina）
// 纯手绘像素：用简单几何画一个"小人" + 拥抱双人。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', 'assets');

// CRC32（PNG 需要）
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePNG(width, height, rgba) {
  // rgba: Buffer of width*height*4
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // add filter byte (0) per row
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 画一个"小人"到 rgba buf（cx,cy 中心，color 主体色，facing 朝向只影响眼睛位置示意）
function drawPerson(rgba, W, H, cx, cy, bodyColor, faceColor, facing) {
  const r = Math.min(W, H) * 0.18;
  // 身体（圆角矩形近似：椭圆）
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / r;
      const dy = (y - cy) / (r * 1.3);
      if (dx * dx + dy * dy <= 1) {
        const idx = (y * W + x) * 4;
        rgba[idx] = (bodyColor >> 16) & 0xff;
        rgba[idx + 1] = (bodyColor >> 8) & 0xff;
        rgba[idx + 2] = bodyColor & 0xff;
        rgba[idx + 3] = 255;
      }
    }
  }
  // 眼睛（朝向一侧）
  const ex = facing > 0 ? cx + r * 0.4 : cx - r * 0.4;
  const ey = cy - r * 0.3;
  for (const [ox, oy] of [[0, 0], [r * 0.35, 0]]) {
    const x0 = Math.round(ex + ox), y0 = Math.round(ey + oy);
    for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) {
      const x = x0 + xx, y = y0 + yy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const idx = (y * W + x) * 4;
      rgba[idx] = (faceColor >> 16) & 0xff;
      rgba[idx + 1] = (faceColor >> 8) & 0xff;
      rgba[idx + 2] = faceColor & 0xff;
      rgba[idx + 3] = 255;
    }
  }
}

function solidBg(W, H) {
  // 全透明背景
  return Buffer.alloc(W * H * 4, 0);
}

function writePNG(rel, W, H, paint) {
  const rgba = solidBg(W, H);
  paint(rgba, W, H);
  const buf = makePNG(W, H, rgba);
  const abs = path.join(ASSETS, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  console.log('wrote', rel, W + 'x' + H);
}

const W = 120, H = 150;
const NINA = 0xff8a8a, ROSE = 0x8ab4ff, FACE = 0x333333;

// 单人帧（nina / rose），3 帧做轻微位移示意（手臂抬起不同高度）
for (const [char, color] of [['nina', NINA], ['rose', ROSE]]) {
  for (let f = 1; f <= 3; f++) {
    writePNG(`${char}/shime${f}.png`, W, H, (rgba, w, h) => {
      drawPerson(rgba, w, h, w / 2, h * 0.55, color, FACE, 1);
    });
  }
}

// 合体拥抱帧：双人同框，左抱右。
// hug_nina：nina 在左(lead=nina) 抱 rose。hug_rose：rose 在左(lead=rose) 抱 nina。
function drawHug(rgba, w, h, leftColor, rightColor) {
  // 左侧人（抱人者）
  drawPerson(rgba, w, h, w * 0.32, h * 0.55, leftColor, FACE, 1);
  // 右侧人（被抱者）
  drawPerson(rgba, w, h, w * 0.68, h * 0.55, rightColor, FACE, -1);
  // 手臂（连线示意拥抱）：左侧人右臂伸向右侧人
  for (let t = 0; t <= 1; t += 0.02) {
    const x = Math.round(w * 0.32 + (w * 0.68 - w * 0.32) * t);
    const y = Math.round(h * 0.5 + Math.sin(t * Math.PI) * -10);
    for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) {
      const px = x + xx, py = y + yy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const idx = (py * w + px) * 4;
      rgba[idx] = (leftColor >> 16) & 0xff;
      rgba[idx + 1] = (leftColor >> 8) & 0xff;
      rgba[idx + 2] = leftColor & 0xff;
      rgba[idx + 3] = 255;
    }
  }
}
const COOPW = 220, COOPH = 150;
writePNG('coop/hug_nina.png', COOPW, COOPH, (rgba, w, h) => drawHug(rgba, w, h, NINA, ROSE));
writePNG('coop/hug_rose.png', COOPW, COOPH, (rgba, w, h) => drawHug(rgba, w, h, ROSE, NINA));

console.log('done');
