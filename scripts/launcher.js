/**
 * DeskPet 启动器（被 scripts/build-launcher.mjs 用 Node SEA 打包成项目根目录的「启动桌宠.exe」）
 *
 * 行为（用户 2026-10-11 定）：**优先 dev 模式**，dev 起不来才回退最新 release 便携版。
 *   1. dev：在根目录跑 `npm run dev`（tsc/webpack watch + electron，改源码 Ctrl+R 即生效）
 *   2. release：扫描 release/ 下版本号最高的 DeskPet-Portable-x.y.z，拉起里面的 DeskPet.exe
 *
 * 命令行参数（双击无参时按上面的默认顺序）：
 *   --dev       强制 dev 模式（缺依赖时报错，不回退）
 *   --release   强制 release 模式
 *   --list      只列出可用的启动目标，不启动
 *
 * ⚠️ SEA 约束：只能用 Node 内置模块，不能 require 任何 npm 包。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** SEA 下 process.execPath = exe 自身路径；用 node 直跑调试时退回 cwd，方便测试。 */
function projectRoot() {
  const dir = path.dirname(process.execPath);
  try {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  } catch (e) { /* ignore */ }
  return process.cwd();
}

const ROOT = projectRoot();
const RELEASE_DIR = path.join(ROOT, 'release');
const EXE_NAME = 'DeskPet.exe';

function say(msg) {
  try { console.log(msg); } catch (e) { /* SEA 隐藏控制台时 console 可能不可用 */ }
}

/** 版本号 「x.y.z」→ 可比较的整数；解析不了返回 null。 */
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  if (!m) return null;
  return Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]);
}

/** release/ 下所有可用的便携版（含版本号与 exe 路径），按版本号从高到低。 */
function listReleases() {
  let names = [];
  try { names = fs.readdirSync(RELEASE_DIR); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const m = /^DeskPet-Portable-(\d+\.\d+\.\d+)$/.exec(name);
    if (!m) continue;
    const exe = path.join(RELEASE_DIR, name, EXE_NAME);
    if (!fs.existsSync(exe)) continue;
    out.push({ name, version: m[1], rank: semver(m[1]), exe });
  }
  out.sort((a, b) => b.rank - a.rank);
  return out;
}

/** dev 模式的前提：有 package.json 的 dev 脚本 + electron 已装在本地 node_modules。 */
function devReady() {
  const pkgPath = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) return { ok: false, why: '找不到 package.json' };
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) {
    return { ok: false, why: 'package.json 解析失败' };
  }
  if (!pkg.scripts || !pkg.scripts.dev) return { ok: false, why: 'package.json 没有 dev 脚本' };
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
    return { ok: false, why: 'node_modules/electron 缺失（先 npm install）' };
  }
  return { ok: true, why: '' };
}

/** npm 是否在 PATH 上（dev 用 `npm run dev` 起，缺它就没法 dev）。 */
function npmOnPath() {
  const r = spawnSync('where', ['npm'], { windowsHide: true });
  return r.status === 0;
}

/** 指定进程名是否已在运行（用于避免重复拉起 release 版）。 */
function isRunning(imageName) {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + imageName], { windowsHide: true });
  return !!r.stdout && r.stdout.toString().toLowerCase().indexOf(imageName.toLowerCase()) >= 0;
}

function launchDev() {
  say('[启动器] 启动 dev 模式：npm run dev（tsc/webpack watch + electron）');
  say('[启动器] 改源码后在桌宠窗口按 Ctrl+R 生效；关掉弹出的控制台窗口即结束 dev。');
  const child = spawn('npm', ['run', 'dev'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    shell: true, // npm 是 .cmd，Windows 下必须经 shell 才能起
    windowsHide: false, // 保留 dev 控制台窗口，方便看 watch 输出
  });
  child.on('error', (err) => {
    say('[启动器] dev 启动失败：' + err.message);
  });
  child.unref();
  return true;
}

function launchRelease(rel) {
  if (isRunning(EXE_NAME)) {
    say('[启动器] ' + EXE_NAME + ' 已在运行，不再重复拉起。');
    return true;
  }
  say('[启动器] 启动 release 便携版：' + rel.name);
  const child = spawn(rel.exe, [], {
    cwd: path.dirname(rel.exe),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => { say('[启动器] release 启动失败：' + err.message); });
  child.unref();
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const forceDev = args.indexOf('--dev') >= 0;
  const forceRelease = args.indexOf('--release') >= 0;
  const listOnly = args.indexOf('--list') >= 0;

  say('[启动器] 项目根目录：' + ROOT);

  const releases = listReleases();
  if (listOnly) {
    const d = devReady();
    say('[启动器] dev 模式：' + (d.ok ? '可用' : '不可用（' + d.why + '）'));
    if (releases.length === 0) say('[启动器] release：无可用便携版');
    else releases.forEach((r, i) => say('[启动器] release[' + i + ']：' + r.name + (i === 0 ? '  ← 最新' : '')));
    return 0;
  }

  // —— 1) dev（默认优先）——
  if (!forceRelease) {
    const d = devReady();
    if (!d.ok) {
      say('[启动器] dev 不可用：' + d.why);
    } else if (!npmOnPath()) {
      say('[启动器] dev 不可用：PATH 上找不到 npm');
    } else {
      launchDev();
      return 0;
    }
    if (forceDev) { say('[启动器] 已指定 --dev，不回退 release。'); return 1; }
    say('[启动器] 回退 release 便携版…');
  }

  // —— 2) release ——
  if (releases.length === 0) {
    say('[启动器] 失败：release/ 下没有可用的 ' + EXE_NAME + '（先 npm run repack-portable 组装一版）');
    return 1;
  }
  launchRelease(releases[0]);
  return 0;
}

const code = main();
// 双击进来时控制台会随进程退出而关闭，留 1.5s 让人看见上面几行
setTimeout(() => process.exit(code), 1500);
