/**
 * 窗口交互（渲染层）：
 * - carry：窗口吸附在宠物头顶跟随移动；拖拽宠物即拖动窗口，松手按指针速度把窗口抛出（主进程模拟重力）。
 * - ledge（站窗顶）：窗口顶边 = 一条「可落地面」（Border）。宠物站上去后**每帧随窗口滑动**（骑窗），
 *   窗口被关/最小化/拖走才掉落——**没有超时、没有走跳演出**，与原版 Shimeji 一致。
 * - throwShow：「搬走并甩出窗口」整段演出 —— **逐段复刻原桌宠 Shimeji 的 ThrowIEFromLeft / ThrowIEFromRight**：
 *
 *   原版 conf/actions.xml（TICK_INTERVAL = 40ms，Pose 的 Velocity 单位 = px/tick）：
 *     ThrowIEFromLeft  = Jumpingx(TargetX=IE.left,   TargetY=IE.bottom+64)
 *                        → FallWithIe(IeOffsetX=0, IeOffsetY=-64, shime36)
 *                        → WalkWithIe(TargetX=workArea.right-200, shime35↔36, Velocity=-2)
 *                        → ThrowIe(InitialVX=32, InitialVY=-10, Gravity=0.5, shime37)
 *                        → Stand(50~100) → Look → Stand(50~100)
 *     ThrowIEFromRight = 同上，目标换成 IE.right / workArea.left+250，ThrowIe 的 VX 方向相反
 *     WalkAndThrowIEFromLeft/Right = 与上面同构，只把 WalkWithIe 换成 RunWithIe(Velocity=-8)
 *
 *   触发条件（conf/behaviors.xml，四条行为各 Frequency=20，等权随机）：
 *     activeIE.visible
 *       && activeIE.bottom < mascot.anchor.y - 64      （窗口底边比角色脚底高 64px 以上）
 *       && ( mascot.anchor.x < activeIE.left  ||  mascot.anchor.x > activeIE.right )
 *     即：角色站在窗口左/右下方的地面上，窗口悬在角色上方。
 *
 *   本文件按「走过去 → 跳上窗口下角 → 抓住 → 带着窗口落回地面 → 扛到屏幕另一侧 → 甩出 → 收尾」实现。
 *   抓住后的持窗姿势 = **双手举过头顶**：窗口水平居中罩在角色图片上方，窗口底边压在
 *   「脚底上方 64px」= 抬起的手的高度（carry 帧的拳头正好抓着底边，角色画在窗口前面）。
 *   ⚠️ 水平方向不照抄原版的「窗口边缘对齐角色中心」——那会把半个窗口悬在角色旁边，
 *   观感是扛在肩侧；2026-09-25 用户拍板改为居中举起。
 *
 * 数据入口：动作配 windowMode: 'carry' | 'ledge' | 'throw'（见 types.ts ActionDef）。
 * 目标范围由「自定义可互动窗口」名单决定（config/config.json 的 window.whitelist，见 windowListPanel.ts）。
 */
import { Pet } from './Pet';
import { SpriteResolver } from './SpriteResolver';
import { CeilingBehavior } from './windowCeiling';
import { pickTopmostWindow, isTopmostWindow } from './windowTopmost';

const req: any = (window as any).require;
const { ipcRenderer } = req('electron');

export interface WinInfo { hwnd: number; title: string; x: number; y: number; w: number; h: number; z: number; occluded?: boolean; }

/** 原版 ThrowIe / WalkWithIE / FallWithIE 的 IeOffsetY = -64：
 *  窗口**底边**恒定压在角色**脚底**上方 64px。这正好是 carry 帧里「抬起的手」的高度
 *  （实测 L-carry-1/2 的拳头在脚底上方约 50~62px）——拳头（画在窗口前面）压住窗口底边 = 抓着窗口。 */
const WIN_BOTTOM_TO_FEET = 64;

/** 起跳上升速度（px/ms）。原版 Jumpingx 是抛物线跳跃，这里用匀速上跳近似。 */
const JUMP_SPEED = 0.9;
/** 带着窗口下落速度（px/ms）。原版 FallWithIe 是 Gravity=2 的加速下落，这里匀速近似。 */
const FALL_SPEED = 0.6;
/** 扛着走 / 奔跑速度（px/ms，已按帧间隔归一，不同刷新率速度一致）。
 *  原版 WalkWithIe Velocity=2、RunWithIe Velocity=8（40ms/tick，1:4）→ 换算成 50 / 200 px/s。
 *  这里直接以 px/ms 表达（0.05 / 0.2），保持「走 : 跑 = 1 : 4」且回到原版真实速度。
 *  ⚠️ 之前写成 px/帧（×1.2/4.8 不乘 dt）导致高刷屏速度翻倍、整体偏快，2026-09-26 修正。 */
const CARRY_WALK_SPEED = 0.05;
const CARRY_RUN_SPEED = 0.2;

/** 各阶段安全上限（正常远小于此值，只作兜底，防止异常状态下永久占用角色）。
 *  grab / throw 两段同时是「定时推进」的时长（到时进入下一段 / 收尾），数值即设计节奏。 */
const T_WALK_MS = 20000;
const T_JUMP_MS = 6000;
const T_GRAB_MS = 260;   // 抓住后停一帧（原版 Jumpingx → FallWithIe 之间没有停顿）
const T_FALL_MS = 8000;
const T_CARRY_MS = 40000;
const T_THROW_MS = 1200; // 甩出姿势保持（原版 ThrowIe 动画 40 tick × 40ms = 1.6s，这里取 1.2s）

// —— 站窗顶的「跟随守卫」阈值：逐字对齐旧版 `FloorCeiling.move(Point)` 字节码 ——
// 旧版每 tick = 40ms 调一次 `anchor = border.move(anchor)`，move() 里有三个放弃跟随的守卫：
//   |dx| >= 80       → 不跟随（窗口横向跳得太远）
//   dy >  20        → 不跟随（窗口**下移**太快 → 角色被留在原地 = 踩空）
//   dy < -80        → 不跟随（窗口上移太快 → 角色被留在下方）
// 不跟随 = 角色停在原处、与窗口错位 → 下一帧 `isOn()` 不成立 → 抛 LostGroundException → 改播下落。
// 本程序等价实现：不搬运位移 → 角色相对窗顶悬空/错位 → Pet 的 stepPhysics 接管（重力下落 / 被地面顶上来）。
/** 旧版一个 tick 的时长（ms）。所有阈值都以「每 40ms」为基准，按实际经过时间等比缩放。 */
const SHIMEJI_TICK_MS = 40;
/** 横向跟随上限：窗口单次位移超过 80px/tick 就不搬运（角色被落下）。 */
const FOLLOW_MAX_DX = 80;
/** 向下跟随上限：窗口顶边下移超过 20px/tick 就不搬运 → 角色踩空自由落体（**关键**：这就是「拖窗口向下她会掉」的来源）。 */
const FOLLOW_MAX_DOWN = 20;
/** 向上跟随上限：窗口顶边上移超过 80px/tick 就不搬运。 */
const FOLLOW_MAX_UP = 80;

function log(level: string, msg: string) {
  console.log('[wininteract:' + level + '] ' + msg);
  ipcRenderer?.send('renderer-log', level, msg);
}

