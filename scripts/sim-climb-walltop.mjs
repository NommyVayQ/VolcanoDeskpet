// 攀爬仿真：忠实复现 stepClimb / stepPhysics 的交互。
//   ① 回归历史 P0：爬到墙顶后是否会被「下落撞边抓墙」无限抓回（冷却/收口是否生效）
//   ② 验证新模型：一次攀爬会话内沿边**上下折返巡逻**，到 climbMaxMs(20s) 才下墙（掉落 / 起飞）
// 统计口径：以「第一次上墙 → 首次离开墙面（掉落 / 起飞 / 沿墙落地）」为一场会话。
// 用法：node scripts/sim-climb-walltop.mjs [runs]
const DT_MS = 1000 / 60;
const DT = 1;                   // 单位帧（与代码里的 dt 同义：1 tick ≈ 1 帧）
const SIZE_H = 150;             // 角色高度
const FLOOR_Y = 900;            // baselineY（地面）
const TOP = 0;
const EDGE_X = -50;             // edgeMargin=50 → 攀爬时 x 被吸附到 -50（贴左边）
const GRAVITY = 0.8;
const DROP_VX = 2.5;            // 松手掉落时的内向水平初速
const EDGE_HIT_X = 6;           // stepPhysics 的 atScreenEdge(6) 判据

// 攀爬动作的逐帧数据（rose/nina/rebeza/gwen 一致）：握紧帧 700ms 不位移，之后两帧各爬一格
const FRAMES = [{ ms: 700, vy: 0 }, { ms: 250, vy: 3 }, { ms: 250, vy: 2.33 }];
const CYCLE_MS = FRAMES.reduce((s, f) => s + f.ms, 0);                  // 1200ms
const CYCLE_PX = FRAMES.reduce((s, f) => s + f.vy * (f.ms / DT_MS), 0); // 80px/轮
const SPEED_PX_S = CYCLE_PX / (CYCLE_MS / 1000);                        // 66.7 px/s

// —— 新模型参数（与 config/characters/*.json 默认一致）——
const MAX_MS = 20000;           // climbMaxMs
const TURN_CHANCE = 0.35;       // climbTurnChance
const FLY_CHANCE = 0.5;         // climbEndFlyChance
const COOLDOWN_MS = 3000;       // climbCooldownMs
const ZONE = Math.max(60, SIZE_H * 0.5); // 距顶/底半身内强制折返
const GAP = 40;                 // 巡逻下沿留白
const LEG_MIN = 120;            // 单腿最小跨度
const FLY_MS = 5000;            // fly 动作时长（estimateActionMs）= durationMs

const RUNS = Number(process.argv[2] || 2000);

/** 复现 pickClimbTarget（新模型）：顶/底折返 + 中途按概率折返，下爬目标也存在 */
function pickTarget(y, dirIn) {
  let dir = dirIn;
  if (y <= TOP + ZONE) dir = 1;
  else if (y >= FLOOR_Y - ZONE) dir = -1;
  else if (Math.random() < TURN_CHANCE) dir = -dir;
  const lo = TOP;
  const hi = Math.max(lo, FLOOR_Y - GAP);
  let targetY;
  if (dir > 0) {
    const a = Math.min(hi, y + LEG_MIN);
    targetY = a + Math.random() * Math.max(0, hi - a);
  } else {
    const b = Math.max(lo, y - LEG_MIN);
    targetY = lo + Math.random() * Math.max(0, b - lo);
  }
  return { targetY, dir };
}

/** 复现历史（修复前）的 pickTarget：值域恒在角色上方 → 物理上不可能向下 */
function pickTargetOld(y) {
  return { targetY: y > TOP + 80 ? TOP + Math.random() * (y - 80 - TOP) : TOP, dir: -1 };
}

