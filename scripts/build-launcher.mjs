/**
 * 把 scripts/launcher.js 打包成项目根目录的 exe 启动器（「启动桌宠.exe」）。
 *
 * 用法：node scripts/build-launcher.mjs
 *
 * 为什么用 Node SEA：本机没有可用的 C/C# 编译器（csc.exe 被安全策略拦、dotnet 只有 runtime 没有 SDK），
 * 而 Node 22 自带 Single Executable Application 支持 —— 把 JS 打成 blob 塞进 node.exe 副本即可，
 * 不需要任何编译器，也不需要额外运行时（exe 自带 Node）。
 *
 * 产物体积≈ node.exe（约 100MB 级）。它只是个启动器，不进 git（已在 .gitignore 里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '.tmp-launcher');
const SRC = path.join(ROOT, 'scripts', 'launcher.js');
const EXE_NAME = '启动桌宠.exe';
const EXE = path.join(ROOT, EXE_NAME);
/** 文档里写的是 NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5dfa6c7a0，但实测本机 node 二进制里是
 *  ...df1996b2 —— 不同构建不一致，抄常量必然踩坑。直接从宿主 node.exe 里扫出来最稳。 */
const FALLBACK_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (m) => console.log('[build-launcher] ' + m);

/** 从宿主 node.exe 里扫出 SEA sentinel fuse 名字（形如 NODE_SEA_FUSE_<hash>:0 的冒号前一段）。 */
function detectFuse(nodeExe) {
  const buf = fs.readFileSync(nodeExe);
  const at = buf.indexOf('NODE_SEA_FUSE_', 0, 'latin1');
  if (at < 0) return FALLBACK_FUSE;
  const rest = buf.slice(at, at + 80).toString('latin1');
  const m = /^NODE_SEA_FUSE_[0-9a-f]+/.exec(rest);
  return m ? m[0] : FALLBACK_FUSE;
}

const FUSE = detectFuse(process.execPath);
step('宿主 node：' + process.execPath + '（v' + process.versions.node + '）');
step('探测到 SEA fuse：' + FUSE);

fs.mkdirSync(OUT, { recursive: true });

// —— 1) 生成 SEA blob ——
const blob = path.join(OUT, 'sea-prep.blob');
const cfg = path.join(OUT, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({
  main: path.relative(ROOT, SRC).split(path.sep).join('/'),
  output: path.relative(ROOT, blob).split(path.sep).join('/'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));

step('生成 blob：' + path.relative(ROOT, blob));
const gen = spawnSync(process.execPath, ['--experimental-sea-config', cfg], { cwd: ROOT, stdio: 'inherit' });
if (gen.status !== 0) { console.error('blob 生成失败'); process.exit(1); }

// —— 2) 复制 node.exe 作为宿主 ——
step('复制宿主 node.exe → ' + EXE_NAME + '（' + (fs.statSync(process.execPath).size / 1048576).toFixed(1) + ' MB）');
fs.copyFileSync(process.execPath, EXE);

// —— 3) postject 注入 blob ——
let cli = path.join(OUT, 'pkg', 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  step('安装 postject（blob 注入工具）…');
  const inst = spawnSync('npm', ['install', '--prefix', path.join(OUT, 'pkg'), 'postject@1.0.0-alpha.6', '--no-audit', '--no-fund'],
    { cwd: ROOT, stdio: 'inherit', shell: true });
  if (inst.status !== 0 || !fs.existsSync(cli)) {
    console.error('postject 安装失败，可手工执行：npm install --prefix .tmp-launcher/pkg postject@1.0.0-alpha.6');
    process.exit(1);
  }
}
step('注入 blob…');
const inj = spawnSync(process.execPath, [cli, EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE],
  { cwd: ROOT, stdio: 'inherit' });
if (inj.status !== 0) { console.error('注入失败'); process.exit(1); }

step('完成：' + EXE + '（' + (fs.statSync(EXE).size / 1048576).toFixed(1) + ' MB）');
step('自检：' + EXE_NAME + ' --list');
const selfcheck = spawnSync(EXE, ['--list'], { cwd: ROOT, stdio: 'inherit' });
if (selfcheck.status !== 0) {
  console.error('自检失败（exit ' + selfcheck.status + '）');
  process.exit(1);
}
