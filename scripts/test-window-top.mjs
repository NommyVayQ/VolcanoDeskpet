/**
 * 窗顶专属行为（windowCeiling.ts）的 headless 逻辑测试。
 *
 * 跑法：node scripts/test-window-top.mjs
 *
 * 做什么：
 *   1. 把 windowCeiling.ts 单独编译成 CommonJS（不打包整个 renderer，避免拉起 PIXI / koffi）；
 *   2. 用 Module._load 钩子把 './Pet' / './SpriteResolver' 换成 stub —— 编排器只用 Pet 的几个
 *      公开方法，不需要真的 Pet；
 *   3. 接管 performance.now()，让「时间」可控，从而确定性地跑完整条行为序列；
 *   4. 断言 12 组行为 + 4 组接线/物理数值。
 *
 * ⚠️ 范围声明：本测试只覆盖 **窗口顶边（topBorder）** 行为。
 *    IE 底边（ClimbIEBottom / GrabIEBottom）与 IE 侧壁攀爬均**不实现**，见 MEMORY.md。
 */
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.tmp-wintop');
const srcFile = path.join(root, 'src/renderer/windowCeiling.ts');

// ---------------------------------------------------------------- 编译
function compile() {
  const out = path.join(outDir, 'windowCeiling.js');
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(srcFile).mtimeMs) return out;
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  // 只编译这一个文件（tsc 会顺带 emit 依赖的 Pet/SpriteResolver，但我们不会去 require 它们）
  execFileSync(process.execPath, [tsc, 'src/renderer/windowCeiling.ts',
    '--outDir', '.tmp-wintop', '--module', 'commonjs', '--target', 'es2020',
    '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop'],
    { cwd: root, stdio: 'pipe' });
  return out;
}

// ---------------------------------------------------------------- 时间与 require 钩子
let fakeNow = 0;
Object.defineProperty(globalThis, 'performance', {
  configurable: true, writable: true, value: { now: () => fakeNow },
});

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './Pet') return { Pet: MockPet };
  if (request === './SpriteResolver') return { SpriteResolver: class { } };
  return origLoad.apply(this, arguments);
};

/** 编排器只用得到的那部分 Pet（字段/行为与真 Pet 对齐，见 Pet.ts）。 */
class MockPet {
  constructor(cfg = {}) {
    this.config = {
      id: cfg.id ?? 'nina',
      defaultAction: 'idle',
      walkAction: 'walk',
      size: { width: 120, height: 150 },
      actions: cfg.actions ?? { idle: 1, walk: 1, creep: 1, sit: 1 },
      ...(cfg.walkActionLeft ? { walkActionLeft: cfg.walkActionLeft } : {}),
      ...(cfg.walkActionRight ? { walkActionRight: cfg.walkActionRight } : {}),
    };
    this.currentActionId = 'idle';
    this.walkArriveCb = null;
    this.calls = [];
    this.vx = 0; this.vy = 0;
    this._drag = false; this._leaving = false;
  }
  get isWalkingToTarget() { return this.walkArriveCb !== null; }
  walkToX(x, _r, cb, speedScale = 1) {
    this.calls.push({ t: 'walkToX', x, speedScale });
    this.walkArriveCb = cb;
    this.currentActionId = this.config.walkAction || 'walk';
  }
  setAction(id, _r) { this.calls.push({ t: 'setAction', id }); this.currentActionId = id; }
  launch(vx, vy) { this.calls.push({ t: 'launch', vx, vy }); this.vx = vx; this.vy = vy; }
  clampWalkTarget() { this.calls.push({ t: 'clampWalkTarget' }); }
  isDraggingAction() { return this._drag; }
  isLeaving() { return this._leaving; }
  /** 模拟 Pet 走到目标：调用到达回调并清空（真 Pet 在 stepWalk 到达时这么做）。 */
  arrive() { const cb = this.walkArriveCb; this.walkArriveCb = null; if (cb) cb(); }
}

const { CeilingBehavior } = (await import('file://' + compile().replace(/\\/g, '/')));