function run(mode) {
  let y = FLOOR_Y, x = EDGE_X, vy = 0, vx = 0;
  let phase = 'climb';
  let perchTimer = 0, climbDir = -1;
  let { targetY, dir } = mode === 'old' ? pickTargetOld(y) : pickTarget(y, climbDir);
  climbDir = dir;
  let climbStartMs = 0, sessionActive = false, flyUntil = -1;
  let blockedUntil = -1, now = 0, frames = 0;
  let frameIdx = 0, frameLeft = FRAMES[0].ms;
  // —— 统计（只看第一场会话）——
  let legs = 0, ups = 0, downs = 0, legMs = 0, maxLegMs = 0;
  let sessionMs = 0, firstExit = null, sessionOpen = false;
  let totalMs = 0, exits = { drop: 0, fly: 0, ground: 0, land: 0 };

  while (frames++ < 30000) {                 // 500s 上限
    now = frames * DT_MS;
    totalMs = now;
    const blocked = now < blockedUntil;

    if (phase === 'climb') {
      if (!sessionOpen) { sessionOpen = true; sessionMs = 0; }
      sessionMs += DT_MS;
      // 逐帧推进攀爬动画（决定位移速度：握紧帧不动，发力帧各爬一格）
      frameLeft -= DT_MS;
      if (frameLeft <= 0) { frameIdx = (frameIdx + 1) % FRAMES.length; frameLeft = FRAMES[frameIdx].ms; }
      const speed = FRAMES[frameIdx].vy;

      if (climbStartMs === 0) climbStartMs = now;
      const maxMs = mode === 'old' ? 8000 : MAX_MS;
      if (maxMs > 0 && now - climbStartMs >= maxMs) {
        // —— endClimbSession ——
        if (mode === 'new') {
          if (y >= FLOOR_Y - Math.max(60, SIZE_H)) { exits.ground++; return done('ground'); }
          if (Math.random() < FLY_CHANCE) {
            exits.fly++;
            firstExit = firstExit || 'fly';
            flyUntil = now + FLY_MS;
            phase = 'fly';
            sessionActive = false;
            // 冷却覆盖整个飞行时长（+1.5s 余量），否则飞完下落时仍在边缘会被立刻抓回墙上
            blockedUntil = now + Math.max(COOLDOWN_MS, FLY_MS + 1500);
            continue;
          }
          exits.drop++;
        } else { exits.drop++; }
        firstExit = firstExit || 'drop';
        doDrop();
        continue;
      }
      if (perchTimer > 0) {
        perchTimer -= DT_MS;
        if (perchTimer > 0) continue;
        perchTimer = 0;
        if (mode === 'old') {
          if (Math.random() < 0.5) { exits.drop++; firstExit = firstExit || 'drop'; doDrop(); continue; }
          ({ targetY, dir } = pickTargetOld(y));
        } else {
          maxLegMs = Math.max(maxLegMs, legMs); legs++;
          if (climbDir < 0) ups++; else downs++;
          legMs = 0;
          ({ targetY, dir } = pickTarget(y, climbDir));
          climbDir = dir;
        }
        continue;
      }
      const dy = targetY - y;
      if (Math.abs(dy) < 4) {
        if (mode === 'old' && y <= SIZE_H * 0.2) { exits.drop++; firstExit = firstExit || 'drop'; doDrop(); continue; } // 旧：到顶必掉落
        if (y >= FLOOR_Y - 4) { exits.ground++; return done('ground'); }
        maxLegMs = Math.max(maxLegMs, legMs); legs++;
        if (climbDir < 0) ups++; else downs++;
        legMs = 0;
        perchTimer = mode === 'old' ? 300 + Math.random() * 400 : 200 + Math.random() * 300;
        continue;
      }
      legMs += DT_MS;
      y += Math.sign(dy) * speed * DT;
      const dx = EDGE_X - x;
      if (Math.abs(dx) > 1) x += Math.sign(dx) * Math.min(Math.abs(dx), speed * DT * 2);
      y = Math.max(TOP, Math.min(y, FLOOR_Y));
      continue;
    }

    if (phase === 'fly') {
      // fly：5s 自由飞行（此处按「最坏情况」处理 —— 全程贴边，飞行期间不移出边缘区）
      if (now < flyUntil) { y = Math.min(y, FLOOR_Y - 1); continue; }
      phase = 'fall';
      vy = 0.6; vx = DROP_VX;
      continue;
    }

    // —— stepPhysics ——
    vy += GRAVITY; y += vy * DT; x += vx * DT; vx *= 0.99;
    const airborne = y < FLOOR_Y - 0.5;
    if (airborne && x <= EDGE_HIT_X) {            // 「下落撞边 → 抓墙」
      if (mode === 'new') {
        if (!blocked) {
          phase = 'climb'; perchTimer = 0;
          if (!sessionActive) { sessionActive = true; climbStartMs = now; climbDir = -1; }
          ({ targetY, dir } = pickTarget(y, climbDir)); climbDir = dir;
          continue;
        }
      } else {
        phase = 'climb'; perchTimer = 0; climbStartMs = now; sessionActive = true; // 旧：重置 8s 预算 → 永不生效
        ({ targetY, dir } = pickTargetOld(y)); climbDir = dir;
        continue;
      }
    }
    if (y >= FLOOR_Y) { exits.land++; return done('land'); }
  }
  return done('timeout');

  function doDrop() {
    phase = 'fall';
    vy = 0.6;
    vx = mode === 'new' ? DROP_VX : 0;             // 旧：垂直掉落，x 仍停在 -50（永远贴边）
    blockedUntil = mode === 'new' ? now + COOLDOWN_MS : -1;
  }
  function done(how) {
    return {
      how, seconds: totalMs / 1000,
      sessionMs: sessionMs / 1000, legs, ups, downs,
      maxLegMs: Math.max(maxLegMs, legMs) / 1000, firstExit, exits: { ...exits },
    };
  }
}

