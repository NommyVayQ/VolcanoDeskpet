// 把「补帧」(sup) 编排进合体流程：
//   - 莫娜的补帧 -> 追加到她的做饭动作（cookXxx）之后（递出去）
//   - 其他人的补帧 -> 插入到各自 eat 之前（接过来吃）
//   - 露丝/莫娜的唱歌配对不动（那是双人各自播 sing，不涉及做饭）
// 补帧段总时长统一 = 3 帧长度 = 2400ms（按默认 frameMs 800 折算），按帧数均分。
// 幂等：已含补帧的动作跳过。
import fs from 'fs';
import path from 'path';

const ROOT = 'D:/Code/deskpet';
const DIR = path.join(ROOT, 'config/actions');
const WRITE = process.argv.includes('--write');
const SUP_MS = 2400; // ≈ 3 帧

const frameName = (f) => (typeof f === 'string' ? f : f.name);

/** 取某角色可用的补帧帧名（按 L/R 分侧），返回 [[L帧...],[R帧...]] */
function supFrames(id) {
  const dic = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/images', `${id}.json`), 'utf8'));
  const has = (k) => !!dic[k];
  const L = [], R = [];
  for (let n = 1; n <= 4; n++) { if (has(`L-sup-${n}`)) L.push(`L-sup-${n}`); else break; }
  for (let n = 1; n <= 4; n++) { if (has(`R-sup-${n}`)) R.push(`R-sup-${n}`); else break; }
  return { L, R };
}

/** 把一组帧名摊成均分 SUP_MS 的帧对象序列 */
function spread(names) {
  if (names.length === 0) return [];
  const each = Math.round(SUP_MS / names.length);
  return names.map((name) => ({ name, ms: each }));
}

/** 去掉已有补帧，返回清理后的帧数组 */
function stripSup(frames) {
  return (frames || []).filter((f) => !/^(L|R)-sup-\d+$/.test(frameName(f)));
}

const report = [];
const edit = (file, fn) => {
  const p = path.join(DIR, file);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(j.actions);
  if (WRITE) fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
};

// ---- 1) 莫娜：做饭动作之后追加补帧 ----
const monaSup = supFrames('mona');
edit('mona.json', (A) => {
  for (const key of ['cookBread', 'cookMeat', 'cookIce', 'cookMilk', 'cookWine']) {
    const a = A[key];
    if (!a) { report.push(`[miss] mona/${key}`); continue; }
    const before = a.frames.length;
    a.frames = [...stripSup(a.frames), ...spread(monaSup.L)];
    a.rightFrames = [...stripSup(a.rightFrames), ...spread(monaSup.R)];
    report.push(`mona/${key}: ${before} -> ${a.frames.length} 帧（尾部补 ${monaSup.L.length} 帧 / ${SUP_MS}ms）`);
  }
});

// ---- 2) 其他角色：eat 之前插入补帧 ----
for (const id of ['rose', 'nina', 'rebeza', 'gwen']) {
  const sup = supFrames(id);
  edit(`${id}.json`, (A) => {
    const a = A.eat;
    if (!a) { report.push(`[miss] ${id}/eat`); return; }
    const before = a.frames.length;
    a.frames = [...spread(sup.L), ...stripSup(a.frames)];
    a.rightFrames = [...spread(sup.R), ...stripSup(a.rightFrames)];
    report.push(`${id}/eat: ${before} -> ${a.frames.length} 帧（头部补 ${sup.L.length} 帧 / ${SUP_MS}ms）`);
  });
}

// ---- 3) 确认唱歌配对未被改动 ----
report.push('');
report.push('未改动（唱歌配对不涉及做饭/吃饭）：rose/sing、mona/sing');

console.log(report.join('\n'));
console.log(WRITE ? '\n已写入' : '\n(dry-run，加 --write 落盘)');