// ---------------------------------------------------------------- 测试框架
const results = [];
let failed = 0;
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failed++;
}

function newHost() {
  const logs = [];
  const releases = [];
  const host = {
    resolver: {},
    release: (p, reason) => { releases.push({ p, reason }); p.calls.push({ t: 'release', reason }); },
    log: (lvl, msg) => logs.push({ lvl, msg }),
  };
  return { host, logs, releases };
}
const WIN = (x = 300, w = 900) => ({ hwnd: 1, x, y: 500, w, h: 400, title: 'T', occluded: false });

/** 采样私有 pick，拿到 id → def 的映射（用于把随机行为固定成某一条）。 */
function behaviorMap(cb, pet, w) {
  const map = new Map();
  const save = Math.random;
  for (let i = 0; i < 4000; i++) { const d = cb.pick(pet, w); if (d) map.set(d.id, d); }
  Math.random = save;
  return map;
}
/** 让编排器下一次必定挑中指定行为。 */
function forceBehavior(cb, pet, w, id) {
  const map = behaviorMap(cb, pet, w);
  const def = map.get(id);
  if (!def) throw new Error('行为不在候选池里：' + id);
  cb.pick = () => def;
  return map;
}
/** 推进到「该挑新行为了」的时刻（bind 后的 1.2~3.6s 间隔）。 */
const pastGap = () => { fakeNow += 5000; };

// ================================================================ T1 候选池过滤
{
  const cb = new CeilingBehavior(newHost().host);
  const pet = new MockPet();
  const full = [...behaviorMap(cb, pet, WIN()).keys()].sort();
  check('T1a 全量候选 = 11 条（behaviors.xml 的 On-Top-of-IE 组）', full.length === 11, full.join(','));

  const narrow = [...behaviorMap(cb, pet, WIN(300, 200)).keys()].sort();
  const okNarrow = narrow.length === 7 && !narrow.some((i) => /Sit$/.test(i));
  check('T1b 200px 窄窗剔除 4 条 Sit 类（minW=400），留 3 条 Along + 4 条 Jump',
    okNarrow, narrow.length + ' 条：' + narrow.join(','));

  const tiny = cb.pick(pet, WIN(300, 60));
  check('T1c 60px 极窄窗一条都不演（锚点必出窗）', tiny === null, String(tiny));

  // 几何保证：候选池里每条行为的锚点都必须落在窗口跨度内（锚点出窗 = isOn 不成立 = 掉下去）
  let worstLo = Infinity, worstHi = -Infinity, bad = [];
  for (const w of [WIN(300, 500), WIN(300, 900), WIN(300, 1600)]) {
    for (const [id, def] of behaviorMap(cb, pet, w)) {
      for (let i = 0; i < 500; i++) {
        const ax = def.anchorX(w);
        worstLo = Math.min(worstLo, ax - w.x);
        worstHi = Math.max(worstHi, w.x + w.w - ax);
        if (ax < w.x || ax > w.x + w.w) bad.push(id);
      }
    }
  }
  check('T1d 候选锚点恒在窗跨度内（最贴边 ' + Math.round(Math.min(worstLo, worstHi)) + 'px）',
    bad.length === 0, [...new Set(bad)].join(','));

  const noSit = new MockPet({ actions: { idle: 1, walk: 1, creep: 1 } });
  const s1 = [...behaviorMap(cb, noSit, WIN()).keys()].sort();
  check('T1e 角色无 sit 帧 → 剔除 4 条 Sit 类', s1.length === 7 && !s1.some((i) => /Sit$/.test(i)), s1.join(','));

  const noCreep = new MockPet({ actions: { idle: 1, walk: 1, sit: 1 } });
  const s2 = [...behaviorMap(cb, noCreep, WIN()).keys()].sort();
  check('T1f 角色无 creep 帧 → 剔除 CrawlAlongIECeiling', s2.length === 10 && !s2.includes('CrawlAlongIECeiling'));

  // 权重：Crawl=10，其余=100 → 1000 次采样里 Crawl 占比应≈1%
  let crawls = 0;
  for (let i = 0; i < 20000; i++) if (cb.pick(pet, WIN()).id === 'CrawlAlongIECeiling') crawls++;
  const ratio = crawls / 20000;
  check('T1g Crawl 权重 10 vs 其余 100（实测占比 ' + (ratio * 100).toFixed(2) + '% ≈ 0.99%）',
    ratio > 0.006 && ratio < 0.015);
}

