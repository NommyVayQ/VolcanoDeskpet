#!/usr/bin/env node
/**
 * measure-coop-sprite.mjs —— 只读探针：测合体帧(双人合照)里两个角色的水平中心，
 * 换算成「相对画布中心的偏移」，用来给合体吸附定位提供精确数据。
 *
 * 背景（2026-10-02 用户）：
 *   「后加的合体动作开始和结束时还是有位置偏差，结束时妮娜和莫娜的做奶冻就很好，对齐这个」
 *   maintainCoopSnap 与 maintainSnap 几何逐字相同（真实落位点一致），
 *   但合照 sprite 是 221 宽、内部两人只隔 ~107px，而自然站位是 180px ——
 *   进出合体时「贴图里的角色」与「真实角色」对不上，产生 pop。
 *   要消除 pop，必须知道 sprite 里左右角色相对画布中心的横向偏移。
 *
 * 用法：node scripts/measure-coop-sprite.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACT_DIR = path.join(ROOT, 'config', 'actions');
const IMG_DIR = path.join(ROOT, 'config', 'images');
const ASSETS = path.join(ROOT, 'assets');

const PY = 'C:/Users/NommyVayQ/.workbuddy/binaries/python/versions/3.13.12/python.exe';

const pyro = String.raw`
import sys, json
from PIL import Image
paths = json.loads(sys.argv[1])
out = []
for p in paths:
    try:
        im = Image.open(p).convert('RGBA')
    except Exception as e:
        out.append({'path': p, 'err': str(e)}); continue
    w, h = im.size
    px = im.load()
    # 每列是否有不透明像素
    cols = []
    for x in range(w):
        has = False
        for y in range(0, h, 2):
            if px[x, y][3] > 24:
                has = True; break
        cols.append(has)
    # 用「空列」把行内切成若干 blob，取最宽的两个视为两个角色
    blobs = []
    x = 0
    while x < w:
        if cols[x]:
            s = x
            while x < w and cols[x]:
                x += 1
            blobs.append((s, x - 1))
        else:
            x += 1
    # 合并间距很小的碎片（<6px）视为同一个角色
    merged = []
    for b in blobs:
        if merged and b[0] - merged[-1][1] <= 6:
            merged[-1] = (merged[-1][0], b[1])
        else:
            merged.append(list(b))
    merged = [tuple(m) for m in merged]
    info = {'path': p, 'w': w, 'h': h, 'blobs': merged}
    out.append(info)
print(json.dumps(out, ensure_ascii=False))
`;

const ids = ['rose', 'nina', 'rebeza', 'mona', 'gwen'];
const images = {};
for (const id of ids) {
  const p = path.join(IMG_DIR, `${id}.json`);
  if (fs.existsSync(p)) images[id] = JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 收集所有 coop 动作的首帧路径（去重）
const jobs = []; // {char, act, frameIdx, name, file}
for (const id of ids) {
  const ap = path.join(ACT_DIR, `${id}.json`);
  if (!fs.existsSync(ap)) continue;
  const acts = JSON.parse(fs.readFileSync(ap, 'utf8')).actions || {};
  for (const [actId, def] of Object.entries(acts)) {
    if (!def || !def.coop) continue;
    const names = (def.frames || []).map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean);
    const name = names[0];
    const rel = images[id]?.[name];
    if (!rel) { console.log(`  (skip) ${id}/${actId} 帧 ${name} 无图片映射`); continue; }
    jobs.push({ char: id, act: actId, name, file: path.join(ASSETS, rel) });
  }
}

const uniq = new Map();
for (const j of jobs) if (!uniq.has(j.file)) uniq.set(j.file, j);
const list = [...uniq.values()];

const res = spawnSync(PY, ['-c', pyro, JSON.stringify(list.map((j) => j.file))], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (res.status !== 0) { console.error(res.stderr || 'python failed'); process.exit(1); }
const measured = JSON.parse(res.stdout);
const byFile = new Map(measured.map((m) => [m.path, m]));

console.log('合体帧首帧中「两角色相对画布中心的水平偏移」测量：\n');
console.log('角色/动作'.padEnd(26) + '帧'.padEnd(16) + '画布'.padEnd(10) + '两blob(绝对px)'.padEnd(22) + 'blob中心'.padEnd(20) + '相对中心偏移');
for (const j of list) {
  const m = byFile.get(j.file);
  if (!m) continue;
  if (m.err) { console.log(`${(j.char + '/' + j.act).padEnd(26)}ERR ${m.err}`); continue; }
  const bs = m.blobs;
  const cx = m.w / 2;
  const centers = bs.map((b) => (b[0] + b[1]) / 2);
  const blobStr = bs.map((b) => `${b[0]}~${b[1]}`).join(' | ');
  const offStr = centers.map((c) => (c - cx).toFixed(1)).join(' | ');
  console.log(
    `${(j.char + '/' + j.act).padEnd(26)}`
    + `${j.name.padEnd(16)}`
    + `${(m.w + 'x' + m.h).padEnd(10)}`
    + `${blobStr.padEnd(22)}`
    + `${centers.map((c) => c.toFixed(1)).join(' | ').padEnd(20)}`
    + `${offStr}`
  );
}
