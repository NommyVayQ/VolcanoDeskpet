// 构建后自检：确认便携版结构正确、清单有效、exe 可启动
import { existsSync, readFileSync, readdirSync } from 'fs';
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
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // 沙箱注入的变量会让 Electron 启动失败，正常环境无此问题
  const r = spawnSync(exe, ['--version'], { env, encoding: 'utf8', timeout: 25000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ver = (out.match(/v\d+\.\d+\.\d+/) || [])[0] || '';
  check('DeskPet.exe --version 可执行', r.status === 0 && !!ver, ver || out.trim().split('\n')[0] || 'no output');
}

console.log(ok ? '\n构建自检通过 ✅' : '\n构建自检失败 ❌');
process.exit(ok ? 0 : 1);
