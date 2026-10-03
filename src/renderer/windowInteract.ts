/**
 * 窗口交互（渲染层）：
 * - carry：窗口吸附在宠物头顶跟随移动；拖拽宠物即拖动窗口，松手按指针速度把窗口抛出（主进程模拟重力）。
 * - ledge：宠物站在最近窗口的顶边，随窗口移动；窗口消失/超时则物理掉落。
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

export class WindowInteract {
  private resolver: SpriteResolver;
  private carry: {
    pet: Pet; hwnd: number; winW: number; winH: number;
    lastSync: number; startedAt: number; wasDragging: boolean;
    lastPetX: number; lastPetY: number; velX: number; velY: number;
  } | null = null;
  private ledge: {
    pet: Pet; hwnd: number; relX: number;
    nextPoll: number; deadline: number; lastRect: { x: number; y: number; w: number; h: number } | null;
  } | null = null;
  private show: ThrowShow | null = null;
  private available: boolean | null = null;

  constructor(resolver: SpriteResolver) {
    this.resolver = resolver;
  }

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
    const wins: WinInfo[] = await ipcRenderer.invoke('win-list');
    if (!wins || wins.length === 0) return null;
    const best = this.pickTopmost(wins);
    if (!best && wins.length > 0) {
      log('warn', '可互动窗口 ' + wins.length + ' 个但全部被更高层的窗口遮挡，放弃（把上层窗口挪开或最小化后再试）');
    }
    return best;
  }

  /** 从候选窗口里取「未被遮挡且 Z 序最靠前」的（z 最小）。listWindows 已按 Z 序顶→底枚举，
   *  这里显式取 min(z) 以容忍任何重排；occluded 的候选跳过（除非全部被遮 → 返回 null）。 */
  private pickTopmost(wins: WinInfo[]): WinInfo | null {
    let best: WinInfo | null = null;
    let bestZ = Infinity;
    for (const w of wins) {
      if (w.occluded) continue;
      const z = w.z ?? 0;
      if (z < bestZ) { bestZ = z; best = w; }
    }
    return best;
  }

  /** 搬运窗口：窗口吸附宠物头顶。 */
  async startCarry(pet: Pet): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    this.stop();
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

  /** 挂窗沿：宠物站到最顶层(最靠前)的可互动窗口的顶边。 */
  async startLedge(pet: Pet): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    this.stop();
    const win = await this.topmostWindow(pet);
    if (!win) { log('warn', 'no window to stand on'); return false; }
    pet.standStill(this.resolver);
    pet.isWindowHeld = true;
    // 站在窗口顶边，横向取窗口中心附近
    const relX = Math.max(0, Math.min(win.w - pet.config.size.width, win.w / 2 - pet.config.size.width / 2));
    pet.container.x = win.x + relX;
    pet.container.y = win.y - pet.config.size.height;
    this.ledge = {
      pet, hwnd: win.hwnd, relX,
      nextPoll: 0,
      deadline: performance.now() + 6000 + Math.random() * 9000,
      lastRect: { x: win.x, y: win.y, w: win.w, h: win.h },
    };
    log('info', 'standing on window ' + win.hwnd + ' (' + win.title.slice(0, 20) + ')');
    return true;
  }

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
    this.stop();
    let wins: WinInfo[] = [];
    try {
      wins = await ipcRenderer.invoke('win-list', whitelist);
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
    // 走到窗口正下方（中心对齐）再起跳：复用 walkToX（到达检测 + 「行走中不被边缘攀爬抢人」的守卫）
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

  /** 停止任何窗口交互模式（carry 放下 / ledge 结束 / 投掷演出中止，不触发掉落）。 */
  stop() {
    if (this.carry) this.carry.pet.isWindowHeld = false;
    if (this.ledge) this.ledge.pet.isWindowHeld = false;
    if (this.show) {
      // ⚠️ 不能只做 `pet.isWindowHeld=false; show=null`：那会把宠物**留在 throwWindow 帧上、
      // 又不再有任何代码推进它的动作** → 永久定格（截图里格温卡在 L-throw-3 就是这原因）。
      // 典型触发：另一只宠物并发触发投掷，startThrowShow 首行的 stop() 把这只正在 throw 阶段的
      // 宠物 show 清空却不走 finishShow 收尾。这里补上「释放占用 + 切回默认动作」，与 finishShow
      // 同款处理，被中止的宠物才能正常回到待机而不是卡死。
      const pet = this.show.pet;
      this.show = null;
      pet.isWindowHeld = false;
      if (!pet.isDraggingAction() && !pet.isLeaving()) {
        pet.setAction(pet.config.defaultAction || 'idle', this.resolver);
      }
      log('info', '[winthrow] 投掷演出被中止，宠物已释放回默认动作');
    }
    this.carry = null;
    this.ledge = null;
  }

  /** 主循环驱动（app.ticker 每帧调用）。 */
  update() {
    const now = performance.now();
    if (this.carry) this.updateCarry(now);
    if (this.ledge) this.updateLedge(now);
    if (this.show) this.updateShow(now);
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
      this.stop();
      return;
    }
    c.wasDragging = dragging;
    // 超时自动放下（防止永久占用）
    if (now - c.startedAt > 30000) {
      log('info', 'carry timeout, releasing');
      this.stop();
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

  /** ledge：轮询窗口矩形跟随；窗口没了 / 拖拽 / 超时 → 掉落（物理接管）。 */
  private async updateLedge(now: number) {
    const l = this.ledge!;
    const pet = l.pet;
    if (pet.isDraggingAction() || now > l.deadline) {
      this.dropFromLedge();
      return;
    }
    if (now >= l.nextPoll) {
      l.nextPoll = now + 150;
      try {
        const rect = await ipcRenderer.invoke('win-rect', l.hwnd);
        if (this.ledge !== l) return; // 已掉落/释放，in-flight 结果作废，避免把 pet 拽回窗口坐标
        if (!rect) { this.dropFromLedge(); return; }
        l.lastRect = rect;
        // 窗口宽度变了（最大化等）→ clamp 相对位置
        l.relX = Math.max(0, Math.min(l.relX, rect.w - pet.config.size.width));
        pet.container.x = rect.x + l.relX;
        pet.container.y = rect.y - pet.config.size.height;
      } catch {
        this.dropFromLedge();
      }
    }
  }

  /** 从窗沿掉落：解除挂靠，物理接管（airborne → fall 帧 + 落地弹跳）。 */
  private dropFromLedge() {
    const l = this.ledge!;
    l.pet.isWindowHeld = false;
    l.pet.setAction(l.pet.config.defaultAction || 'idle', this.resolver);
    this.ledge = null;
    log('info', 'dropped from ledge');
  }
}