/**
 * 演出阶段：
 *  walk  走到窗口左/右下角的正下方（地面行走）
 *  jump  跳上去，让脚底停在「窗口底边 + 64」
 *  grab  抓住窗口（窗口吸附到角色身上）
 *  fall  带着窗口落回地面（原版 FallWithIe：窗口被一起拖下来）
 *  carry 扛着窗口走向屏幕另一侧
 *  throw 甩出去
 */
type ShowPhase = 'walk' | 'jump' | 'grab' | 'fall' | 'carry' | 'throw';

/** 「搬走并甩出窗口」演出的运行时状态。 */
interface ThrowShow {
  pet: Pet;
  phase: ShowPhase;
  hwnd: number;
  title: string;
  winW: number;
  winH: number;
  /** 1 = 角色在窗口左侧、面右、向右走、向右甩（= 原版 ThrowIEFromLeft）；
   * -1 = 角色在窗口右侧、面左、向左走、向左甩（= 原版 ThrowIEFromRight）。 */
  dir: 1 | -1;
  /** 目标：角色**中心** x 对齐窗口左/右边缘（原版 TargetX = IE.left / IE.right）。 */
  cornerCenterX: number;
  /** 目标：跳上去后的 container.y（使脚底 = 窗口底边 + 64）。 */
  jumpTopY: number;
  /** carry 阶段终点（容器左边缘坐标）。 */
  targetX: number;
  /** true = 奔跑（原版 WalkAndThrowIExxx 用 RunWithIe），false = 走。 */
  run: boolean;
  phaseUntil: number;
  lastSync: number;
  /** 上一帧时间戳：用于按真实帧间隔推进 jump/fall 的位移（帧率无关）。 */
  lastTick: number;
}

/** 「站窗顶」= 把窗口顶边当成一条**可落地面**（复刻旧版 Shimeji 的 `Border` / `activeIE.topBorder`）：
 *  宠物被「绑定」到窗口顶边后，每帧据窗口实时矩形把脚底吸附到顶边（骑窗），窗口移动它就跟着动；
 *  **没有**「走过去跳上去」的演出、**没有**定时掉落、**没有**异步轮询——窗口被关/最小化/拖走才掉。
 *  绑定状态按宠物各自持有一份（this.bound: Map），多宠可同时各站各的窗口，互不干扰（也不再抢槽刷屏）。 */


export class WindowInteract {
  private resolver: SpriteResolver;
  private carry: {
    pet: Pet; hwnd: number; winW: number; winH: number;
    lastSync: number; startedAt: number; wasDragging: boolean;
    lastPetX: number; lastPetY: number; velX: number; velY: number;
  } | null = null;
  /** 已绑定窗口顶的宠物：每只各绑各的窗口。
   *  hwnd = 窗口句柄；prevWinX/Y = 上次采到的窗口左上坐标；prevAt = 那次采样的时间戳。
   *  ⚠️ 不再存 vy / slip：踩空下落交给 Pet 自己的 stepPhysics（地面就是窗顶，见 groundOverrideY）。 */
  private bound = new Map<Pet, { hwnd: number; prevWinX: number; prevWinY: number; prevAt: number }>();
  private show: ThrowShow | null = null;
  private available: boolean | null = null;
  /** 窗口列表缓存：ticker 每帧要检测「飞行中是否被窗顶接住」，不能每帧 IPC，故 100ms 刷新一次。 */
  private winCache: WinInfo[] = [];
  private winCacheAt = 0;
  /** 上一帧脚底 y：用于判「本帧是否从上方穿过窗口顶边」（穿越检测，比固定容差带更稳、高速抛投也漏不掉）。 */
  private lastFeetY = new Map<Pet, number>();
  /** 窗顶专属行为编排器（站上窗顶后自发的一整套行为，见 windowCeiling.ts 的 conf 出处注释）。 */
  private ceiling: CeilingBehavior;
  /** 窗顶专属行为总开关（config.json window.topBehaviorEnabled，默认 true）。
   *  关掉后站上窗顶只剩「和地面一样的行走/待机」，不再自发那一套。 */
  private topBehaviorEnabled = true;
  /** 「刚掉下窗顶」的冷却：掉落后短时间内不再被（可能还没刷新的）窗口缓存接回同一处，避免抖动。
   *  取 700ms：踩空掉落途中要够长，否则「窗口正在下移 → 角色掉一半又被追上」会变成黏住不放。 */
  private bindBlockUntil = new Map<Pet, number>();
  /** 「可互动窗口」白名单（标题**包含**任一字符串即命中，主进程 titleInWhitelist 判）。
   *  ⚠️ 本类**所有** `win-list` 调用都必须带上它（窗顶穿越检测 / 搬运 / 自动站窗），
   *     否则任何窗口都会被当成可互动窗口 —— 表现就是「随便什么窗口都能站上去」。
   *     空数组 = 不限制（主进程 titleInWhitelist 的空名单语义），保持与投掷一致的既有行为。 */
  private whitelist: string[] = [];

  constructor(resolver: SpriteResolver) {
    this.resolver = resolver;
    // 窗顶专属行为编排（"On Top of IE" 条件组）：注入「释放绑定」与日志，其余规模自持
    this.ceiling = new CeilingBehavior({
      resolver,
      release: (pet) => this.releaseBound(pet),
      log,
    });
  }

  /** 更新可互动窗口白名单（设置面板改完名单后调用）。
   *  ⚠️ 必须立刻清窗口缓存：否则下一帧还在用旧名单的缓存判定「窗口还在」，
   *     刚从名单里删掉的窗口要等 100ms 才失效（这段时间里仍能站上去）。 */
  setWhitelist(list: string[]) {
    this.whitelist = Array.isArray(list) ? [...list] : [];
    this.winCache = [];
    this.winCacheAt = 0;
  }

  /** 开关「窗顶专属行为组」（"On Top of IE" 条件组）。关掉立刻作废在手编排。 */
  setTopBehaviorEnabled(on: boolean) {
    this.topBehaviorEnabled = on;
    if (!on) for (const pet of [...this.ceilingPlanned()]) this.ceiling.cancel(pet);
  }

  private ceilingPlanned(): Pet[] { return [...this.bound.keys()]; }

  /** koffi 是否可用（不可用时窗口系菜单隐藏）。缓存一次。 */
  async isAvailable(): Promise<boolean> {
    if (this.available === null) {
      this.available = await ipcRenderer.invoke('win-available');
      if (!this.available) log('warn', 'winapi unavailable, window actions disabled');
    }
    return this.available ?? false;
  }

  /** 取 Z 序最靠前且**未被遮挡**的可互动窗口（z 越小越靠前：EnumWindows 按 Z 序顶→底枚举 listWindows）。
   *  复刻原版 Shimeji findActiveIE 的「抓最上层交互窗口」，并加一层遮挡校验（方案②）：
   *  白名单窗口可能被一个更大的非白名单窗口（典型：最大化的文档）整个盖住——用户看不见它，
   *  抓它就是「空手抛掷」。主进程 listWindows 已按采样点算好 occluded，这里优先取未遮挡的；
   *  若所有候选都被遮住，返回 null 放弃演出（有 warn 日志可查）。 */
  private async topmostWindow(pet: Pet): Promise<WinInfo | null> {
    const wins: WinInfo[] = await ipcRenderer.invoke('win-list', this.whitelist);
    if (!wins || wins.length === 0) return null;
    const best = this.pickTopmost(wins);
    if (!best && wins.length > 0) {
      log('warn', '可互动窗口 ' + wins.length + ' 个但全部被更高层的窗口遮挡，放弃（把上层窗口挪开或最小化后再试）');
    }
    return best;
  }