// ================================================================ T2 WalkAlong 全流程
{
  const { host, logs } = newHost();
  const cb = new CeilingBehavior(host);
  const pet = new MockPet();
  const w = WIN();
  forceBehavior(cb, pet, w, 'WalkAlongIECeiling');
  cb.bind(pet); pastGap(); cb.update(pet, w, fakeNow);
  const started = pet.calls.find((c) => c.t === 'walkToX');
  check('T2a 站上窗顶后开始走（walkToX 被调用，speedScale=1）',
    !!started && started.speedScale === 1, JSON.stringify(started));
  check('T2b 目标落在窗顶跨度内（left+64 .. right-64）',
    started && started.x + 60 >= w.x + 60 && started.x + 60 <= w.x + w.w - 60,
    'anchorX=' + (started ? Math.round(started.x + 60) : '?'));
  pet.arrive();
  cb.update(pet, w, fakeNow);
  check('T2c WalkAlong 到位即结束，无后续 Stand/Sit（actions.xml 只有 ActionReference Walk）',
    pet.calls.filter((c) => c.t === 'setAction').length === 0 && !cb.busy(pet));
  check('T2d 结束日志带行为名', logs.some((l) => l.msg.includes('WalkAlongIECeiling')));
}

// ================================================================ T3 RunAlong = 走帧 ×2 速
{
  const cb = new CeilingBehavior(newHost().host);
  const pet = new MockPet();
  const w = WIN();
  forceBehavior(cb, pet, w, 'RunAlongIECeiling');
  cb.bind(pet); pastGap(); cb.update(pet, w, fakeNow);
  const c = pet.calls.find((x) => x.t === 'walkToX');
  check('T3 RunAlong = 同一套走帧 speedScale=2（旧版 Run Velocity 4 = Walk 2 的 2 倍）',
    c && c.speedScale === 2, JSON.stringify(c));
}

// ================================================================ T4 Crawl 起手（双套走帧退化）
{
  const cb = new CeilingBehavior(newHost().host);
  const pet = new MockPet();
  const w = WIN();
  forceBehavior(cb, pet, w, 'CrawlAlongIECeiling');
  cb.bind(pet); pastGap(); cb.update(pet, w, fakeNow);
  const acts = pet.calls.filter((c) => c.t === 'setAction').map((c) => c.id);
  check('T4a Crawl：先起 walk 拿位移再换 creep 动画', acts.length === 1 && acts[0] === 'creep', acts.join(','));

  const dual = new MockPet({ walkActionLeft: 'walkLeft', walkActionRight: 'walkRight',
    actions: { idle: 1, walk: 1, creep: 1, sit: 1, walkLeft: 1, walkRight: 1 } });
  const cb2 = new CeilingBehavior(newHost().host);
  forceBehavior(cb2, dual, w, 'CrawlAlongIECeiling');
  cb2.bind(dual); pastGap(); cb2.update(dual, w, fakeNow);
  check('T4b 双套走帧角色爬行走不动 → 自动退化成普通 walk（不换动画）',
    dual.calls.filter((c) => c.t === 'setAction').length === 0
    && dual.currentActionId === 'walk', dual.currentActionId);
}