for (const mode of ['old', 'new']) {
  const res = [];
  for (let i = 0; i < RUNS; i++) res.push(run(mode));
  const withSession = res.filter((r) => r.sessionMs > 0);
  res.sort((a, b) => a.seconds - b.seconds);
  const avg = (res.reduce((s, r) => s + r.seconds, 0) / res.length).toFixed(1);
  const max = res[res.length - 1].seconds.toFixed(1);
  const stuck = res.filter((r) => r.how === 'timeout').length;
  const kinds = res.reduce((m, r) => { m[r.how] = (m[r.how] || 0) + 1; return m; }, {});
  const avgLegs = (withSession.reduce((s, r) => s + r.legs, 0) / Math.max(1, withSession.length)).toFixed(1);
  const avgUps = (withSession.reduce((s, r) => s + r.ups, 0) / Math.max(1, withSession.length)).toFixed(1);
  const avgDowns = (withSession.reduce((s, r) => s + r.downs, 0) / Math.max(1, withSession.length)).toFixed(1);
  const sessMs = withSession.map((r) => r.sessionMs).sort((a, b) => a - b);
  const sessAvg = (sessMs.reduce((s, v) => s + v, 0) / Math.max(1, sessMs.length)).toFixed(1);
  const sessP95 = (sessMs[Math.floor(sessMs.length * 0.95)] || 0).toFixed(1);
  const maxLegS = res.reduce((s, r) => Math.max(s, r.maxLegMs), 0).toFixed(1);
  const exits = res.reduce((m, r) => { for (const k in r.exits) m[k] = (m[k] || 0) + r.exits[k]; return m; }, {});
  console.log(
    `[${mode === 'old' ? '修复前' : '修复后'}] 到落地全程均值 ${avg}s  最长 ${max}s  卡死(超时) ${stuck}/${RUNS}\n` +
    `   攀爬会话时长: 均值 ${sessAvg}s  P95 ${sessP95}s\n` +
    `   攀爬腿数 均值 ${avgLegs}（向上 ${avgUps} / 向下 ${avgDowns}）  单腿最长 ${maxLegS}s\n` +
    `   结束方式(首次离墙): ${JSON.stringify(kinds)}   出口计数: ${JSON.stringify(exits)}`
  );
}
console.log(
  `\n参考：一轮攀爬动画 ${CYCLE_MS}ms 位移 ${CYCLE_PX.toFixed(0)}px → ${SPEED_PX_S.toFixed(1)} px/s；` +
  `地面到屏幕顶约 ${(FLOOR_Y / SPEED_PX_S).toFixed(1)}s`
);
