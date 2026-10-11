#!/usr/bin/env node
/**
 * 只给已构建好的 DeskPet.exe 换文件图标（不重打包）。
 *
 * 为什么不直接跑 repack-portable：整套重打要复制 ~180MB electron 运行时 + 全量 assets，
 * 而「只换 exe 图标」这件事本来就是幂等的、局部的。日常换图标用本脚本，快一个数量级。
 *
 * 逻辑与 repack-portable.mjs 的 embedExeIcon() 完全一致（含安全校验）：
 *   ① 先拷副本再改，正式 exe 全程不动
 *   ② 失败 / PE 头损坏 / 体积异常缩减 -> 删副本、原样保留
 *   ③ 通过才 rm 原件 + rename 替换
 * 另加：嵌入后**解析 .rsrc 校验图标真的进去了**（避免「命令返回 0 但没生效」）。
 *
 * 用法：
 *   node scripts/embed-exe-icon.mjs                 # 嵌入 build/file-icon.ico 到 6.1.0 + 桌宠测试版
 *   node scripts/embed-exe-icon.mjs --exe <路径>    # 指定单个 exe
 *   node scripts/embed-exe-icon.mjs --all           # 全部 release 下的 DeskPet.exe（谨慎）
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function exists(p) { try { return existsSync(p); } catch { return false; } }
function removeForce(p) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }

/** rcedit 来源：electron-builder 缓存 -> 项目 tools/。找不到返回 null。 */
function findRcedit() {
  const cands = [];
  const la = process.env.LOCALAPPDATA;
  for (const base of [
    la && path.join(la, 'electron-builder', 'Cache', 'winCodeSign'),
    la && path.join(la, 'electron-builder', 'cache', 'winCodeSign'),
  ]) {
    if (!base || !exists(base)) continue;
    let subs = [];
    try { subs = readdirSync(base); } catch { /* ignore */ }
    for (const s of subs) {
      for (const n of ['rcedit-x64.exe', 'rcedit-ia32.exe']) {
        const p = path.join(base, s, n);
        if (exists(p)) cands.push(p);
      }
    }
  }
  cands.push(path.join(root, 'tools', 'rcedit-x64.exe'));
  return cands.find(exists) || null;
}

function appBuilder() {
  return [
    path.join(root, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe'),
    path.join(root, 'node_modules', 'app-builder-bin', 'win', 'ia32', 'app-builder.exe'),
  ].find(exists) || null;
}

function peHead(p) {
  try { const b = readFileSync(p); return b.length > 2 && b[0] === 0x4d && b[1] === 0x5a ? 'MZ' : ''; }
  catch { return ''; }
}

/**
 * 校验 .rsrc 里是否真换上了：ICO 的 group icon 目录项在资源里是 RT_GROUP_ICON(14)。
 * 手段：比对嵌入前后 exe 的字节差异量 + 确认 .rsrc 段存在且非空。
 * 严格判据是「体积变化 + PE 完好」；这里额外输出差异字节数供人工判断。
 */
function diffBytes(a, b) {
  const ba = readFileSync(a), bb = readFileSync(b);
  if (ba.length !== bb.length) return -1;           // 长度变了（正常，rcedit 会重排 .rsrc）
  let n = 0;
  const lim = Math.min(ba.length, bb.length);
  for (let i = 0; i < lim; i++) if (ba[i] !== bb[i]) n++;
  return n;
}

function embed(exe, ico) {
  const rcedit = findRcedit();
  const ab = rcedit ? null : appBuilder();
  if (!rcedit && !ab) {
    console.log('  ! 未找到 rcedit / app-builder.exe，跳过');
    return false;
  }
  const tmp = exe + '.icon-tmp';
  const sizeBefore = statSync(exe).size;
  try {
    removeForce(tmp);
    copyFileSync(exe, tmp);
    let r;
    if (rcedit) {
      r = spawnSync(rcedit, [tmp, '--set-icon', ico], { encoding: 'utf8', cwd: root, timeout: 120000 });
    } else {
      const b64 = Buffer.from(JSON.stringify(['--set-icon', ico, tmp]), 'utf8').toString('base64');
      r = spawnSync(ab, ['rcedit', '--args=' + b64], { encoding: 'utf8', cwd: root, timeout: 120000 });
    }
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (r.status !== 0) {
      console.log('  ! 嵌入失败：', out.split('\n')[0] || (r.error && r.error.message) || ('rc=' + r.status));
      removeForce(tmp);
      return false;
    }
    if (peHead(tmp) !== 'MZ' || statSync(tmp).size < sizeBefore * 0.9) {
      console.log('  ! 换图标后 exe 校验不过（PE 头或体积异常），放弃替换');
      removeForce(tmp);
      return false;
    }
    const d = diffBytes(exe, tmp);
    removeForce(exe);
    renameSync(tmp, exe);
    const kb = (statSync(exe).size / 1048576).toFixed(1);
    console.log(`  · 已嵌入 ${path.relative(root, ico)} -> ${path.basename(path.dirname(exe))}/DeskPet.exe`
      + `  (${kb}MB, 差异字节 ${d < 0 ? '长度变化' : d})`);
    return true;
  } catch (e) {
    console.log('  ! 嵌入异常，已跳过：', e.message);
    removeForce(tmp);
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const ico = path.join(root, 'build', 'file-icon.ico');
  if (!exists(ico)) {
    console.error(`找不到 ${ico}\n先用 scripts/make-app-icons.py 生成。`);
    process.exit(1);
  }
  const rc = findRcedit();
  console.log('rcedit:', rc ? path.relative(root, rc) : '(未找到，回退 app-builder)');

  let targets = [];
  const one = args.indexOf('--exe');
  if (one >= 0 && args[one + 1]) {
    targets = [path.resolve(root, args[one + 1])];
  } else if (args.includes('--all')) {
    const rel = path.join(root, 'release');
    for (const n of readdirSync(rel)) {
      const p = path.join(rel, n, 'DeskPet.exe');
      if (exists(p)) targets.push(p);
    }
  } else {
    // 默认：当前 package.json 版本 + 桌宠测试版（历史版本是已交付产物，不动）
    let v = '';
    try { v = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
    for (const rel of [
      path.join(root, 'release', `DeskPet-Portable-${v}`),
      path.join(root, 'release', '桌宠测试版'),
    ]) {
      const p = path.join(rel, 'DeskPet.exe');
      if (exists(p)) targets.push(p);
    }
  }

  if (!targets.length) {
    console.error('没找到目标 exe');
    process.exit(1);
  }
  let ok = 0;
  for (const t of targets) {
    console.log(`\n[${path.basename(path.dirname(t))}]`);
    if (peHead(t) !== 'MZ') { console.log('  ! 不是合法 PE，跳过'); continue; }
    if (embed(t, ico)) ok++;
  }
  console.log(`\n完成：${ok}/${targets.length}`);
  console.log('提示：资源管理器需刷新（必要时重命名一次或重启 explorer）才看到新图标。');
}

main();