  /** 从候选窗口里取「**用户眼中最上层的那扇**」= Z 序最靠前且未被完全遮挡者。
   *  listWindows 按 Z 序顶→底枚举（z 越小越靠前），这里显式取 min(z) 以容忍任何重排；
   *  `occluded`（采样点全被盖住 = 看不见）的候选跳过；全部被遮 → 返回 null。
   *
   *  ⚠️ 2026-10-11 起这是**唯一**允许站上去的窗口（用户要求「站立的窗口要在屏幕最上层，
   *     不在上层就不要触发」）：被别的窗口压在下面的窗口不再接人，已站在上面的也要掉下来。
   *     注意 occluded 只判「完全遮住」——被非名单窗口盖掉一半仍算可见，仍可站（半可见窗口在
   *     屏幕上确实还露着一大块，站上去不算穿帮）。 */
  private pickTopmost(wins: WinInfo[]): WinInfo | null {
    return pickTopmostWindow(wins) as WinInfo | null;
  }

  /** 这扇窗此刻是不是最上层（闸门用）：不在上层 → 不站 / 已站的掉下来。 */
  private isTopmost(w: WinInfo, wins: WinInfo[]): boolean {
    return isTopmostWindow(w, wins);
  }

  /** 搬运窗口：窗口吸附宠物头顶。 */
  async startCarry(pet: Pet): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    this.releaseFor(pet); // 只放掉这只自己的占用（别的宠物仍可站在自己那扇窗顶）
    if (this.carry) { this.carry.pet.isWindowHeld = false; this.carry = null; } // carry 是单例，接管前先放掉别人的
    const win = await this.topmostWindow(pet);
    if (!win) { log('warn', 'no window to carry'); return false; }
    pet.standStill(this.resolver);
    pet.isWindowHeld = true;
    this.carry = {
      pet, hwnd: win.hwnd, winW: win.w, winH: win.h,
      lastSync: 0, startedAt: performance.now(), wasDragging: false,
      lastPetX: pet.container.x, lastPetY: pet.container.y, velX: 0, velY: 0,
    };
    // 旧的「拖拽搬运」语义：窗口居中压在宠物头顶（底边贴宠物顶边），保持原行为不变
    const petW = pet.config.size.width;
    this.placeWindow(win.hwnd, pet.container.x + petW / 2 - win.w / 2,
      pet.container.y - win.h, win.w, win.h, true);
    log('info', 'carrying window ' + win.hwnd + ' (' + win.title.slice(0, 20) + ')');
    return true;
  }

  /** 找落点正下方/正上方、且 x 跨度覆盖落点的可互动窗口（带容差 tol）。
   *  用于「拖放角色到窗口上 → 自动站窗沿」：落点 (cx, feetY) 命中窗口矩形（含中心 cy）即算命中。
   *  返回最靠前（z 最小）的命中窗口，无则 null。winapi 不可用返回 null。 */
  async findWindowAt(cx: number, feetY: number, centerY: number, tol = 60): Promise<WinInfo | null> {
    if (!(await this.isAvailable())) return null;
    const wins: WinInfo[] = await ipcRenderer.invoke('win-list', this.whitelist);
    if (!wins || wins.length === 0) return null;
    const inside = (w: WinInfo) => {
      if (w.occluded) return false;
      const xOk = cx >= w.x - tol && cx <= w.x + w.w + tol;
      if (!xOk) return false;
      const yOk = (feetY >= w.y - tol && feetY <= w.y + w.h + tol)
        || (centerY >= w.y - tol && centerY <= w.y + w.h + tol);
      return yOk;
    };
    const hits = wins.filter(inside);
    if (hits.length === 0) return null;
    let best: WinInfo | null = null;
    let bestZ = Infinity;
    for (const w of hits) {
      const z = w.z ?? 0;
      if (z < bestZ) { bestZ = z; best = w; }
    }
    // ⚠️ 落点命中的那扇必须同时是**最上层**那扇：压在下面的窗口不触发（2026-10-11 用户要求）。
    const top = this.pickTopmost(wins);
    if (best && top && best.hwnd !== top.hwnd) {
      log('info', '[winledge] 落点窗口「' + best.title.slice(0, 20) + '」不在最上层（上层是「'
        + top.title.slice(0, 20) + '」），不站');
      return null;
    }
    return best;
  }

  /** 站窗顶（复刻旧版 Shimeji `activeIE.topBorder` 绑定）：
   *  把宠物**直接放到窗口顶边**（脚底对齐窗口顶边）并**永久绑定**——之后每帧随窗口滑动（骑窗），
   *  窗口被关/最小化/拖走才掉下来。
   *  ⚠️ 旧版是「Move 到那条 Border 上」而不是先走到窗口下方再跳上去，故本版**没有**走/跳演出：
   *     自动站窗（nina 掷骰）、拖放落到窗顶、抛投过程中被窗顶接住，三条入口都收敛到这里。
   *  ⚠️ **横向零位移**（2026-10-10 用户要求「不要吸附」）：站上去只做「脚底对齐窗口顶边」这一下，
   *     水平位置**原样保留**——不夹进窗口范围、不往窗口中心靠。若角色被放到窗口边缘，就站在边缘
   *     （一半悬在外面也行），窗口之后左右移动时她才跟着走（保持相对偏移）。
   *  @param win 指定要站上去的窗口；省略则取 Z 序最靠前且未被遮挡的可互动窗口。 */
  async bindToWindow(pet: Pet, win?: WinInfo): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    if (pet.isDraggingAction() || pet.isLeaving()) return false;
    let w = win ?? await this.topmostWindow(pet) ?? undefined;
    if (w && win) {
      // 显式指定窗口时也要过「最上层」这道闸：不是当前最上层那扇就不站（用户要求）。
      const wins: WinInfo[] = await ipcRenderer.invoke('win-list', this.whitelist);
      if (!this.isTopmost(w, wins || [])) {
        const top = this.pickTopmost(wins || []);
        log('info', '[winledge] 目标窗口「' + w.title.slice(0, 20) + '」不在最上层（上层是「'
          + (top ? top.title.slice(0, 20) : '无') + '」），不站');
        w = undefined;
      }
    }
    if (!w) { log('warn', 'no window to stand on'); return false; }
    this.bindNow(pet, w);
    return true;
  }

  /** 把宠物绑定到窗口顶边：**只换地面，不冻结角色**。
   *
   *  ⚠️ 关键设计（2026-10-11）：早期版本置 `isWindowHeld=true` 让 `Pet.update()` 早退、位置由本类每帧重夹——
   *     结果是站上去只能**呆立**（不能走、不能做动作），且竖直方向变成"磁铁"（窗口下移人被 lerp 拽着走）。
   *     正确做法是**把窗顶变成 Pet 的地面**：设 `pet.groundOverrideY = w.y - petH`，此后
   *     行走/待机/随机动作/踩空下落全部由 Pet 自己的逻辑处理（它本就用 `baselineY()` 当地面），
   *     与站在地面上完全一致——这正是旧版 Shimeji「窗顶 = 一条 Border，和地面同类」的等价实现。
   *
   *  ⚠️ **横向零位移**（用户要求「不要吸附」）：只改 y（脚底对齐窗顶），x 一律不动、不做 clamp；
   *     窗口左右移动时按**位移增量**叠加到角色身上（保持相对位置，不与她自己走路抢 x）。 */
  private bindNow(pet: Pet, w: WinInfo) {
    this.releaseFor(pet); // ⚠️ 只释放**这只宠物自己**的窗口占用，绝不动别人的窗顶/搬运（多宠各站各的）
    const petH = pet.config.size.height;
    // 直接清速度（不走 standStill：后者对「非地面」角色会置 menuHold，掉落后残留冻结态）
    pet.clearVelocity();
    pet.groundOverrideY = w.y - petH; // 地面 = 窗口顶边（脚底贴顶边时的容器 y）
    pet.onWindowTop = true;
    pet.container.y = w.y - petH; // 脚底 = 窗口顶边（x 不动）
    pet.setFacingDir(pet.container.x < w.x + w.w / 2);
    pet.setAction(pet.config.defaultAction || 'idle', this.resolver);
    this.bound.set(pet, { hwnd: w.hwnd, prevWinX: w.x, prevWinY: w.y, prevAt: performance.now() });
    this.lastFeetY.delete(pet);
    this.ceiling.bind(pet); // 站上窗顶 → 开始自发窗顶行为（走/跑/爬/坐窗边/从窗边跳下）
    log('info', '[winledge] 站上窗口「' + w.title.slice(0, 20) + '」顶边（顶边 y=' + Math.round(w.y)
      + '），地面换成窗顶：可自由行走/做动作，直至走出窗口或窗口消失');
  }

  /** 「飞行途中被窗顶接住」的判定在 `update()` 里每帧同步执行（见「空中宠物：窗顶穿越检测」段）：
   *  下落中的宠物一旦从上方**穿过**某窗口顶边，就地 `bindNow` 站上去——
   *  不再先落到地面再走回去（旧版也不走回去），也不会越过窗口飞出屏幕。
   *  不再单独暴露成方法：判定要读「上一帧脚底」做穿越检测，这段状态天然属于主循环。 */

  /**
   * 「搬走并甩出窗口」整段演出（复刻原桌宠 ThrowIEFromLeft / ThrowIEFromRight）。
   *
   * 编排：选窗口 → 走到窗口左/右下角正下方 → 跳上去抓住 → 带着窗口落回地面 →
   *       扛着走向屏幕另一侧 → 甩出 → 收尾。
   *
   * 抓哪一侧：优先沿用原版的判断（角色在窗口左边 → 从左侧抓；在右边 → 从右侧抓；
   * 角色正好在窗口正下方时才退化为「哪边留白多用哪边」）。
   * 全程 `pet.isWindowHeld = true` 冻结 Pet 的行为/物理（只保留帧动画）——
   * 位移与帧切换都由本状态机负责，避免与 stepWalk / stepClimb 抢人。
   *
   * @param whitelist 「可互动窗口」名单（标题**包含**任一字符串即命中，区分大小写，同原版
   *                  settings.properties 的 InteractiveWindows）；空/未传 = 不限制。
   */
  async startThrowShow(pet: Pet, whitelist?: string[]): Promise<boolean> {
    if (!(await this.isAvailable())) { log('warn', '[winthrow] winapi 不可用'); return false; }
    if (pet.isDraggingAction() || pet.isLeaving()) return false;
    // 【先落地再开始】人若在墙上 / 贴顶 / 飞行 / 半空，先掉回地面再走 ——
    // 否则 stepWalk 只改 x 不改 y，角色会「飘」在半空横移到窗口旁边，到位后又突然被拍到地面。
    if (pet.isAirborne()) {
      log('info', '[winthrow] 角色不在可用地面，先落地再开始');
      pet.queueOnLandAndDrop(() => { void this.startThrowShow(pet, whitelist); }, this.resolver);
      return true;
    }
    // 同一时刻只允许一个投掷演出（WindowInteract 只维护一份 show 状态）。
    // 若已有演出进行中（含别的宠物正在抛掷），直接跳过本次触发、等上一场结束再掷——
    // 否则下面首行的 stop() 会把进行中的 show 清空却不收尾，导致那只宠物卡死在 throwWindow 帧。
    if (this.show) {
      log('warn', '[winthrow] 已有投掷演出进行中，本次触发跳过（等上一场结束）');
      return false;
    }
    this.releaseFor(pet); // 只放掉这只自己的占用；不能用 stop()——那会把别的宠物从窗顶赶下来
    if (this.carry) { this.carry.pet.isWindowHeld = false; this.carry = null; } // carry 是单例，接管前先放掉别人的
    let wins: WinInfo[] = [];
    try {
      wins = await ipcRenderer.invoke('win-list', whitelist ?? this.whitelist);
    } catch (e) {
      log('warn', '[winthrow] 枚举窗口失败: ' + String(e));
      return false;
    }
    if (!wins || wins.length === 0) {
      log('warn', '[winthrow] 名单里没有匹配到任何窗口（右键 →「自定义可互动窗口…」可增减名单）');
      return false;
    }

    const petW = pet.config.size.width;
    const petH = pet.config.size.height;
    const petCx = pet.container.x + petW / 2;
    const petFeetY = pet.container.y + petH;

    /** 原版触发条件：窗口底边比角色脚底高 64px 以上，且角色在窗口左/右两侧之一。
     *  仅用于日志标注（是否满足原版条件），不再参与选窗。 */
    const meetsOriginal = (w: WinInfo) =>
      (w.y + w.h) < petFeetY - WIN_BOTTOM_TO_FEET && (petCx < w.x || petCx > w.x + w.w);
    // 选窗：取「未被遮挡且 Z 序最靠前」的可互动窗口，复刻原版 Shimeji findActiveIE（Z 序枚举命中即停）
    // + 遮挡校验（2026-09-29 方案②）：白名单窗口可能被更大的非白名单窗口（典型：最大化的文档）盖住，
    //   用户看不见它，抓它就是「空手抛掷」。被遮的跳过；全被遮则放弃演出。
    // 位置无关：原版本就不看角色在哪，角色会自己走到该窗口正下方再跳起。
    const best = this.pickTopmost(wins);
    if (!best) {
      log('warn', '[winthrow] 可互动窗口 ' + wins.length + ' 个但全部被更高层的窗口遮挡（如最大化的全屏文档），'
        + '放弃演出避免「空手抛掷」：' + wins.map((w) => '「' + w.title + '」').join('、'));
      return false;
    }
    const exact = meetsOriginal(best);

    // carry 往哪侧扛：角色原本在窗口左→往右扛(dir=1)，在右→往左扛(dir=-1)；
    // 已在正下方时按窗口在屏幕哪侧更空决定（往空侧扛，观感自然）。
    let dir: 1 | -1;
    if (petCx < best.x) dir = 1;
    else if (petCx > best.x + best.w) dir = -1;
    else dir = best.x >= (window.innerWidth - (best.x + best.w)) ? 1 : -1;

    // 角色走到窗口**正下方**（中心对齐），而非原版左/右下角：carry 阶段窗口是居中举在角色正上方，
    // 若起跳点在窗边会造成「跳起后窗口突兀偏移到角色头顶中央」的断层，正下方起跳全程连贯。
    const cornerCenterX = best.x + best.w / 2;
    // 原版 TargetY = IE.bottom + 64（mascot.anchor.y 目标）→ 脚底落在窗口底边下方 64px
    const groundTopY = pet.groundY();
    const rawTopY = (best.y + best.h) + WIN_BOTTOM_TO_FEET - petH;
    // 目标低于地面说明窗口压在角色下方（原版不会触发这种情形）→ 不"往下跳"，落地即为终点。
    // 同时夹到 y>=0：窗口贴近屏幕顶部时原版可以跳到屏幕外去抓，但桌宠跳出去会从画面消失，
    // 这里改成「在屏幕内能到的最高点抓住」——抓取瞬间窗口被拉到角色身上（观感 = 角色把它拽下来）。
    const jumpTopY = Math.max(0, Math.min(rawTopY, groundTopY));
    if (jumpTopY > groundTopY - 1) {
      log('warn', '[winthrow] 「' + best.title + '」底边未高于角色脚底 ' + WIN_BOTTOM_TO_FEET
        + 'px（未满足原版触发条件），将不上跳、直接原地把窗口抬起来');
    }

    // 原版扛着走的目标：ThrowIEFromLeft → workArea.right-200；ThrowIEFromRight → workArea.left+250
    const carryAnchorX = dir === 1 ? window.innerWidth - 200 : 250;
    const targetX = Math.max(0, Math.min(window.innerWidth - petW, carryAnchorX - petW / 2));
    // 扛窗阶段统一用跑速（CARRY_RUN_SPEED，原版 RunWithIe），不再随机走/跑（2026-09-27 用户要保留快的那档）
    const run = true;

    this.show = {
      pet, phase: 'walk',
      hwnd: best.hwnd, title: best.title, winW: best.w, winH: best.h,
      dir, cornerCenterX, jumpTopY, targetX, run,
      phaseUntil: performance.now() + T_WALK_MS,
      lastSync: 0,
      lastTick: 0,
    };
    log('info', '[winthrow] 选中最顶层(最靠前)的可互动窗口「' + best.title + '」' + best.w + 'x' + best.h + ' @' + Math.round(best.x) + ',' + Math.round(best.y)
      + (best.z !== undefined ? '（Z序#' + best.z + '）' : '')
      + (wins.some((w) => w.occluded) ? '；已跳过被遮挡的 ' + wins.filter((w) => w.occluded).length + ' 个候选' : '')
      + (exact ? '' : '；未满足原版触发条件：窗口底边须高于角色脚底 64px 且角色在窗口左/右侧')
      + '；往' + (dir === 1 ? '右' : '左') + '侧扛（原版 ThrowIEFrom' + (dir === 1 ? 'Left' : 'Right') + '）'
      + '，' + (run ? '奔跑' : '步行') + '（原版 RunWithIe/WalkWithIe）'
      + '；走到 x=' + Math.round(cornerCenterX - petW / 2) + '，跳上 y=' + Math.round(jumpTopY)
      + '，终点 x=' + Math.round(targetX));
    // 走到窗口正下方（中心对齐）再起跳：复用 walkToX（自带到达检测）
    pet.walkToX(cornerCenterX - petW / 2, this.resolver, () => this.enterJump());
    return true;
  }

  /** 「窗口归还」：先中止一切正在进行的搬运/投掷演出（否则会一边归还、一边又被搬走），
   *  再把主进程账本里所有被本程序移动过的窗口移回原位。返回成功恢复的数量。
   *  账本在主进程（winapi 的 movedOrigins），只包含真的动过的窗口，与名单无关。 */
  async restoreWindows(): Promise<number> {
    if (!(await this.isAvailable())) { log('warn', '[winrestore] winapi 不可用'); return 0; }
    this.stop();
    let n = 0;
    try {
      n = await ipcRenderer.invoke('win-restore');
    } catch (e) {
      log('warn', '[winrestore] 归还失败: ' + String(e));
      return 0;
    }
    log('info', '[winrestore] 窗口归还完成，恢复 ' + n + ' 个窗口');
    return n;
  }

  /** 停止**所有**窗口交互（全部宠物的站窗 + 单例 carry/show）。
   *  用于「窗口归还」等全局收尾。⚠️ 单只宠物换动作/退场请用 releaseFor(pet)——
   *  在多宠场景用 stop() 会把别的宠物从窗顶一起赶下来；日常一律走 releaseFor。 */
  stop() {
    for (const pet of [...this.bound.keys()]) this.releaseBound(pet);
    if (this.carry) this.carry.pet.isWindowHeld = false;
    if (this.show) {
      // ⚠️ 不能只做 `pet.isWindowHeld=false; show=null`：那会把宠物**留在 throwWindow 帧上、
      // 又不再有任何代码推进它的动作** → 永久定格（截图里格温卡在 L-throw-3 就是这原因）。
      // 典型触发：另一只宠物并发触发投掷，startThrowShow 首行的 stop() 把这只正在 throw 阶段的
      // 宠物 show 清空却不走 finishShow 收尾。这里补上「释放占用 + 切回默认动作」，与 finishShow
      // 同款处理，被中止的宠物才能正常回到待机而不是卡死。
      const pet = this.show.pet;
      this.show = null;
      pet.isWindowHeld = false;
      pet.resumeAfterMenu(); // 清掉可能残留的「非地面 standStill 冻结」（menuHold），否则释放后角色定住不动
      if (!pet.isDraggingAction() && !pet.isLeaving()) {
        pet.setAction(pet.config.defaultAction || 'idle', this.resolver);
      }
      log('info', '[winthrow] 投掷演出被中止，宠物已释放回默认动作');
    }
    this.carry = null;
  }

  /** 只释放**指定宠物**的窗口占用（站窗 / 搬运 / 投掷演出），不影响别的宠物。
   *  多宠场景下换动作 / 退场 / 覆盖站窗都该走这个，而不是全局 stop()。 */
  releaseFor(pet: Pet) {
    if (this.bound.has(pet)) this.releaseBound(pet);
    if (this.carry && this.carry.pet === pet) { this.carry.pet.isWindowHeld = false; this.carry = null; }
    if (this.show && this.show.pet === pet) this.finishShow();
  }

  /** 解除一只宠物的站窗绑定：**把地面换回屏幕底边** → 她自然从窗顶高度掉回地面（Pet 物理接管）。
   *  触发来源：窗口消失 / 走出窗口跨度 / 被用户拖拽 / 换动作 / 退场。
   *  ⚠️ 必须清 `groundOverrideY` 与 `onWindowTop`：否则她的地面永远停在窗顶高度，会浮在半空走。
   *  ⚠️ 必须写 bindBlockUntil 冷却 + 清 lastFeetY：
   *     否则「刚放手 → 脚底仍贴顶边 → 下一帧又被判定为落在顶边」会立刻重新绑回去。 */
  private releaseBound(pet: Pet, reason: 'lost' | 'jump' = 'lost') {
    if (!this.bound.has(pet)) return;
    this.bound.delete(pet);
    this.ceiling.cancel(pet); // 不在窗顶了 → 窗顶行为编排一并作废
    pet.onWindowTop = false;
    pet.groundOverrideY = null; // 地面还原为屏幕底边 → 从窗顶高度自然落体
    pet.resumeAfterMenu(); // 清掉可能残留的 menuHold 冻结，否则释放后角色定住不掉
    if (!pet.isDraggingAction() && !pet.isLeaving()) {
      pet.setAction(pet.config.defaultAction || 'idle', this.resolver);
    }
    // ⚠️ 'jump'（主动从窗边跃下）必须给更长的冷却：她起跳后会在 ~700ms 时**重新落到窗顶高度**，
    //    那一帧正好满足「下落中从上方穿过顶边」的接住条件（gravity=0.5、vy≈10.4 → 2vy/g≈695ms）。
    //    700ms 冷却只剩 5ms 余量 → 会被自己接回窗顶，看上去就是「跳了个寂寞」。故 jump 取 1500ms。
    this.bindBlockUntil.set(pet, performance.now() + (reason === 'jump' ? 1500 : 700));
    this.lastFeetY.delete(pet);
  }

  /** 主循环驱动（app.ticker 每帧调用，传入当前所有宠物）。做两件事：
   *   1) 已站窗顶的宠物：把窗顶作为**地面**持续同步（窗口移动 → 地面跟着移动 + 横向位移叠加）；
   *      走出窗口跨度 / 被拖拽 / 退场 / 窗口消失 → 释放（地面还原 → 自然掉回地面）。
   *      ⚠️ 这里**不碰角色的行为**——她在窗顶上走/跑/待机/做动作全部由 Pet 自己跑（见 groundOverrideY）。
   *   2) 空中宠物：下落中从上方穿过某窗口顶边 → 就地站上去（旧版 Border 接住，不会被甩出屏幕）。 */
  update(pets: Pet[]) {
    const now = performance.now();
    // 刷新窗口缓存（节流 ~10fps）：供「跟随」与「窗顶穿越检测」每帧同步读取，避免每帧 IPC 枚举窗口。
    if (now - this.winCacheAt >= 100) {
      this.winCacheAt = now;
      if (this.available === null) {
        ipcRenderer.invoke('win-available').then((ok: any) => { this.available = !!ok; }).catch(() => { this.available = false; });
      }
      // ⚠️ 必须传白名单：不传 = 所有窗口都进缓存 = 「任何窗口都能站」
      ipcRenderer.invoke('win-list', this.whitelist).then((w: WinInfo[] | null) => { if (w) this.winCache = w; }).catch(() => {});
    }
    // ⚠️ 「最上层」闸门：只有当前 Z 序最靠前且未被完全遮挡的那扇窗才能站人。
    //    名单里出现更靠前的窗口 / 本窗被压到下面 → 已站的掉下来、空中的不再接（2026-10-11 用户要求）。
    const top = this.pickTopmost(this.winCache);
    // —— 1) 已绑定：跟随窗口；窗口消失 / 被拖拽 / 退场 / 踩空 / 不再是最上层 → 释放掉落 ——
    for (const [pet, b] of [...this.bound.entries()]) {
      if (pet.isLeaving() || pet.isDraggingAction()) { this.releaseBound(pet); continue; }
      const w = this.winCache.find((x) => x.hwnd === b.hwnd && !x.occluded);
      if (!w) { this.releaseBound(pet); continue; } // 窗口被关/最小化/不再名单里 → 掉下来
      if (top && w.hwnd !== top.hwnd) {
        log('info', '[winledge] 窗口「' + w.title.slice(0, 20) + '」已不在最上层（上层是「'
          + top.title.slice(0, 20) + '」），掉下来');
        this.releaseBound(pet);
        continue;
      }
      if (!this.syncBound(pet, b, w, now)) {
        log('info', '[winledge] 锚点水平离开窗口跨度（旧版 isOn 不成立），掉下去');
        this.releaseBound(pet);
        continue;
      }
      // 窗顶上的自主漫游（wander）目标点夹进窗口跨度：否则她随便走两步就走出窗沿掉下去，
      // 「站在窗顶」会变成「站一秒就掉」。带到达回调的编排（走到窗边再跳下）不受影响。
      pet.clampWalkTarget(w.x, w.x + w.w - pet.config.size.width);
      if (this.topBehaviorEnabled) this.ceiling.update(pet, w, now);
      else if (this.ceiling.busy(pet)) this.ceiling.cancel(pet);
    }
    // —— 2) 空中宠物：窗顶穿越检测 ——
    for (const pet of pets) {
      if (pet.isWindowHeld || pet.isLeaving() || pet.isDraggingAction() || this.bound.has(pet)) continue;
      if (now < (this.bindBlockUntil.get(pet) ?? 0)) { this.lastFeetY.delete(pet); continue; }
      const beh = pet.currentBehavior();
      if (beh === 'climb' || beh === 'ceiling' || beh === 'fly' || beh === 'drag') { this.lastFeetY.delete(pet); continue; }
      const petH = pet.config.size.height;
      const feetY = pet.container.y + petH;
      const prev = this.lastFeetY.get(pet); // ⚠️ 必须在被覆盖前取到上一帧脚底
      this.lastFeetY.set(pet, feetY);
      if (!pet.isAirborne()) continue; // 只接「离地」的角色——地面上的角色永不误接
      if (pet.velocityY() < 0) continue; // 只接下落中的（上升中的不接）
      if (!this.winCache.length) continue;
      const petW = pet.config.size.width;
      const cx = pet.container.x + petW / 2;
      for (const w of this.winCache) {
        if (w.occluded) continue;
        if (top && w.hwnd !== top.hwnd) continue; // 不是最上层那扇 → 不接（让她继续落到地面）
        if (cx < w.x || cx > w.x + w.w) continue;
        // 穿越检测：上一帧脚底还在顶边**上方**、这一帧到了顶边或下方 → 被窗顶接住
        const crossed = prev !== undefined && prev < w.y && feetY >= w.y;
        // 兜底：单帧位移极大时可能整帧跨过而 crossed 不成立，这里再认一个「紧贴顶边」的小范围
        const atTop = feetY >= w.y - 2 && feetY <= w.y + 14;
        if (crossed || atTop) { this.bindNow(pet, w); break; }
      }
    }
    if (this.carry) this.updateCarry(now);
    if (this.show) this.updateShow(now);
  }

  /** 复刻旧版 `BorderedAction.tick()` 里那唯一一行 —— `anchor = border.move(anchor)`。
   *
   *  旧版**没有**任何「绑定到窗口」的持久状态：每个带 `BorderType=Floor` 的动作在每 tick 都把
   *  角色的锚点交给 Border 去搬一次；搬得动就跟着窗口走，搬不动（超守卫阈值）就停在原地 →
   *  下一帧 `isOn()` 不成立 → 抛 LostGroundException → 改播下落。全部行为由此自然涌现。
   *
   *  本程序等价实现：
   *   1) 地面 = 窗顶（`pet.groundOverrideY`）—— 之后走路/待机/做动作/踩空下落全部由 Pet 自己跑，
   *      与站在地面上完全一致（旧版窗顶与地面同为 `FloorCeiling`，只在 `isOn` 上差一个矩形来源）。
   *   2) 把窗口本轮位移**搬运**到角色身上（横向 +dX、竖直 +dY），但超守卫阈值就不搬（= 旧版放弃跟随）。
   *      ⚠️ 绝不能用「lerp 到 w.x + relX」：那会和她自己的走路位移抢 x，表现为走不动 / 被拽回原位。
   *   3) 脱离判定 = 旧版 `FloorCeiling.isOn()`：**只看横向**，锚点（脚底中心）必须落在窗口跨度内。
   *      ⚠️ 竖直方向**没有**脱离阈值 —— 悬空再高也只是「还没落到窗顶」，由 Pet 重力一直追下去。
   *
   *  @returns false = 锚点水平离开窗口跨度（旧版 isOn 不成立）→ 调用方应 releaseBound。 */
  private syncBound(pet: Pet, b: { hwnd: number; prevWinX: number; prevWinY: number; prevAt: number },
    w: WinInfo, now: number): boolean {
    const petH = pet.config.size.height;
    // 1) 地面 = 窗顶（竖直方向的事全部交给 Pet 的物理）
    pet.groundOverrideY = w.y - petH;

    // 2) 搬运窗口位移（旧版 Border.move），带守卫阈值
    const dx = w.x - b.prevWinX;
    const dy = w.y - b.prevWinY;
    const elapsed = Math.max(1, now - b.prevAt); // 采样间隔（窗口缓存 ~100ms 刷一次）
    const k = elapsed / SHIMEJI_TICK_MS;         // 把「每 40ms」的阈值缩放到实际间隔
    b.prevWinX = w.x; b.prevWinY = w.y; b.prevAt = now;

    // 旧版守卫：任一方向位移超限 → 本轮**完全不搬运**（两个方向各自判定，与旧版两个 if 一致）
    const followX = Math.abs(dx) < FOLLOW_MAX_DX * k;
    const followY = dy <= FOLLOW_MAX_DOWN * k && dy >= -FOLLOW_MAX_UP * k;
    if (followX && dx !== 0) pet.container.x += dx;
    if (followY && dy !== 0) pet.container.y += dy;
    // 不搬运的情形：
    //   窗口下移过快 → 角色留在上方 → 相对窗顶悬空 → Pet 重力接管 → 自由落体**落回窗顶**（不是掉到地面！）
    //   窗口横向跳太远 → 角色被落下 → 多半同时满足下面的横向脱离 → 掉回地面
    // ⚠️ 窗口**上移**过快（dy 为负且超阈值）是唯一需要特判的一支：角色会被留在窗顶**下方**，
    //    此时 `container.y > baselineY()` 不算 airborne、`physicsActive()` 为假 → 没人把她纠正出来，
    //    她会陷在窗顶里面。旧版这里同样是不跟随 → `isOn()` 不成立 → 抛 LostGround → 改播下落，
    //    所以这里直接返回 false 走 releaseBound（地面还原为屏幕底边 → 她掉回地面）。
    if (!followY && dy < 0) return false;

    // 3) 脱离判定（旧版 isOn）：锚点 = 脚底中心，横向必须落在 [窗口左, 窗口右] 内
    const cx = pet.container.x + pet.config.size.width / 2;
    return cx >= w.x && cx <= w.x + w.w;
  }

  // ============ 投掷演出：阶段推进（对齐原版 ThrowIEFromLeft/Right 的 Sequence） ============

  /** walk 到达窗口下角 → 原版 Jumpingx：跳上去，脚底停在「窗口底边 + 64」。 */
  private enterJump() {
    const s = this.show;
    if (!s) return;
    const pet = s.pet;
    if (pet.isDraggingAction() || pet.isLeaving()) { this.finishShow(); return; }
    // 从这里开始行为/物理全交给我们（Pet.update 只推进帧动画）
    pet.isWindowHeld = true;
    pet.setFacingDir(s.dir > 0); // 先定朝向，再切帧集（反了会出「翻了一半」的中转帧）
    pet.setAction('jumpWindow', this.resolver);
    s.phase = 'jump';
    s.phaseUntil = performance.now() + T_JUMP_MS;
    log('info', '[winthrow] 起跳抓「' + s.title + '」：y ' + Math.round(pet.container.y) + ' → ' + Math.round(s.jumpTopY));
  }

  /** 原版 FallWithIe：抓住窗口（窗口吸到身上），窗口底边贴住角色脚底上方 64px。 */
  private enterGrab() {
    const s = this.show;
    if (!s) return;
    const pet = s.pet;
    if (pet.isDraggingAction() || pet.isLeaving()) { this.finishShow(); return; }
    pet.isWindowHeld = true;
    pet.container.y = s.jumpTopY;
    pet.setFacingDir(s.dir > 0);
    pet.setAction('grabWindow', this.resolver);
    this.placeHeldWindow(s);
    s.phase = 'grab';
    s.phaseUntil = performance.now() + T_GRAB_MS;
    log('info', '[winthrow] 在下角抓住「' + s.title + '」（窗口底边 = 脚底上方 ' + WIN_BOTTOM_TO_FEET + 'px）');
  }

  /** 原版 FallWithIe → 带着窗口落回地面（窗口被一起拖下来）。 */
  private enterFall() {
    const s = this.show;
    if (!s) return;
    if (s.pet.isDraggingAction() || s.pet.isLeaving()) { this.finishShow(); return; }
    // 原版 FallWithIe 的帧就是 shime36（= 我们的 carry-2 / grabWindow）
    s.pet.setAction('grabWindow', this.resolver);
    s.phase = 'fall';
    s.lastSync = 0;
    s.phaseUntil = performance.now() + T_FALL_MS;
    log('info', '[winthrow] 带着「' + s.title + '」落地（原版 FallWithIe）');
  }

  /** 原版 WalkWithIe / RunWithIe：扛着窗口走向屏幕另一侧。 */
  private enterCarry() {
    const s = this.show;
    if (!s) return;
    if (s.pet.isDraggingAction() || s.pet.isLeaving()) { this.finishShow(); return; }
    s.pet.setAction('carryWindow', this.resolver);
    s.phase = 'carry';
    s.lastSync = 0;
    s.phaseUntil = performance.now() + T_CARRY_MS;
    log('info', '[winthrow] 扛着「' + s.title + '」向' + (s.dir === 1 ? '右' : '左') + (s.run ? '奔跑' : '走')
      + '，目标 x=' + Math.round(s.targetX));
  }

  /** 原版 ThrowIe：InitialVX=32 / InitialVY=-10，甩出去。 */
  private enterThrow() {
    const s = this.show;
    if (!s) return;
    if (s.pet.isDraggingAction() || s.pet.isLeaving()) { this.finishShow(); return; }
    s.pet.setFacingDir(s.dir > 0);
    s.pet.setAction('throwWindow', this.resolver);
    s.phase = 'throw';
    s.phaseUntil = performance.now() + T_THROW_MS;
    // 原版 ThrowIe：InitialVX=32 / InitialVY=-10，单位是「每 40ms tick 的像素」。
    // 主进程 throwWindow 逐字复刻了 ThrowIE.tick 的增量算法（水平恒定 32px/tick、垂直 -10+0.5·t），
    // 并且和原版一样**不做边界夹取** —— 窗口会被真的甩出屏幕（用「窗口归还」可拉回）。
    const vx = 32 * s.dir;
    ipcRenderer.invoke('win-throw', s.hwnd, vx, -10).catch(() => {});
    log('info', '[winthrow] 甩出「' + s.title + '」vx=' + vx + ' vy=-10（原版 ThrowIe；若被甩出屏幕可用「窗口归还」拉回）');
  }

  /** 演出收尾：释放占用，回到待机（窗口留在它落地的位置）。 */
  private finishShow() {
    const s = this.show;
    this.show = null;
    if (!s) return;
    s.pet.isWindowHeld = false;
    if (!s.pet.isDraggingAction() && !s.pet.isLeaving()) {
      s.pet.setAction(s.pet.config.defaultAction || 'idle', this.resolver);
    }
    log('info', '[winthrow] 演出结束');
  }

  /** 每帧推进投掷演出。 */
  private updateShow(now: number) {
    const s = this.show;
    if (!s) return;
    const pet = s.pet;
    // 被拖拽 / 退场打断 → 立即收尾（窗口停在原地，不会跟着乱飞）
    if (pet.isLeaving() || pet.isDraggingAction()) {
      log('info', '[winthrow] 被拖拽/退场打断，收尾');
      this.finishShow();
      return;
    }
    // 动作被外部改掉（右键菜单 standStill、其它调度抢人）→ 演出作废，
    // 避免「位置被我们锁着、帧却在播别的动作」。只对自持阶段校验：
    // walk 阶段动作由 stepWalk 决定（配了 walkActionLeft/Right 的角色会随方向换 id），按名字一刀切会误判。
    if (s.phase !== 'walk') {
      const expect = s.phase === 'jump' ? 'jumpWindow' : s.phase === 'grab' || s.phase === 'fall'
        ? 'grabWindow' : s.phase === 'carry' ? 'carryWindow' : 'throwWindow';
      if (pet.currentActionId !== expect) {
        log('info', '[winthrow] 动作被切换为 ' + pet.currentActionId + '，演出中止');
        this.finishShow();
        return;
      }
    }
    if (now > s.phaseUntil) {
      // grab / throw 是「定时推进」的两个阶段（到时进入下一段 / 收尾）；其余阶段的 phaseUntil 只是安全上限
      if (s.phase === 'grab') { this.enterFall(); return; }
      if (s.phase === 'throw') { this.finishShow(); return; }
      log('warn', '[winthrow] 阶段 ' + s.phase + ' 超时，收尾');
      this.finishShow();
      return;
    }

    const dt = s.lastTick ? Math.min(60, now - s.lastTick) : 16.7; // 按真实帧间隔推进（帧率无关）
    s.lastTick = now;
    switch (s.phase) {
      case 'jump': {
        const y = pet.container.y;
        if (y - s.jumpTopY <= 1) { this.enterGrab(); return; }
        pet.container.y = Math.max(s.jumpTopY, y - JUMP_SPEED * dt);
        return;
      }
      case 'fall': {
        const ground = pet.groundY();
        const y = pet.container.y;
        const next = Math.min(ground, y + FALL_SPEED * dt);
        pet.container.y = next;
        if (now - s.lastSync >= 33) { s.lastSync = now; this.placeHeldWindow(s); }
        if (next >= ground - 0.5) { pet.container.y = ground; this.placeHeldWindow(s); this.enterCarry(); }
        return;
      }
      case 'carry': {
        const petW = pet.config.size.width;
        const maxX = Math.max(0, window.innerWidth - petW);
        const speed = s.run ? CARRY_RUN_SPEED : CARRY_WALK_SPEED;
        let x = pet.container.x + speed * dt * s.dir;
        const arrived = (s.dir > 0 && x >= s.targetX) || (s.dir < 0 && x <= s.targetX);
        if (arrived) x = s.targetX;
        pet.container.x = Math.max(0, Math.min(maxX, x));
        if (now - s.lastSync >= 33) { s.lastSync = now; this.placeHeldWindow(s); }
        if (arrived) { this.placeHeldWindow(s); this.enterThrow(); }
        return;
      }
      default:
        return; // walk / grab / throw 由回调或定时推进
    }
  }

  /** 把被扛着的窗口放到「双手举过头顶」的相对位置：
   *  垂直：窗口底边 = 角色脚底上方 64px（= 抬起的手的高度，拳头压住窗口底边），
   *        窗口整体向上延伸、罩在角色图片上方（角色画在窗口前面，不会被挡住）；
   *  水平：窗口**中心**对齐角色中心。
   *        ⚠️ 不用原版 WalkWithIE 的「边缘对齐角色中心」公式——那会让半个窗口悬在
   *        角色旁边的空气里，观感是「扛在肩侧」；用户拍板（2026-09-25）改为居中举起。
   *  ⚠️ 投掷演出**不做任何边界夹取**（直接 win-move），让窗口随角色自由出屏——
   *     对齐原版 Shimeji 把窗口拖出屏外。走 placeWindow(..., false) 的「宽松夹取」在
   *     winW>innerWidth 时会把窗口右缘锁死在屏幕右缘，正是「举到屏幕边缘被抵住」的观感根因；
   *     真正的出屏交给 win-throw 甩出 + 窗口归还拉回。 */
  private placeHeldWindow(s: ThrowShow) {
    const pet = s.pet;
    const petCx = pet.container.x + pet.config.size.width / 2;
    const feetY = pet.container.y + pet.config.size.height;
    const x = petCx - s.winW / 2;
    const y = feetY - WIN_BOTTOM_TO_FEET - s.winH;
    ipcRenderer.invoke('win-move', s.hwnd, x, y);
  }

  /** 移动窗口到指定位置（窗口左上角坐标）。
   *  keepOnScreen=true 时把窗口夹进屏幕内（旧的拖拽搬运语义）；
   *  false 时只做「至少留一部分在屏内」的宽松夹取——原版搬窗口会把窗口拖到屏幕外，
   *  严格夹取反而会让「窗口底边贴脚底上方 64px」的几何关系失真。 */
  private placeWindow(hwnd: number, x: number, y: number, winW: number, winH: number, keepOnScreen: boolean) {
    if (keepOnScreen) {
      x = Math.max(0, Math.min(x, Math.max(0, window.innerWidth - winW)));
      y = Math.max(0, Math.min(y, Math.max(0, window.innerHeight - winH)));
    } else {
      const minX = Math.min(0, window.innerWidth - winW);
      const maxX = Math.max(0, window.innerWidth - winW);
      x = Math.max(minX, Math.min(x, maxX));
    }
    ipcRenderer.invoke('win-move', hwnd, x, y);
  }

  // ============ carry / ledge ============

  /** carry：窗口跟随宠物头顶（节流 ~30fps）；拖拽松手 → 按指针速度抛出窗口。 */
  private updateCarry(now: number) {
    const c = this.carry!;
    const pet = c.pet;
    // 速度估算（px/frame → 供抛出初速度）
    const dx = pet.container.x - c.lastPetX;
    const dy = pet.container.y - c.lastPetY;
    if (Math.abs(dx) < 200 && Math.abs(dy) < 200) {
      c.velX = c.velX * 0.6 + dx * 0.4;
      c.velY = c.velY * 0.6 + dy * 0.4;
    }
    c.lastPetX = pet.container.x;
    c.lastPetY = pet.container.y;
    const dragging = pet.isDraggingAction();
    // 拖拽结束（松手）→ 掏出窗口：指针速度是 px/帧(~16ms)，而 win-throw 的单位是原版的 px/40ms，
    // 故乘 2.4 换算后再夹到 ±40（避免用力一甩把窗口甩飞到屏幕外）。
    if (c.wasDragging && !dragging) {
      const vx = Math.max(-40, Math.min(40, c.velX * 2.4));
      const vy = Math.max(-40, Math.min(40, c.velY * 2.4));
      ipcRenderer.invoke('win-throw', c.hwnd, vx, vy).catch(() => {});
      log('info', 'threw window vx=' + vx.toFixed(1) + ' vy=' + vy.toFixed(1));
      this.releaseFor(c.pet);
      return;
    }
    c.wasDragging = dragging;
    // 超时自动放下（防止永久占用）
    if (now - c.startedAt > 30000) {
      log('info', 'carry timeout, releasing');
      this.releaseFor(c.pet);
      return;
    }
    // 窗口跟随（节流）
    if (now - c.lastSync >= 33) {
      c.lastSync = now;
      const petW = pet.config.size.width;
      this.placeWindow(c.hwnd, pet.container.x + petW / 2 - c.winW / 2, pet.container.y - c.winH,
        c.winW, c.winH, true);
    }
  }

}