// ================================================================ T5 SitOnLeftEdgeOfIE：Stand → Sit
{
  const cb = new CeilingBehavior(newHost().host);
  const pet = new MockPet();
  const w = WIN();
  forceBehavior(cb, pet, w, 'SitOnTheLeftEdgeOfIE');
  const sx = pet.calls.length;
  cb.bind(pet); pastGap(); cb.update(pet, w, fakeNow);
  const started = pet.calls.find((c) => c.t === 'walkToX');
  check('T5a 目标 = 窗左边 +100~400（anchorX 落在窗内左侧）',
    started && (started.x + 60) >= w.x + 100 && (started.x + 60) <= w.x + 400,
    'anchorX=' + (started ? Math.round(started.x + 60) : '?'));
  pet.arrive(); cb.update(pet, w, fakeNow);
  check('T5b 到位先 Stand（idle）100~200ms', pet.currentActionId === 'idle', pet.currentActionId);
  fakeNow += 300; cb.update(pet, w, fakeNow);
  check('T5c Stand 结束后 Sit', pet.currentActionId === 'sit', pet.currentActionId);
  fakeNow += 2000; cb.update(pet, w, fakeNow);
  check('T5d Sit 结束后编排收尾（500~1500ms）', !cb.busy(pet) && pet.calls.length > sx);
}

// ================================================================ T6 跳下：顺序 + 速度量级
{
  const { host, releases } = newHost();
  const cb = new CeilingBehavior(host);
  const pet = new MockPet();
  const w = WIN();
  forceBehavior(cb, pet, w, 'JumpFromRightEdgeOfIE');
  cb.bind(pet); pastGap(); cb.update(pet, w, fakeNow);
  pet.arrive(); cb.update(pet, w, fakeNow); // Stand 50~100ms
  fakeNow += 200; cb.update(pet, w, fakeNow); // 起跳
  const order = pet.calls.map((c) => c.t);
  const iRel = order.indexOf('release');
  const iLau = order.indexOf('launch');
  check('T6a ⚠️ 先 releaseBound 还原地面、再 launch（反了她会被窗顶地面托回去）',
    iRel >= 0 && iLau >= 0 && iRel < iLau, order.join('→'));
  const lau = pet.calls.find((c) => c.t === 'launch');
  check('T6b 向右跳 vx ∈ [6.25, 8.33] px/帧（旧版 15~20 px/tick ÷ 2.4）',
    lau && lau.vx >= 6.25 && lau.vx <= 8.33, lau ? 'vx=' + lau.vx.toFixed(2) : '无');
  check('T6c 向上起跳 vy ∈ [-10.42, -8.33] px/帧（旧版 20~25 px/tick ÷ 2.4，负=向上）',
    lau && lau.vy <= -8.33 && lau.vy >= -10.42, lau ? 'vy=' + lau.vy.toFixed(2) : '无');
  check('T6d 跳下后不再排下一轮（她已经不在窗顶了）', !cb.busy(pet));
  check('T6f 解除绑定时带 reason=jump（要长冷却，否则被自己接回窗顶）',
    releases.length === 1 && releases[0].reason === 'jump',
    JSON.stringify(releases.map((r) => r.reason)));

  const cb2 = new CeilingBehavior(newHost().host);
  const p2 = new MockPet();
  forceBehavior(cb2, p2, w, 'JumpFromLeftEdgeOfIE');
  cb2.bind(p2); pastGap(); cb2.update(p2, w, fakeNow);
  p2.arrive(); cb2.update(p2, w, fakeNow); fakeNow += 200; cb2.update(p2, w, fakeNow);
  const l2 = p2.calls.find((c) => c.t === 'launch');
  check('T6e 向左跳 vx 为负（往窗外）', l2 && l2.vx <= -6.25 && l2.vx >= -8.33,
    l2 ? 'vx=' + l2.vx.toFixed(2) : '无');
}

