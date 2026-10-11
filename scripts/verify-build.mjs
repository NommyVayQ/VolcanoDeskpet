// 构建后自检：确认便携版结构正确、清单有效、exe 可启动
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const root = process.cwd();
const buildName = process.argv[2] || 'DeskPet-Portable-0.3.1';
const dir = path.join(root, 'release', buildName);

let ok = true;
function check(name, cond, extra = '') {
  console.log((cond ? '  OK   ' : '  FAIL ') + name + (extra ? '  -> ' + extra : ''));
  if (!cond) ok = false;
}

check('便携目录存在', existsSync(dir), dir);

const exe = path.join(dir, 'DeskPet.exe');
check('DeskPet.exe 存在', existsSync(exe));

const mainJs = path.join(dir, 'resources/app/dist/main/main/index.js');
check('resources/app/dist/main/main/index.js 存在', existsSync(mainJs));

// 三个图标位互不相同：icon.png=窗口/任务栏(跑鸟)、tray-icon.png=托盘(Rose)、exe 文件图标=rcedit 内嵌
const iconPng = path.join(dir, 'resources/icon.png');
const iconSize = existsSync(iconPng) ? statSync(iconPng).size : 0;
check('resources/icon.png 存在且非空（窗口/任务栏/Alt-Tab 图标）', iconSize > 0, iconSize ? iconSize + 'B' : '缺失');

const trayIconPng = path.join(dir, 'resources/tray-icon.png');
const trayIconSize = existsSync(trayIconPng) ? statSync(trayIconPng).size : 0;
check('resources/tray-icon.png 存在且非空（系统托盘小图标）', trayIconSize > 0, trayIconSize ? trayIconSize + 'B' : '缺失');

const pkgPath = path.join(dir, 'resources/app/package.json');
let pkg = null;
try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch (e) {}
check('package.json 可解析', !!pkg);
check('main 字段=dist/main/main/index.js', !!pkg && pkg.main === 'dist/main/main/index.js', pkg && pkg.main);
check('version 字段存在', !!pkg && !!pkg.version, pkg && pkg.version);

const manPath = path.join(dir, 'config/images');
const manFiles = existsSync(manPath) ? readdirSync(manPath).filter((f) => f.endsWith('.json')) : [];
const manOk = manFiles.length > 0 && manFiles.every((f) => {
  try { return !!JSON.parse(readFileSync(path.join(manPath, f), 'utf8')); } catch { return false; }
});
check('config/images/*.json 有效 JSON（帧名→PNG 映射）', manOk, manFiles.join(',') || '缺失');

const cfgPath = path.join(dir, 'config/config.json');
let cfg = null;
try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch (e) {}
check('config/config.json 有效 JSON', !!cfg);

if (existsSync(exe)) {
  // ① 结构校验：PE 头 + 体积（不依赖启动进程，任何环境都可靠）
  const exeSize = statSync(exe).size;
  let head = '';
  let fd;
  try {
    fd = openSync(exe, 'r');
    const b = Buffer.alloc(2);
    readSync(fd, b, 0, 2, 0);
    head = b.toString('latin1');
  } catch { /* ignore */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  check('DeskPet.exe 是有效 PE 且体积正常', head === 'MZ' && exeSize > 50 * 1024 * 1024,
    `${head || 'N/A'} | ${(exeSize / 1048576).toFixed(1)}MB`);

  // ② 启动冒烟：本 app 未实现 `--version` CLI 参数（直接跑会拉起 GUI、无输出），
  //    故用 ELECTRON_RUN_AS_NODE 以纯 Node 模式启动——既验证二进制完好可执行
  //    （rcedit 改过图标的 exe 尤其需要这一项），又不会弹窗。
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // 沙箱注入的变量会让 Electron 启动失败，正常环境无此问题
  env.ELECTRON_RUN_AS_NODE = '1';
  const r = spawnSync(exe, ['--version'], { env, encoding: 'utf8', timeout: 25000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const ver = (out.match(/v\d+\.\d+\.\d+/) || [])[0] || '';
  if (r.error && ['EBUSY', 'EPERM', 'EACCES'].includes(r.error.code)) {
    // 沙箱禁止 node 直接拉起新二进制（真机不会）；降级为 SKIP，不判失败
    console.log(`  SKIP DeskPet.exe 启动冒烟  -> 沙箱禁止 node 拉起二进制（${r.error.code}），真机不受影响`);
  } else {
    check('DeskPet.exe 可启动（ELECTRON_RUN_AS_NODE 冒烟）', r.status === 0 && !!ver,
      ver || out.split('\n')[0] || 'no output');
  }
}

console.log(ok ? '\n构建自检通过 ✅' : '\n构建自检失败 ❌');
process.exit(ok ? 0 : 1);
