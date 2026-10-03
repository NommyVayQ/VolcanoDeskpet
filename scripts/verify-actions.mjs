// 动作 → 帧 → PNG 一致性自检（适配四类子目录结构）
// 读取：config/config.json (角色清单) + config/actions/<角色>.json + config/images/<角色>.json
// 校验项：
//   1. actions.frames 全部在 images 映射中注册
//   2. 每个 PNG 文件存在且 size > 1KB
//   3. 帧文件签名是有效 PNG
//   4. 多帧动作的「不同帧名」是否映射到同一文件路径（重复文件 = 配置顶替 bug）
//   5. 【自检告警】同一动作内帧的「画布尺寸」是否统一 —— 不统一会导致
//      ①命中框（= body 显示矩形 = 整块画布）随帧跳变，鼠标捕获区忽大忽小；
//      ②未配 width/height 时短画布帧会按比例缩放 → 角色突然变大/变小。
//      修法：node scripts/repad-frame.mjs --left n --right n --write <png>（补透明边统一画布），
//      或给动作配 width/height 后再补齐其余帧。此项算「告警」，不计入失败（不阻塞退出码）。
// 退出码：0=全过，1=有失败
import { readFileSync, existsSync, statSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');

// 从四类子目录组装出旧脚本期望的 cfg.characters / man.frames 结构
const master = JSON.parse(readFileSync(path.join(root, 'config', 'config.json'), 'utf8'));
const roles = Array.isArray(master.characters) ? master.characters : [];
const cfg = { characters: [] };
const man = { frames: {} };
for (const id of roles) {
  const act = JSON.parse(readFileSync(path.join(root, 'config', 'actions', `${id}.json`), 'utf8'));
  const img = JSON.parse(readFileSync(path.join(root, 'config', 'images', `${id}.json`), 'utf8'));
  const base = JSON.parse(readFileSync(path.join(root, 'config', 'characters', `${id}.json`), 'utf8'));
  cfg.characters.push({ id, name: base.name || id, size: base.size, actions: act.actions || {} });
  man.frames[id] = img;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
let fails = 0;
const rows = [];
const canvasWarnings = []; // 同一动作内画布尺寸不统一（告警，不阻塞）

/** 读 PNG IHDR 的画布尺寸（前 24 字节足够，无需解码） */
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

// 帧引用归一化：支持字符串 'shime1' 与对象 {name:'shime1', ms:120} 两种写法
const frameName = (f) => (typeof f === 'string' ? f : (f && typeof f.name === 'string' ? f.name : String(f)));

for (const ch of cfg.characters) {
  const ns = man.frames[ch.id] || {};
  const size = ch.size || { width: 150, height: 150 };
  for (const [actionId, def] of Object.entries(ch.actions)) {
    // 纯触发型动作（如菜单「配对」入口：pairTrigger 标记、无 frames）不是动画，跳过帧/PNG 校验
    if (!Array.isArray(def.frames)) continue;
    const sizes = [], hashes = [];
    let bad = [];
    const targetH = typeof def.height === 'number' ? def.height : size.height;
    const maxW = typeof def.width === 'number' ? def.width : size.width;
    // 四套帧集都要校验：frames/rightFrames（移动相位）与 hoverFrames/hoverRightFrames（飞行悬停相位）。
    // 以前只校验 frames，rightFrames 配错帧名不会暴露 —— 转向时才空白/缺帧。
    const sets = [['frames', def.frames]];
    if (Array.isArray(def.rightFrames)) sets.push(['rightFrames', def.rightFrames]);
    if (Array.isArray(def.hoverFrames)) sets.push(['hoverFrames', def.hoverFrames]);
    if (Array.isArray(def.hoverRightFrames)) sets.push(['hoverRightFrames', def.hoverRightFrames]);
    for (const [setName, frameList] of sets) {
      const canvases = new Set(); // 'WxH' 画布
      const displays = new Set(); // 显示盒（contain-fit / 帧 scale 之后）
      const scales = new Set();   // 缩放系数（角色是否随帧变大变小看它）
      for (const f of frameList) {
        const fn = frameName(f);
        const rel = ns[fn];
        if (!rel) { bad.push(`[missing-image ${setName}] ${fn}`); continue; }
        const p = path.join(root, 'assets', rel);
        if (!existsSync(p)) { bad.push(`[missing-file ${setName}] ${fn} -> ${rel}`); continue; }
        const st = statSync(p);
        if (st.size < 1024) { bad.push(`[too-small ${st.size}B ${setName}] ${fn}`); }
        const fd = readFileSync(p);
        if (!fd.subarray(0, 8).equals(PNG_SIG)) { bad.push(`[bad-png-sig ${setName}] ${fn}`); }
        try {
          const { w, h } = pngSize(fd);
          canvases.add(`${w}x${h}`);
          const sc = typeof f === 'object' && typeof f.scale === 'number'
            ? f.scale : Math.min(targetH / h, maxW / w);
          scales.add(sc.toFixed(2));
          displays.add(`${Math.round(w * sc)}x${Math.round(h * sc)}`);
        } catch { /* IHDR 读取失败已在 bad-png-sig 记过 */ }
        sizes.push(st.size);
        hashes.push(createHash('sha1').update(fd).digest('hex').slice(0, 8));
      }
      // 自检告警：画布 / 显示盒 / 缩放系数在同一帧集内不统一。
      // 只在同集内比：移动帧与悬停帧不会同屏出现，跨集比较无意义（且会误报）。
      if (frameList.length > 1 && (canvases.size > 1 || displays.size > 1)) {
        canvasWarnings.push(`  ${ch.id}/${actionId}[${setName}]: 画布 ${[...canvases].join(' + ')}`
          + `  显示盒 ${[...displays].join(' + ')}  缩放 ${[...scales].join(' + ')}`
          + `${displays.size > 1 ? '  ← 命中框随帧跳变' : ''}`
          + `${scales.size > 1 ? '  ← 角色随帧变大/变小' : ''}`);
      }
      if (frameList.length > 1) {
        const pathToNames = new Map();
        for (const name of frameList) {
          const fn = frameName(name);
          const rel = ns[fn];
          if (!rel) continue;
          if (!pathToNames.has(rel)) pathToNames.set(rel, []);
          pathToNames.get(rel).push(fn);
        }
        for (const [rel, names] of pathToNames) {
          const uniq = [...new Set(names)];
          if (uniq.length > 1) bad.push(`[duplicate-frame-path ${names.join('=')} -> ${rel}]`);
        }
      }
    }
    const status = bad.length === 0 ? 'OK' : 'FAIL';
    if (bad.length) fails++;
    const sizeStr = sizes.length ? sizes.map(s => s + 'B').join(',') : '-';
    const framesStr = sets
      .map(([n, l]) => l.map(frameName).join(',') + (n === 'frames' ? '' : ` [${n}]`))
      .join('  ');
    rows.push({ ch: ch.id, action: actionId, frames: framesStr, sizeStr, status, bad });
  }
}

const w = (s, n) => String(s).padEnd(n);
console.log(w('角色', 8) + w('动作', 24) + w('帧', 32) + w('文件大小', 28) + w('状态', 6) + '问题');
console.log('-'.repeat(110));
for (const r of rows) {
  const line = w(r.ch, 8) + w(r.action, 24) + w(r.frames, 32) + w(r.sizeStr, 28) + w(r.status, 6) + r.bad.join('; ');
  console.log(line);
}
console.log('-'.repeat(110));
console.log(`共 ${rows.length} 个动作，失败 ${fails} 个`);
if (canvasWarnings.length) {
  console.log(`\n⚠ 画布/显示尺寸不统一的动作 ${canvasWarnings.length} 个（告警，不阻塞；统一画布可消除命中框跳变与角色缩放）：`);
  console.log(canvasWarnings.join('\n'));
  console.log('  修法：node scripts/repad-frame.mjs --left n --right n --write <png>（左右等量补边 = 角色零位移）');
}
if (fails) process.exit(1);