// ================================================================ T7 跳下不会被自己的穿越检测接回
{
  // 空中接住逻辑（windowInteract.update）：上一帧脚底 < win.y && 本帧脚底 >= win.y 且下落中 → 重新绑窗顶。
  // 跳下后她会在 t≈? ms 时穿过窗顶高度；若那时冷却已过 → 会被接回窗顶 = 「跳了个寂寞」。
  const g = 0.5;                 // ⚠️ 实测 config/characters/*.json 全部是 0.5，不是 Pet 的默认 0.8
  const COOLDOWN_MS = 1500;      // releaseBound(pet,'jump') 的冷却
  let worstCrossMs = 0, worstDx = 0;
  for (const vy0 of [-8.33, -10.42]) for (const vx of [6.25, 8.33]) {
    // 从窗顶起跳（vy 负=向上），逐帧积分到「重新落回窗顶高度」为止
    let y = 0, v = vy0, x = 0, t = 0;
    do { t++; v += g; y += v; x += vx; } while (y < 0 && t < 600);
    worstCrossMs = Math.max(worstCrossMs, t * (1000 / 60));
    worstDx = Math.max(worstDx, Math.abs(x));
  }
  check('T7a 落回窗顶高度的时刻 ' + worstCrossMs.toFixed(0) + 'ms < jump 冷却 1500ms（700ms 只剩 '
    + (700 - worstCrossMs).toFixed(0) + 'ms 余量，不够）', worstCrossMs < COOLDOWN_MS);
  check('T7b 落回窗顶高度时已水平飞出 ' + worstDx.toFixed(0) + 'px（确实离开窗沿，不是原地弹腿）',
    worstDx > 100);
}

// ================================================================ T8 被打断 / 被抢动作 / 超时
{
  // 走路上被抢（walkArriveCb 被 Pet 清空）
  const { host, logs } = newHost();
  const cb = new CeilingBehavior(host);
  const pet = new MockPet();
  const w = WIN();
  forceBehavior(cb, pet, w, 'WalkAlongIECeiling');
  cb.bind(pet); pastGap(); cb.update(pet, w, fakeNow);
  pet.walkArriveCb = null;             // 模拟被菜单/相遇抢走
  cb.update(pet, w, fakeNow);
  check('T8a 行走被打断 → 编排作废，1500ms 后重试', !cb.busy(pet)
    && logs.some((l) => l.msg.includes('行走被打断')));

  // 步骤执行中动作被换掉
  const cb2 = new CeilingBehavior(newHost().host);
  const p2 = new MockPet();
  forceBehavior(cb2, p2, w, 'SitOnTheLeftEdgeOfIE');
  cb2.bind(p2); pastGap(); cb2.update(p2, w, fakeNow);
  p2.arrive(); cb2.update(p2, w, fakeNow);   // Stand(idle)
  p2.currentActionId = 'wave';               // 用户右键选了别的
  fakeNow += 300; cb2.update(p2, w, fakeNow);
  check('T8b Stand 期间被换动作 → 中止编排（不跟用户抢）', !cb2.busy(p2));

  // 超时
  const { host: h3, logs: l3 } = newHost();
  const cb3 = new CeilingBehavior(h3);
  const p3 = new MockPet();
  forceBehavior(cb3, p3, w, 'RunAlongIECeiling');
  cb3.bind(p3); pastGap(); cb3.update(p3, w, fakeNow);
  fakeNow += 26000;                          // > PLAN_TIMEOUT_MS(25000)
  cb3.update(p3, w, fakeNow);
  check('T8c 25s 超时兜底作废并告警', !cb3.busy(p3) && l3.some((l) => l.lvl === 'warn' && l.msg.includes('超时')));
}

