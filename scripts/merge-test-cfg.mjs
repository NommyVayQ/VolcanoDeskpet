// 合并「桌宠测试版」的调参更新到当前版本。
//
// 策略：只同步「纯调参字段」白名单（动画手感 / 时长 / 位移 / 菜单排序），
// 绝不覆盖「结构性 / 正确性」字段（pairId、label、menu、menuGroup、pairTrigger、
// pairWith、frames、rightFrames、dialogue、coop、behavior…）。
//
// 原因：测试版是较旧快照，缺失当前版已修好的 bug（pairId 随机回退、rose↔rebeza
// 帧数对齐）。无脑覆盖会把已修 bug 引回来。本脚本只把用户在测试版里做的手感微调
// 带进来，保留当前版的修复与文案。
//
// 用法：node scripts/merge-test-cfg.mjs           # dry-run，只打印差异
//       node scripts/merge-test-cfg.mjs --write  # 落盘

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TEST = path.join(ROOT, 'release/桌宠测试版/config');
const CUR = path.join(ROOT, 'config');
const WRITE = process.argv.includes('--write');

// 纯调参白名单：这些字段从测试版取（若有差异）
const TUNE = ['frameMs', 'durationMs', 'loopCount', 'offset', 'moveSpeed', 'flyCeiling', 'climb', 'menuOrder'];

const CHARS = ['rose', 'nina', 'rebeza', 'mona', 'gwen'];

function load(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

let changed = 0;
const report = [];

for (const c of CHARS) {
  const t = load(path.join(TEST, 'actions', `${c}.json`));
  const curPath = path.join(CUR, 'actions', `${c}.json`);
  const cur = load(curPath);
  if (!t || !cur) { console.log(`[${c}] 读取失败，跳过`); continue; }
  const ta = t.actions || {}, ca = cur.actions || {};
  for (const id of Object.keys(ca)) {
    if (!ta[id]) continue;
    for (const f of TUNE) {
      const tv = JSON.stringify(ta[id][f] ?? null);
      const cv = JSON.stringify(ca[id][f] ?? null);
      if (tv !== cv) {
        changed++;
        report.push(`[${c}.${id}] ${f}: 当前=${cv.length > 80 ? cv.slice(0, 80) + '…' : cv}  → 测试=${tv.length > 80 ? tv.slice(0, 80) + '…' : tv}`);
        if (WRITE) ca[id][f] = ta[id][f];
      }
    }
  }
  if (WRITE) {
    fs.writeFileSync(curPath, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  }
}

// config.json 的 window.* 也同步（测试版若有更新）
const tc = load(path.join(TEST, 'config.json'));
const ccPath = path.join(CUR, 'config.json');
const cc = load(ccPath);
if (tc && cc && tc.window && cc.window) {
  const wkeys = Object.keys(tc.window);
  let wc = 0;
  for (const k of wkeys) {
    if (JSON.stringify(tc.window[k]) !== JSON.stringify(cc.window[k])) {
      wc++; changed++;
      report.push(`[config.window.${k}] 当前=${JSON.stringify(cc.window[k])} → 测试=${JSON.stringify(tc.window[k])}`);
      if (WRITE) cc.window[k] = tc.window[k];
    }
  }
  if (WRITE && wc > 0) fs.writeFileSync(ccPath, JSON.stringify(cc, null, 2) + '\n', 'utf8');
}

console.log(WRITE ? `=== 已落盘，共 ${changed} 处字段更新 ===` : `=== dry-run，共 ${changed} 处字段差异（加 --write 落盘）===`);
for (const r of report) console.log('  ' + r);
if (report.length === 0) console.log('  （无差异）');