// ================================================================ T9 忙碌 / 拖拽 / 退场 / 过期回调
{
  const cb = new CeilingBehavior(newHost().host);
  const pet = new MockPet();
  const w = WIN();
  forceBehavior(cb, pet, w, 'WalkAlongIECeiling');
  pet.currentActionId = 'sit';               // 她正在做别的
  cb.bind(pet); pastGap(); cb.update(pet, w, fakeNow);
  check('T9a 她忙着别的动作 → 不抢，等 1500ms 再看', pet.calls.length === 0 && !cb.busy(pet));

  const cb2 = new CeilingBehavior(newHost().host);
  const p2 = new MockPet();
  forceBehavior(cb2, p2, w, 'WalkAlongIECeiling');
  cb2.bind(p2); pastGap(); cb2.update(p2, w, fakeNow);
  p2._drag = true; cb2.update(p2, w, fakeNow);
  check('T9b 被拖拽 → 立刻作废', !cb2.busy(p2));
  p2._drag = false;

  const cb3 = new CeilingBehavior(newHost().host);
  const p3 = new MockPet();
  forceBehavior(cb3, p3, w, 'WalkAlongIECeiling');
  cb3.bind(p3); pastGap(); cb3.update(p3, w, fakeNow);
  p3._leaving = true; cb3.update(p3, w, fakeNow);
  check('T9c 退场中 → 立刻作废', !cb3.busy(p3));

  // 过期 token 回调（编排已作废后才到达）
  const cb4 = new CeilingBehavior(newHost().host);
  const p4 = new MockPet();
  forceBehavior(cb4, p4, w, 'WalkAlongIECeiling');
  cb4.bind(p4); pastGap(); cb4.update(p4, w, fakeNow);
  const staleCb = p4.walkArriveCb;
  cb4.cancel(p4);
  let threw = false;
  try { staleCb(); } catch { threw = true; }
  check('T9d 作废后的迟到到达回调不抛错、不复活编排', !threw && !cb4.busy(p4));
}

// ================================================================ T10 接线（源码静态断言）
{
  const wi = fs.readFileSync(path.join(root, 'src/renderer/windowInteract.ts'), 'utf8');
  const petSrc = fs.readFileSync(path.join(root, 'src/renderer/Pet.ts'), 'utf8');
  check('T10a windowInteract.bindNow → ceiling.bind', /ceiling\.bind\(/.test(wi));
  check('T10b windowInteract.releaseBound → ceiling.cancel', /ceiling\.cancel\(/.test(wi));
  check('T10c windowInteract.update → 每帧 clampWalkTarget + ceiling.update',
    /clampWalkTarget\(/.test(wi) && /ceiling\.update\(/.test(wi));
  check('T10d Pet.baselineY 优先 groundOverrideY（窗顶=地面）',
    /groundOverrideY/.test(petSrc) && /baselineY\(\)/.test(petSrc));
  const g1 = /atScreenEdge\([^)]*\)\s*&&[^;]*!this\.onWindowTop/.test(petSrc);   // 贴边不转攀爬
  const g2 = /this\.onWindowTop\s*&&\s*\(def\.behavior === 'climb'/.test(petSrc); // wander 池排除 climb/ceiling
  const g3 = /\|\| hitRightWall\)\s*&&[^;]*!this\.onWindowTop/.test(petSrc);      // 撞墙不转攀爬
  check('T10e 窗顶上禁止转屏幕攀爬/贴顶（3 处守卫）', g1 && g2 && g3,
    '贴边=' + g1 + ' wander池=' + g2 + ' 撞墙=' + g3);
  check('T10f 主动跳下用 1500ms 冷却（普通掉落 700ms）',
    /releaseBound\(pet: Pet, reason: 'lost' \| 'jump' = 'lost'\)/.test(wi)
    && /reason === 'jump' \? 1500 : 700/.test(wi));
}

// ================================================================ T11 范围：没有 IE 底边
{
  const files = fs.readdirSync(path.join(root, 'src/renderer')).filter((f) => f.endsWith('.ts'));
  let hits = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8');
    // 只查代码：范围声明的注释里必然会出现这些名字（说「不做」也要提它的名字）
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (/bottomBorder|IEBottom|ieBottom|ClimbIEBottom|GrabIEBottom/.test(code)) hits.push(f);
  }
  check('T11 全项目无 IE 底边（bottomBorder / ClimbIEBottom）实现 —— 本次不做窗底', hits.length === 0,
    hits.join(','));
}

// ================================================================ 输出
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('\n窗顶行为（windowCeiling.ts）headless 测试\n' + '='.repeat(78));
for (const r of results) {
  console.log((r.ok ? ' PASS ' : ' FAIL ') + pad(r.name, 62) + (r.detail ? ' | ' + r.detail : ''));
}
console.log('='.repeat(78));
console.log((results.length - failed) + '/' + results.length + ' 通过' + (failed ? '，' + failed + ' 项失败' : ''));
process.exit(failed ? 1 : 0);
