import * as PIXI from 'pixi.js';
import { loadUserConfig, loadMeetConfig, MeetConfig, loadWindowConfig, WindowConfig, saveWindowConfig, loadUpdateConfig } from './config';
import { Pet } from './Pet';
import { SpriteResolver } from './SpriteResolver';
import { eventBus, EVENTS } from './eventBus';
import { ContextMenu } from './contextMenu';
import { ManagerPanel } from './managerPanel';
import { setUpdaterConfig, checkForUpdates, setPendingUpdate } from './updater';
import { initMouseTracker } from './mouse';
import { WindowInteract } from './windowInteract';
import { WindowListPanel } from './windowListPanel';
import { SettingsPanel } from './settingsPanel';
import { AboutPanel } from './aboutPanel';
import { supervisorLog } from './supervisor/eventLog';
import { StatusBar } from './supervisor/StatusBar';
import { SupervisorPanel } from './supervisor/SupervisorPanel';

/** 监管日志的安全 emit：永不抛异常 */
function slog(e: Parameters<typeof supervisorLog.emit>[0]) {
  try { supervisorLog.emit(e); } catch { /* swallow */ }
}

// 通过 electron 的 node 集成访问 IPC
const req: any = (window as any).require;
const { ipcRenderer } = req('electron');

function log(level: string, msg: string) {
  console.log('[' + level + '] ' + msg);
  ipcRenderer?.send('renderer-log', level, msg);
}

let app: PIXI.Application;
let pets: Pet[] = [];
let resolver: SpriteResolver;
let winInteract: WindowInteract | null = null;
let configDir = '';
let assetDir = '';
let lastTickerTime = 0; // 渲染心跳：上次 ticker 帧的时间戳（>1s 无帧 = 渲染循环卡死）
let meetCfg: MeetConfig = { chance: 0.02, distance: 200, rollInterval: 500 };
// 窗口互动配置（顶层 "window" 字段）：可互动窗口白名单 + 「搬走并甩出窗口」自动开关
let winCfg: WindowConfig = { whitelist: [], throwEnabled: false, throwRollMs: 60000, throwChance: 0.3 };
let lastRoll = 0; // 上次掷骰时间戳（节流）
let lastThrowRoll = 0; // 上次窗口投掷掷骰时间戳（节流）
const petUpdateErrLogged = new WeakSet<Pet>(); // 每只宠物只记录一次 update 异常，避免日志刷屏

// —— 鼠标穿透单一真相源 ——
// mouseThrough=true 表示「穿透开启」(ignore-mouse-events=true，点击落到桌面)；false 表示「窗口捕获」(ignore=false)。
// 旧实现把穿透开关散落在 Pet 的 pointerover/out、拖拽 onUp、菜单 show/hide、面板里，
// 且用 `Pet.hoveredPet` 守卫「是否重新发 OFF」，导致拖拽结束/菜单关闭后 hoveredPet 残留，
// 悬停不再重发 OFF → 角色点不动，只能靠移动鼠标（点任务栏）自愈。
// 现统一由 reconcile() 根据「光标是否在角色上 + 是否处于阻塞态(菜单/拖拽/面板)」算出一个确定的目标态，
// 仅在状态翻转时发 IPC。任何 mousemove / mouseup / contextmenu / 面板开关都触发 reconcile，自愈无需任务栏。
let mouseThrough = true;
// 角色「始终可被点中」：光标压在任意角色上即捕获（可点击），只有光标在空白桌面才穿透（桌面可点）。
// 不引入「释放保护 / freedPet」之类的跨状态记忆——那会在角色刚落地（摔倒/被放下）时强制保持穿透，
// 导致光标压在角色上点不中（必须移开再移回）。用户明确要求「任何时候都能被点击」。

/** 根据坐标与当前阻塞态，计算并应用正确的鼠标穿透状态（仅在翻转时发 IPC）。 */
function reconcile(x: number, y: number) {
  // 监管面板显示期间：窗口始终穿透（面板 DOM 自带 pointer-events:auto 自交互、桌面其他区域可点），
  // 不进入常规 reconcile，避免切到「全捕获」导致桌面点不了。面板关闭后下一帧 mousemove 自然接管。
  if (SupervisorPanel.isOpen) {
    if (!mouseThrough) {
      ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
      mouseThrough = true;
    }
    return;
  }
  const hovered = Pet.petAt(x, y);
  const overPet = !!hovered;
  const dragging = Pet.getAll().some((p: any) => p.isDragging);
  // 下落中不再强制捕获整个窗口：①光标没压在下落角色上时本就穿透(桌面可点)；
  // ②光标压在下落角色上时 overPet 已会让窗口捕获(可接住)，无需全局拦截。
  // 旧版"接不住直接落地"是 beginDrag→exitCoopAndMeet 误 settle 的 bug，已由 skipSettle + isDragging 后置修复，
  // 故此处不再用 falling 强制 block。
  const hoveredFalling = !!hovered && hovered.isFalling();
  const blocked = Pet.menuOpen || dragging || ManagerPanel.isOpen || WindowListPanel.isOpen
    || SettingsPanel.isOpen || AboutPanel.isOpen;
  // 捕获条件：阻塞态(拖拽/菜单/面板) 或 光标压在任意角色上。
  // 「角色任何时候都能被点击」= 只要 overPet 就捕获，不记忆任何「刚落地/刚释放」状态
  // （旧版 freedPet 释放保护会在角色刚落地时强制穿透，导致光标压在角色上点不中）。
  const capture = blocked || overPet;
  const prevThrough = mouseThrough;
  if (capture) {
    if (mouseThrough) {
      ipcRenderer.send('set-ignore-mouse-events', false);
      mouseThrough = false;
    }
  } else {
    if (!mouseThrough) {
      ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
      mouseThrough = true;
    }
  }
  // 始终维护 hoveredPet（仅页面内变量，供右键菜单/拖拽定位；不影响 OS 级穿透）
  Pet.hoveredPet = hovered;
  // —— 监管埋点：穿透态翻转溯源（拖拽/菜单后残留态定位）——
  if (prevThrough !== mouseThrough) {
    slog({
      level: 'system',
      category: 'mouseThrough.transition',
      before: { mouseThrough: prevThrough },
      after: { mouseThrough, overPet, hovered: hovered?.config.id ?? null, blocked, dragging, hoveredFalling, menuOpen: Pet.menuOpen, panelOpen: ManagerPanel.isOpen, settingsOpen: SettingsPanel.isOpen, aboutOpen: AboutPanel.isOpen, supervisorOpen: SupervisorPanel.isOpen },
    });
  }
}

async function init() {
  // 全局鼠标跟踪：供 Look（trackMouse 朝向）/ ChaseMouse（追指针）消费
  initMouseTracker();

  app = new PIXI.Application();
  await app.init({
    width: window.innerWidth,
    height: window.innerHeight,
    background: 'transparent',
    backgroundAlpha: 0,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    antialias: true,
  });
  const canvas = app.canvas as HTMLCanvasElement;
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  document.body.appendChild(canvas);

  // 资源目录：打包后 resources/assets，开发时项目根 assets
  assetDir = await ipcRenderer.invoke('get-asset-dir');
  configDir = await ipcRenderer.invoke('get-config-dir');

  // 「地面」= workArea 底边（任务栏显示时=任务栏上沿；隐藏时=屏幕最底）。
  // 主进程 1s 轮询 workArea 并在变化时推送，这里同步给所有角色的 baselineY 并重新落位。
  const applyWorkArea = (wa: { x: number; y: number; width: number; height: number }) => {
    Pet.setFloor(wa.y + wa.height);
    pets.forEach((p) => p.resettle());
  };
  applyWorkArea(await ipcRenderer.invoke('get-work-area'));
  ipcRenderer.on('work-area-changed', (_e: any, wa: { x: number; y: number; width: number; height: number }) => {
    applyWorkArea(wa);
    log('info', 'workArea changed: ' + JSON.stringify(wa));
  });

  // 关闭程序：主进程先拦住关闭，让我们播完退场动画再真正退出
  let exiting = false;
  let exitReadySent = false;
  const sendExitReady = () => {
    if (exitReadySent) return;
    exitReadySent = true;
    ipcRenderer.send('exit-ready');
  };
  const playExitAndQuit = () => {
    if (exiting) return;
    exiting = true;
    log('info', 'exit requested: playing exit animations for ' + pets.length + ' pet(s)');
    // 每只宠物播放退出专属动作（exitAction → 复用 removeAction → 通用淡出），全部完成才发 exit-ready
    const tasks = pets.map((p) => p.beginRemove(resolver, p.config.exitAction));
    Promise.all(tasks).then(sendExitReady);
    // 兜底：动画卡住也必须退出，避免关不掉。超时按「最慢那只」的实际预算算（落地等待 + 退场动作 + 淡出），
    // 写死 2.5s 会把 bye(2400ms)+淡出(300ms) 的尾巴切掉，角色还在半空时更是直接被强退。
    const exitBudget = pets.reduce((m, p) => Math.max(m, p.estimateRemoveBudgetMs()), 0);
    window.setTimeout(sendExitReady, Math.max(2500, exitBudget + 800));
  };
  ipcRenderer.on('request-exit', () => playExitAndQuit());

  resolver = new SpriteResolver(assetDir, configDir);
  await resolver.init();
  log('info', 'assets loaded from ' + assetDir);

  // 读取全局相遇概率配置（顶层 "meet" 字段，没写用默认）
  meetCfg = loadMeetConfig(configDir);
  log('info', 'meet config: chance=' + meetCfg.chance + ' distance=' + meetCfg.distance + ' rollInterval=' + meetCfg.rollInterval);

  // 窗口互动配置：可搬运窗口白名单（按标题包含匹配）+ 自动「搬走窗口」开关（默认关）
  winCfg = loadWindowConfig(configDir);
  log('info', 'window config: whitelist=[' + winCfg.whitelist.join('/') + '] throwEnabled='
    + winCfg.throwEnabled + ' rollMs=' + winCfg.throwRollMs + ' chance=' + winCfg.throwChance);
  log('info', 'configDir=' + configDir);

  // 版本更新配置：载入后做静默自动检查（方案 A：仅提示 + 下载页，不自动下载/替换）
  const updCfg = loadUpdateConfig(configDir);
  setUpdaterConfig(updCfg);
  if (updCfg.autoCheck !== false && updCfg.checkUrl) {
    checkForUpdates()
      .then((r) => { if (r.ok && r.hasUpdate) setPendingUpdate(r); })
      .catch(() => { /* 静默失败，不影响主流程 */ });
  }

  await buildPets();

  // —— 监管子系统：状态条 + 监管浮窗（开发态默认唤出，生产 ?dev=1）——
  const statusBar = new StatusBar();
  const supervisorPanel = new SupervisorPanel(statusBar);
  // 暴露 configDir 给 SupervisorPanel 导出用
  (window as any).__deskpet_configDir = configDir;
  // 调试钩子：手动触发「搬走窗口 / 窗口归还」并查看当前窗口白名单。
  // 排时序问题用（boot.log 里看 [winthrow] / [winrestore] 行）；生产路径仍是右键菜单。
  (window as any).__deskpet_debug = {
    throwWindow: (petId?: string) => {
      const pet = petId ? pets.find((p) => p.config.id === petId) : pets[0];
      if (pet) return manualWindowThrow(pet);
      return Promise.resolve();
    },
    restoreWindows: () => winInteract?.restoreWindows(),
    openWindowList: () => windowListPanel.show(),
    openSettings: () => settingsPanel.show(winCfg),
    openAbout: () => aboutPanel.show(),
    openManager: () => managerPanel.show(),
    windowConfig: () => winCfg,
  };
  // 监管面板显隐：显示时窗口保持穿透 + 让 PIXI canvas 透传鼠标，使面板自身可点、桌面其余区域也可点
  // （角色在面板显示期间不抓，调试期可接受）；关闭时恢复 canvas 接收、下一个 mousemove 自然重算穿透态。
  window.addEventListener('supervisor-toggle', () => {
    const cv = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (SupervisorPanel.isOpen) {
      if (cv) cv.style.pointerEvents = 'none';
      ipcRenderer.send('set-ignore-mouse-events', true, { forward: true });
      mouseThrough = true;
    } else {
      if (cv) cv.style.pointerEvents = 'auto';
      // 不强制 reconcile，让下一次真实 mousemove 按光标位置接管；先假设回到穿透态，reconcile 会纠正
      mouseThrough = true;
    }
  });

  // 右键动作菜单 + 角色管理面板（系统托盘呼出）+ 窗口交互
  const contextMenu = new ContextMenu();
  const managerPanel = new ManagerPanel(supervisorPanel); // 传 supervisor 引用，让面板顶部显示「🔧 调试」按钮
  winInteract = new WindowInteract(resolver);
  // 设置面板（右键「设置」）：收纳窗口互动配置 + 「关于」入口。
  // 注意面板在构造时会捕获 winOk，故先探测 koffi 可用性再建面板。
  const winOk = await winInteract.isAvailable();
  // 「自定义可互动窗口…」面板（对齐原版菜单项 ChooseInteractiveWindows / 设置窗口的 InteractiveWindows 列表）
  const windowListPanel = new WindowListPanel(configDir, winCfg, (next) => {
    winCfg = next;
    settingsPanel.syncConfig(winCfg);
    log('info', 'window config 已更新: whitelist=[' + winCfg.whitelist.join('/') + '] throwEnabled=' + winCfg.throwEnabled);
  });
  // 从设置面板点进名单面板后，关掉名单要回到设置，而不是把用户丢回桌面
  windowListPanel.onHidden = () => settingsPanel.show(winCfg);
  const settingsPanel = new SettingsPanel({
    cfg: winCfg,
    winOk,
    onConfigChange: (patch) => {
      winCfg = { ...winCfg, ...patch };
      // 频率字段一并写回：漏传会让面板改的值重启后丢失（saveWindowConfig 已支持它们）。
      const ok = saveWindowConfig(configDir, {
        whitelist: winCfg.whitelist,
        throwEnabled: winCfg.throwEnabled,
        throwRollMs: winCfg.throwRollMs,
        throwChance: winCfg.throwChance,
      });
      log('info', '[winthrow] 设置面板更新: throwEnabled=' + winCfg.throwEnabled
        + ' throwRollMs=' + winCfg.throwRollMs + ' throwChance=' + winCfg.throwChance
        + (ok ? '（已写入 config/config.json）' : '（写入失败，仅本次运行生效）'));
    },
    openWindowList: () => { void windowListPanel.show(); },
  });
  const aboutPanel = new AboutPanel();
  // 系统托盘「角色管理面板」：打开即算阻塞态，reconcile 会强制窗口捕获点击，使面板可操作；
  // 关闭后下一个 mousemove 自动重算穿透态。
  ipcRenderer.on('open-manager-panel', () => {
    managerPanel.show();
    reconcile(0, 0);
  });
  // 托盘「设置」/「关于」：与右键菜单同一入口
  ipcRenderer.on('open-settings-panel', () => { settingsPanel.show(winCfg); reconcile(0, 0); });
  ipcRenderer.on('open-about-panel', () => { void aboutPanel.show(); reconcile(0, 0); });
  // 托盘「窗口归还」：与「设置」并列的一次性动作（2026-09-26 拍板从设置面板移出）。
  // 经 renderer 走 WindowInteract.restoreWindows()——先 stop() 中止在演的抛掷/搬运，再归还，避免动画抢窗口。
  ipcRenderer.on('win-restore-request', () => { void winInteract?.restoreWindows(); });
  // 设置面板里的「关于 DeskPet」入口（面板间跳转用事件解耦，避免相互持有引用）
  window.addEventListener('open-about-panel', () => { void aboutPanel.show(); });
  // 特殊条目：窗口系能力都依赖 koffi —— 不可用时隐藏带 windowMode 的动作（如 nina 的「抛掷窗口」）
  contextMenu.actionFilter = (p: Pet, id: string) => {
    const def = (p.config.actions as any)[id];
    if (def && def.windowMode && !winOk) return false;
    return true;
  };
  // 右键动作菜单：用原生 contextmenu 事件驱动（Pixi v8 的 pointerdown(button=2) 不可靠，右键常被当 contextmenu 吃掉）。
  // 穿透态下 contextmenu 也收不到，因此依赖 pointerover 先把穿透关掉；鼠标悬停在角色上时 Pet.hoveredPet 已就绪。
  window.addEventListener('contextmenu', (e: any) => {
    e.preventDefault();
    // 兜底：即使 pointerover 没设 hoveredPet，也按鼠标坐标命中宠物再弹菜单
    const pet = Pet.hoveredPet ?? Pet.petAt(e.clientX, e.clientY);
    if (pet) {
      contextMenu.show(pet, e.clientX, e.clientY, resolver); // show 内部会 standStill 停当前动作 + 置 menuOpen
      reconcile(e.clientX, e.clientY); // 统一把穿透切到「捕获」（菜单需可点击）
    }
  });

  // 坐标命中 hover：透明窗默认全渗透，鼠标移到角色上即关渗透、移开恢复。
  // 统一交给 reconcile()（单一真相源），不再用 hoveredPet 守卫「是否重发 OFF」，
  // 因此拖拽结束/菜单关闭后悬停能立即重新切到正确穿透态，无需点任务栏自愈。
  let lastMouseX = 0, lastMouseY = 0;
  window.addEventListener('mousemove', (e: any) => {
    lastMouseX = e.clientX; lastMouseY = e.clientY;
    reconcile(e.clientX, e.clientY);
  });
  // 右键菜单关闭（点菜单项 / 点别处 / ESC）后立即按「最后光标坐标」重算穿透态。
  // 见 contextMenu.hide() 注释：菜单关闭时机在 mouseup 之后、menuOpen 置 false 后无事件再触发
  // reconcile，窗口会残留「捕获」态导致桌面点不动。这里主动收口。
  window.addEventListener('context-menu-closed', () => reconcile(lastMouseX, lastMouseY));
  // 鼠标抬起（含拖拽结束）：拖拽结束瞬间 isDragging 已复位，reconcile 会按光标位置重算穿透；
  // 否则拖拽残留态可能让窗口停留在「捕获」或「穿透」错态。
  window.addEventListener('mouseup', (e: any) => {
    reconcile(e.clientX, e.clientY);
  });
  // 下落中角色容差抓取：窗口已捕获（下落期间由 reconcile 强制开启 mouseThrough=false）时，
  // 若光标未直接命中角色、但附近有「下落中」角色，则接住它（参考 Shimeji：下落中的角色可被光标 pin 住）。
  // 直接命中的情况由容器自身 pointerdown 处理，这里只兜底「快速下落点击落空」。
  const CATCH_RADIUS = 40; // 下落抓取容差(px)
  window.addEventListener('pointerdown', (e: any) => {
    if (mouseThrough) return; // 纯穿透态不拦截（点击照常落到桌面）
    if (e.button === 2) return; // 右键交给 contextmenu
    if (Pet.petAt(e.clientX, e.clientY)) return; // 直接命中由容器 pointerdown 处理，避免重复 beginDrag
    const near = Pet.nearbyFallingPet(e.clientX, e.clientY, CATCH_RADIUS);
    if (near) near.beginDrag(e.clientX, e.clientY, true); // snapToCenter：下落容差接住取角色中心锚点，消除悬偏/跳位
  });

  // 右键菜单点击动作。执行前先由 contextMenu.show() 让角色「静止」：
  // 地面 → 站住；墙上/贴顶/空中 → 原地冻结（右键时不动）。
  // 若选的是「地面类」动作而人还在墙上/空中 → 先松手掉落到地面，**落地那一刻**再衔接该动作。
  // 合体动作需找搭档走 triggerInteraction；窗口交互动作走 WindowInteract；普通动作直接执行。
  eventBus.on(EVENTS.PET_MENU_ACTION, (payload: any) => {
    const pet: Pet = payload.pet;
    const actionId: string = payload.actionId;
    // ⚠️ 角色右键菜单只有角色动作（2026-09-25 用户拍板）：
    // 「角色管理面板 / 设置 / 关于」三个面板入口一律不进右键，只留在系统托盘菜单（右键托盘图标）。
    // menuRandom=true 表示「用户点的是动作组的一级条目」→ 需要随机一个自然朝向（左右各 50%）；
    // 点二级精确样式时不随机，保留该样式原有的朝向语义。上下文菜单只对一级条目置这个位。
    pet.randomFacingNext = payload.randomFacing === true;
    const def = (pet.config.actions as any)[actionId];
    if (def && def.windowMode) {
      // 窗口交互（搬运 / 挂窗沿 / 抛掷窗口）：WindowInteract 自己接管动作与位置。
      // 「抛掷窗口」= nina.json 的 windowThrow 动作（windowMode:'throw'），数据驱动、按角色配置出现。
      if (def.windowMode === 'carry') winInteract?.startCarry(pet);
      else if (def.windowMode === 'throw') manualWindowThrow(pet);
      else winInteract?.startLedge(pet);
      return;
    }
    if (pet.isWindowHeld) winInteract?.stop(); // 其他动作打断窗口占用
    const runNow = () => {
      // ⚠️ 判断顺序：**pairTrigger 必须排在 coop 之前**（2026-10-01 修）。
      //   合体动作（双人合照帧）同时带 `coop:true` 与 `pairTrigger:true`，
      //   若先判 coop 会走下面 triggerInteraction 分支 —— 那里 partner 是「随便找的第一个角色」、
      //   且不走近，结果配角不隐身、真人和合照帧同时在场（用户报「两个人同时播放」）。
      //   pairTrigger 分支才按 pairWith 找指定搭档 → startApproach 走近 → triggerPairedAction
      //   （那里同样按 def.coop 做 lead 播合照帧 + 配角隐身，语义不变）。
      //   无 pairTrigger 的纯 coop 落在第三个分支：也先走近再演（见下方 else if）。
      if (def && def.pairTrigger) {
        // 手动配对：找 pairWith 指定的搭档（省略则选最近的、与它有 pair 规则的搭档），走近后各播自己的动作
        // ⚠️ 已有合体在进行时整段跳过：保证「同时只能有一组合体」（其他人/自己都不能再触发合体）。
        if (isAnyCoopActive()) {
          log('info', 'pair action ' + actionId + ' skipped: another coop/paired action is in progress');
        } else {
        let partner: Pet | undefined;
        const targetId = typeof def.pairWith === 'string' ? def.pairWith : undefined;
        if (targetId) {
          partner = pets.find((p) => p.config.id === targetId && !p.isLeaving());
        } else {
          let bestDist = Infinity;
          for (const p of pets) {
            if (p === pet || p.isLeaving() || pairListBetween(pet, p).length === 0) continue;
            const pa = pet.getPosition(), pb = p.getPosition();
            const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
            if (d < bestDist) { bestDist = d; partner = p; }
          }
        }
        if (!partner) {
          log('info', 'pair action ' + actionId + ' skipped: no available partner');
        } else if (!startPairedMeet(pet, partner, resolver, def.pairId)) {
          log('info', 'pair action ' + actionId + ' skipped: no pair rule with ' + partner.config.id);
        }
        }
      } else if (def && def.coop) {
        // 纯合体动作（**没有** pairTrigger 的老式合体，如 rose/interact、nina/interact）：
        // 与「之前的老合体」保持同一套语义 —— 先让两人**走近**，到位那一刻才演合照帧
        // （旧实现是当场 triggerInteraction，两人原地凭空合体，观感突兀）。
        // ⚠️ 已有合体在进行时整段跳过（同时只能有一组合体）。
        if (isAnyCoopActive()) {
          log('info', 'coop action ' + actionId + ' skipped: another coop/paired action is in progress');
        } else {
        const partner = pets.find((p) => p !== pet && !p.isLeaving());
        if (!partner) {
          log('info', 'coop action ' + actionId + ' skipped: no available partner');
        } else {
          (pet as any)._pendingAction = actionId;
          (partner as any)._pendingAction = actionId;
          startMeetAfterLanding(pet, partner, () => {
            pet.startApproach(partner, resolver);
            partner.startApproach(pet, resolver);
            // 到位由 ticker 判（isApproaching + 距离），走 triggerInteraction → startCoopLead/Follow
          }, resolver);
        }
        }
      } else {
        pet.startAction(actionId, resolver);
        // 受击/被推飞：动作带 impulse 则施加抛物线初速度（水平方向随机左右）
        if (def && def.impulse) {
          const mag = Math.abs(def.impulse.vx);
          const vx = (Math.random() < 0.5 ? -1 : 1) * mag;
          pet.applyImpulse(vx, def.impulse.vy);
        }
      }
    };
    // 「地面类」= 非 climb / ceiling / fly。选了它而人不在可用地面（墙上/贴顶/空中）→ 先掉落再衔接。
    const isGroundAction = !!def && def.behavior !== 'climb'
      && def.behavior !== 'ceiling' && def.behavior !== 'fly';
    if (!pet.isGroundBound() && isGroundAction) {
      pet.queueOnLandAndDrop(runNow, resolver);
      return;
    }
    pet.standStill(resolver);
    runNow();
  });

  app.ticker.add((ticker) => {
    // 渲染心跳检测：两次帧间隔 > 1s → 渲染循环可能卡死（Electron 渲染进程僵死）
    const nowTick = performance.now();
    const dtMs = nowTick - lastTickerTime;
    if (lastTickerTime > 0 && dtMs > 1000) {
      // —— 监管埋点：ticker 心跳超时（卡死第一信号）——
      slog({ level: 'error', category: 'ticker.stall', cause: 'gap>1s',
        meta: { gapMs: Math.round(dtMs) } });
      log('error', 'renderer ticker 异常：' + dtMs.toFixed(0) + 'ms 未收到帧（渲染循环可能卡死）');
    }
    lastTickerTime = nowTick;
    // 每帧推送 frame 号给监管日志总线
    // PIXI v8 Ticker 没有 lastFrame，用 ticker.frameID；frame=本次自增计数
    supervisorLog.tickFrame(((ticker as any).frameID ?? 0) as number);
    const dt = ticker.deltaTime;
    // 单宠 update 异常隔离：避免一只宠物抛错导致 pets.forEach 中断、其余宠物全部冻结
    for (const p of pets) {
      try {
        p.update(dt, resolver);
      } catch (e) {
        if (!petUpdateErrLogged.has(p)) {
          petUpdateErrLogged.add(p);
          log('error', 'pet ' + (p.config?.id ?? '?') + ' update 抛错（已隔离，其余宠物继续运行）：' + (e instanceof Error ? (e.stack || e.message) : String(e)));
        }
      }
    }
    winInteract?.update(); // 窗口交互（搬运/挂窗沿）位置同步

    // —— 概率相遇调度（带节流）：每隔 rollInterval 对各对掷骰，够近且静止/走动才走近 ——
    const now = performance.now();
    if (now - lastRoll >= meetCfg.rollInterval) {
      lastRoll = now;
      rollMeet();
    }
    // 搬走窗口演出（config 里 window.throwEnabled 默认 false）：低频掷骰，随机挑一只空闲角色去搬白名单窗口
    if (winCfg.throwEnabled && now - lastThrowRoll >= winCfg.throwRollMs) {
      lastThrowRoll = now;
      maybeThrowWindow();
    }
    // 走近中的角色：够近就切「演关键帧」
    for (const p of pets) {
      if (p.isApproaching()) {
        const partner = p.getMeetPartner();
        if (!partner || !pets.includes(partner)) { p.cancelMeet(resolver); continue; }
        const pa = p.getPosition();
        const pb = partner.getPosition();
        const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        // 合体帧（221 宽、内含两人）把两个角色压在画布中心 ±~52px（内部间距约 104px），
        // 比普通互动的 interactGap+size(180) 更近。若按 180 走到再切合体会让两人「猛地内收 76px」产生 pop；
        // 故合体按内部间距提前到位，让合体帧一出现就与两人当前位置重合（对齐「吃奶冻」cookIce/eatFromMona 的丝滑进出）。
        // 解析动作时两边同时查（合体配对动作 id 可能只在搭档的 config 里），任一侧是 coop 即按合体间距到位。
        const pid = (p as any)._pendingAction || (p.config.interactAction || 'interact');
        const qid = (partner as any)._pendingAction || (partner.config.interactAction || 'interact');
        const lookup = (id: string) => (p.config.actions as any)[id] || (partner.config.actions as any)[id];
        const isCoop = !!(lookup(pid)?.coop || lookup(qid)?.coop);
        const arriveDist = isCoop ? 104 : (p.config.interactGap ?? 30) + p.config.size.width;
        if (dist <= arriveDist) {
          if ((p as any)._pendingIsPair) {
            // 配对动作（另一种合体）：两人在位后各播自己的动作，而非同一 interact
            triggerPairedAction(p, partner);
          } else {
            triggerInteraction(p, partner, pid);
          }
          eventBus.emit(EVENTS.PET_INTERACT, { a: p.config.id, b: partner.config.id, paired: !!(p as any)._pendingIsPair });
        }
      }
    }

    // 已在互动中：维持吸附（两人脸对脸、中间留 gap）
    for (let i = 0; i < pets.length; i++) {
      for (let j = i + 1; j < pets.length; j++) {
        const a = pets[i];
        const b = pets[j];
        if (a.isInteracting() && b.isInteracting() && a.getMeetPartner() === b && b.getMeetPartner() === a) {
          maintainSnap(a, b);
        }
      }
    }

    // 合体吸附：主演(承载合体帧) + 隐身配角成对，每帧把两人摆到「中点对齐」的左槽/右槽（与 maintainSnap 同源）。
    // 配对动作（cookIce/eatFromMona 这类两人都可见）走上面 maintainSnap；合体（一人隐身承载合体帧）走这里。
    // 只处理「恰好一方是 lead」的成对，避免 (i,j) 与 (j,i) 重复摆位。
    for (let i = 0; i < pets.length; i++) {
      for (let j = i + 1; j < pets.length; j++) {
        const a = pets[i];
        const b = pets[j];
        if (a.isCoopLead() === b.isCoopLead()) continue; // 跳过「都非/都是」lead 的组合
        const ap = a.getCoopPartner();
        const bp = b.getCoopPartner();
        if (ap === b || bp === a) {
        const lead = a.isCoopLead() ? a : b;
        const other = lead === a ? b : a;
        // 合体帧未就绪（framesPending）前不摆位：此刻主演还显示上一动作末帧（走/站姿单角色帧），
        // 提前摆到合体位会让「错的帧」画在合体位置 → 触发瞬间闪一下。等帧集加载完再一次性摆正。
        if (lead.isFramesPending()) continue;
        maintainCoopSnap(lead, other);
        }
      }
    }

    // 边界触发攀爬：walk 状态走到屏幕左/右边框时切 climb；climb 离边框回 walk
    // 注意：相遇占用中（走近/演关键帧）不触发攀爬，避免走近过程被打断
    // 攀爬冷却（isClimbBlocked）：刚从墙上掉下来/爬回地面时人还在边缘区，冷却期内不再抓回墙上
    for (const p of pets) {
      if (p.isLeaving()) continue; // 退场中（含「正在掉回地面」）不再调度攀爬
      if (p.isDraggingAction() || p.isMeetBusy()) continue;
      // 走向某个目标点期间（窗口投掷的 approach 阶段）不得被边界攀爬抢占：
      // 目标点常就贴着屏幕边缘，这条调度会在 x<=10 就切 climb，而到达判定是 |dx|<5
      // → 人永远走不到、每次都被改成攀爬（现象：点了「搬走一个窗口」却只是变成边缘攀爬）。
      if (p.isWalkingToTarget) continue;
      if (p.currentActionId === (p.config.walkAction || 'walk') && p.atScreenEdge(10) && !p.isClimbBlocked()) {
        p.requestAction(p.config.climbAction || 'climb');
      } else if (p.currentActionId === (p.config.climbAction || 'climb') && !p.atScreenEdge(10)) {
        p.requestAction(p.config.walkAction || 'walk');
      }
    }
  });

  /** 触发一次互动（普通或合体）。按动作是否为 coop 分流。 */
  function triggerInteraction(a: Pet, b: Pet, actionId: string) {
    (a as any)._pendingAction = undefined;
    (b as any)._pendingAction = undefined;
    // —— 合作互动：rose-nina-* 是 rose 在画面左侧作画、nina-rose-* 是 nina 在画面左侧作画。
    // 谁在屏幕左侧 → 用 ta 的「看对方」视角帧（def + lead = ta），另一人 hide。
    // 动作命名约定：「<左侧角色>-<右侧角色>」与画面站位严格一致，故无需镜像帧。
    const midX = (a.container.x + b.container.x) / 2;
    const leftPet: Pet = a.container.x <= midX ? a : b; // 等号 a 优先，避免来回抖
    const def = (leftPet.config.actions as any)[actionId];
    if (def && def.coop) {
      const leadPet = leftPet;
      const other = leadPet === a ? b : a;
      // 监管埋点：lead 选择（溯源"为什么选了 A 当 lead"）
      slog({
        level: 'action',
        category: 'meet.lead',
        petId: leadPet.config.id,
        meta: {
          action: actionId,
          leftPet: leftPet.config.id,
          partner: other.config.id,
          ax: Math.round(a.container.x), bx: Math.round(b.container.x), midX: Math.round(midX),
          frameSet: def.frames ? def.frames.length : 0,
        },
      });
      // 合体帧的左右翻转由动作配置的 `flip` 字段决定（见 Pet.startCoopLead），此处不另算。
      // lead 的 dialogue 就是 ta 的视角台词（如 rose-nina-* 的「妮娜！」），不取 partner。
      // 不传 interactionDuration（3500）：合照帧是「播完一轮即收尾」（durationMs:0 + loopCount:1），
      // 用固定 3500 会把 7~12 帧 ×800ms 的合照**拦腰截断**（旧 bug：拥抱只播一半就散）。
      // startCoopLead 内部改按 estimateActionMs 反推真实帧长，两侧同步结束（见「总时长对齐」）。
      //
      // ⚠️ 必须用返回值判断（2026-10-01 修「合体后配角不放回来、人凭空消失」）：
      //   startCoopLead 在「动作不存在 / 不是 coop」时会直接 return false —— 此时它既没有定时器
      //   也没有 coopLead 引用，若下面无条件 startCoopFollow，配角就**永久隐身**且没人负责恢复。
      //   失败时退化成「双方各播自己的 interact」，至少两人都在场。
      const ok = leadPet.startCoopLead(actionId, resolver, other, undefined, undefined);
      if (ok) {
        other.startCoopFollow(leadPet);
        // ⚠️ 不在触发瞬间同步 maintainCoopSnap：合体帧是异步加载的（framesPending 期间
        // syncFrameSet 会保留上一动作末帧 = 走/站姿单角色帧）。若此刻就把主演摆到合体位，
        // 会导致「错的单角色帧被画在合体位置上」闪一帧。改为由下方每帧 coop 吸附循环
        // 在 lead.isFramesPending() 解除后再摆位，摆正与出图在同一拍完成，消除闪烁。
      } else {
        // 退化：双方各演自己的 interact（配对台词）—— 宁可演错动作，也不能让一个人消失。
        log('warn', 'coop 动作 ' + actionId + ' 在 ' + leadPet.config.id + ' 上不可用（缺失或非 coop），退化为普通互动');
        const aLine = pickLine(b);
        const bLine = pickLine(a);
        a.startInteract(b, resolver, undefined, aLine);
        b.startInteract(a, resolver, undefined, bLine);
      }
    } else {
      // —— 普通互动（非 coop 兜底）：双方各演 interact（配对台词）——
      // 台词取「对方剧本」里的 dialogue（如 nina 说 rose 剧本的「露丝！」），天然成对不重复
      const aLine = pickLine(b);
      const bLine = pickLine(a);
      // 不传 durationMs：让 interact 按自己的「播完一轮即收尾」结束（durationMs:0 + loopCount:1）。
      // 旧写法传 interactionDuration(3500) 会拿外部时长压住 5.5s 的互动动画——
      // 现在有轮末对齐兜着不会切一半，但气泡时长会被算成 3.5s，比动画短一截。
      a.startInteract(b, resolver, undefined, aLine);
      b.startInteract(a, resolver, undefined, bLine);
    }
  }

  /** 配对动作（另一种「合体」）：两人走到位后**各播自己的动作**（都可见、独立），并面对面吸附。
   *  与 coop(hug) 区别：coop 一人隐身承载合体帧；这里两人各自演互异动作（如莫娜做奶冻、妮娜吃）。
   *  与 triggerInteraction 区别：那里双方播同一个 interact，这里每人播 _pendingAction 里各自的动作。 */
  function triggerPairedAction(a: Pet, b: Pet) {
    const aId = (a as any)._pendingAction;
    const bId = (b as any)._pendingAction;
    (a as any)._pendingAction = undefined;
    (a as any)._pendingIsPair = undefined;
    (b as any)._pendingAction = undefined;
    (b as any)._pendingIsPair = undefined;
    const aAction = (aId && a.config.actions[aId]) ? aId : (a.config.interactAction || 'interact');
    const bAction = (bId && b.config.actions[bId]) ? bId : (b.config.interactAction || 'interact');
    // ⚠️ 合体（coop）配对动作必须走「一人演 + 一人隐身」，不能两人都播（2026-10-01 修）。
    //   合照帧是**一张图里画着两个人**；两侧各自持一套「自己视角」的合照帧（如 rose 的 rose-gwn-*
    //   与 gwen 的 gwn-rose-*）。若走下面的 playPairedAction，两人会**同时各播一套合照** →
    //   屏幕上出现两组人（用户报「两个人同时播放」）。
    //   正确做法与老合体完全一致：屏幕左侧那位当 lead 播 ta 那套帧，另一位 startCoopFollow 隐身让位。
    //   triggerInteraction 内部已按 x 选 leftPet 并做 startCoopLead + startCoopFollow + maintainCoopSnap。
    const aDef: any = a.config.actions[aAction];
    const bDef: any = b.config.actions[bAction];
    if ((aDef && aDef.coop) || (bDef && bDef.coop)) {
      (a as any)._pendingIsPair = undefined;
      (b as any)._pendingIsPair = undefined;
      triggerInteraction(a, b, aAction);
      return;
    }
    // 各自播自己的动作 + 面对面 + 标记占用（maintainSnap 维持脸对脸，且占用期间不再被掷骰命中）
    a.playPairedAction(b, aAction, resolver);
    b.playPairedAction(a, bAction, resolver);
    maintainSnapIntoScreen(a, b); // 首帧就把两人夹回屏内，避免「贴边相遇 → 人被推到屏幕外」
  }

  /** 合体/配对开始前的「落地闸门」：任一方还在空中(fly/ceiling)、攀爬(climb)或下落中，
   *  先让它掉到地面（复用 Pet.queueOnLandAndDrop 的「落地回调」机制），等**双方都落地**再启动合体，
   *  避免两人在空中/墙上触发合体动作。都已在地面（含正常走动）则立即执行 cb。
   *  用 isAirborne 而非 isGroundBound：后者要求 vx/vy===0，会把正在走路的宠物误判成空中而强制掉落（回归）。 */
  function startMeetAfterLanding(a: Pet, b: Pet, cb: () => void, resolver: any) {
    const airborne = [a, b].filter((p) => p.isAirborne());
    if (airborne.length === 0) { cb(); return; }
    let pending = airborne.length;
    const maybeRun = () => { if (--pending <= 0) cb(); };
    for (const p of airborne) p.queueOnLandAndDrop(maybeRun, resolver);
  }

  /** 合体吸附：把两个真实角色摆到**合体帧内部的 ±52px**（约 104px 间距），
   *  而非普通互动的 interactGap+size(180px)。
   *
   *  为什么必须压近：合体帧（221 宽）里两个角色是被画师压在画布中心 ±~52px 的（内部间距约 104px），
   *  而两个真实角色自然站位是 180px。若按 180 摆位，合体帧一出现就会「左角色压在左位、
   *  右角色比真实右位偏左约 128px 凭空消失」→ 进出合体都 pop。
   *  修法（对齐「吃奶冻」cookIce/eatFromMona 的丝滑）：
   *    1) 两个真实角色摆到 midX±52（与合体帧内部间距一致）；
   *    2) 合体动作加 `offset.x:52`，把整张合体帧右移 52px，使「左角色」正好压在 lead 真实中心、
   *       「右角色」正好压在 other 真实中心；
   *  进合体（两人已走到 104 内）与出合体（配角直接显形在右槽）时贴图角色与真实角色位置完全一致 → 无跳变。
   *
   *  ⚠️ 旧实现（2026-10-02）只同步 y + 夹 lead.x，从不给隐身配角定位 → endCoop 把配角摆到 lead.x+14（重叠）；
   *  后又改「中点对齐 + 180 间距」，几何虽与 maintainSnap 同源，但 180 ≠ 合体帧内部 104 → 仍是 pop。
   *  现改为「中点对齐 + 104 压缩间距 + 动作级 offset.x」，与合体帧内部布局一致；每帧由下方 ticker 循环驱动。 */
  function maintainCoopSnap(lead: Pet, other: Pet) {
    // 合体帧内部两角色中心相对画布中心的偏移（见 scripts/measure-coop-sprite.mjs，实测 ±51~59，取 52）
    const coopHalf = 52;
    const pa = lead.getPosition();
    const pb = other.getPosition();
    const midX = (pa.x + pb.x) / 2;
    const y = Math.min(pa.y, pb.y);
    const leftX = midX - coopHalf;
    const rightX = midX + coopHalf;
    // lead 始终是画面对应的「左位」角色（triggerInteraction 已按 x 选 leftPet 当 lead）
    lead.container.x = leftX - lead.config.size.width / 2;
    lead.container.y = y - lead.config.size.height / 2;
    // 配角隐身，但坐标对齐「右槽」，供收尾显形无跳变
    other.container.x = rightX - other.config.size.width / 2;
    other.container.y = lead.container.y;
    // 边界夹取（整对平移回屏内），复用 maintainSnap 的平移逻辑
    shiftPairIntoScreen(lead, other);
  }

  /** 取两角色之间的配对规则列表：**两侧都取再合并**（2026-10-01 修）。
   *  旧实现只取「先查到的那一侧」：rose↔mona 上 rose 侧挂了 coop 合照、mona 侧挂了 sing/eat，
   *  结果从 rose 的菜单点「和莫娜一起唱歌」时 list 里只有 rose 侧那条 → 按 id 找不到 sing，
   *  退化为随机抽到「合照」，点 A 出 B。
   *  合并后两侧规则都能命中；每条打上 `__from` 标记，供 owner 判定（self/other 的方向靠它）。
   *  兼容旧式单 pair 写法：normalizeMeetRules 已统一归一成数组，这里只读 pairs。
   *  ⚠️ 旧式单 pair 归一化后没有 id，去重键退化为 self>other。 */
  function pairListBetween(a: Pet, b: Pet): any[] {
    const ra: any = (a.config.meetRules && a.config.meetRules[b.config.id]) || {};
    const rb: any = (b.config.meetRules && b.config.meetRules[a.config.id]) || {};
    const out: any[] = [];
    const seen = new Set<string>();
    const push = (list: any, from: 'a' | 'b') => {
      if (!Array.isArray(list)) return;
      for (const p of list) {
        if (!p || typeof p !== 'object') continue;
        const key = `${from}|${p.id ?? ''}|${p.self ?? ''}>${p.other ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...p, __from: from });
      }
    };
    push(ra.pairs, 'a');
    push(rb.pairs, 'b');
    return out;
  }

  /** 配对规则的「拥有方」：self 是 owner 的动作、other 是对方的动作。
   *  按 __from 判定（规则从哪一侧的 meetRules 取来的），而不是旧写的「a 优先」——
   *  合并两侧后 a 侧不一定有规则，按 a 优先会把 self/other 用反（两人演错动作）。 */
  function pairOwner(a: Pet, b: Pet, pair: any): { owner: Pet; other: Pet } {
    const owner = pair && pair.__from === 'b' ? b : a;
    return { owner, other: owner === a ? b : a };
  }

  /** 从配对列表中按 weight 加权随机抽一条（无权重/权重非法 → 等权）。 */
  function pickPair(list: any[]): any {
    const total = list.reduce((s: number, p: any) => s + (typeof p.weight === 'number' && p.weight > 0 ? p.weight : 1), 0);
    let r = Math.random() * total;
    for (const p of list) {
      const w = typeof p.weight === 'number' && p.weight > 0 ? p.weight : 1;
      if ((r -= w) <= 0) return p;
    }
    return list[list.length - 1];
  }

  /** 是否有任意角色正处于「合体/配对」进行中或正在走近去演合体（全局「同时只能有一组合体」互斥锁）。
   *  覆盖三种状态：
   *  ① 真正在播合体帧（coopLead/coopFollow 已置位，一人显形一人隐身）；
   *  ② 配对动作走近中（_pendingIsPair=true，如吃奶冻 cook/eat）；
   *  ③ 旧式 coop 走近中（_pendingAction 指向 coop 动作，如 rose/interact 拥抱）。
   *  普通（非 coop）互动的走近不在此列，故不与普通相遇互斥。 */
  function isAnyCoopActive(): boolean {
    for (const p of pets) {
      if (p.isInCoop()) return true;
      if (p.isApproaching()) {
        if ((p as any)._pendingIsPair) return true;
        const act = (p as any)._pendingAction;
        const def: any = act ? (p.config.actions as any)[act] : null;
        if (def && def.coop) return true;
      }
    }
    return false;
  }

  /** 手动触发一次配对相遇：让 a、b 走近并就位后各播自己的动作（复用 ticker 到位的 triggerPairedAction）。
   *  与 rollMeet 的 pairs 分支完全等价，只是由菜单点击驱动而非掷骰。返回是否成功发起。
   *  pairId：指定触发 meetRules 里哪一条配对（按 id 选）；省略则按 weight 随机抽一条。
   *  ⚠️ 已有合体在进行时直接返回 false，保证「同时只能有一组合体」（菜单/掷骰都不会叠加第二对）。 */
  function startPairedMeet(a: Pet, b: Pet, resolver: any, pairId?: string): boolean {
    if (isAnyCoopActive()) {
      log('info', 'pair meet skipped: another coop/paired action is in progress');
      return false;
    }
    const list = pairListBetween(a, b);
    if (list.length === 0) return false;
    const pair = (pairId && list.find((p: any) => p.id === pairId)) || pickPair(list);
    const { owner, other: otherPet } = pairOwner(a, b, pair);
    const selfId = pair.self || (owner.config.interactAction || 'interact');
    const otherId = pair.other || (otherPet.config.interactAction || 'interact');
    (owner as any)._pendingAction = selfId;
    (otherPet as any)._pendingAction = otherId;
    (owner as any)._pendingIsPair = true;
    (otherPet as any)._pendingIsPair = true;
    // 落地闸门：任一方在空中/攀爬/贴顶时先落地再走近，否则两人会在半空触发合体动作。
    startMeetAfterLanding(a, b, () => {
      a.startApproach(b, resolver);
      b.startApproach(a, resolver);
    }, resolver);
    return true;
  }

  /** 窗口投掷（复刻原桌宠 ThrowIE）手动触发：走过去 → 抓住 → 扛到屏幕另一侧 → 甩出。
   *  只在白名单窗口里选目标（config/config.json 的 window.whitelist）。 */
  async function manualWindowThrow(pet: Pet) {
    try {
      if (!pet || pet.isLeaving() || pet.isDraggingAction() || pet.isWindowHeld) return;
      log('info', '[winthrow] 手动触发：' + pet.config.name + ' 去搬窗口');
      await winInteract?.startThrowShow(pet, winCfg.whitelist);
    } catch { /* 任何异常都不影响主循环 */ }
  }

  /** 窗口投掷自动掷骰（仅 window.throwEnabled=true 时由 ticker 调用）：随机挑一只空闲角色去搬窗口。
   *  默认关闭 —— 搬走窗口是很显眼的行为，不该未经允许就发生。
   *  只挑有整套投掷帧的角色（jumpWindow/grabWindow/carryWindow/throwWindow）——
   *  没帧的角色接了任务会在起跳阶段因动作缺失中断。
   *  ⚠️ 这五个动作**每个角色都要齐**（2026-10-01 已全员补齐，见 scripts/add-throw-actions.mjs）；
   *     新增角色若漏配，这里会静默跳过它，表现为「新角色从不抛掷窗口」。 */
  async function maybeThrowWindow() {
    try {
      if (Math.random() > winCfg.throwChance) return;
      const hasThrowFrames = (p: Pet) =>
        ['jumpWindow', 'grabWindow', 'carryWindow', 'throwWindow'].every((id) => !!(p.config.actions as any)[id]);
      const cand = pets.filter((p) => !p.isLeaving() && !p.isWindowHeld && !p.isDraggingAction()
        && !p.isWalkingToTarget && p.isIdleOrWalk() && hasThrowFrames(p));
      if (cand.length === 0) return;
      const pet = cand[Math.floor(Math.random() * cand.length)];
      log('info', '[winthrow] 自动掷骰命中：' + pet.config.name + ' 去搬窗口');
      await winInteract?.startThrowShow(pet, winCfg.whitelist);
    } catch { /* 任何异常都不影响主循环 */ }
  }

  /** 概率相遇掷骰：每对候选按各自规则掷骰，命中则双方进入「走近」阶段。 */
  function rollMeet() {    for (let i = 0; i < pets.length; i++) {
      for (let j = i + 1; j < pets.length; j++) {
      const a = pets[i];
      const b = pets[j];
      // 排除：退场中、被占用（走近/演关键帧）、合体占用中（主演/隐身配角）、拖拽中、非静止/走动
      if (a.isLeaving() || b.isLeaving()) continue;
      if (a.isMeetBusy() || b.isMeetBusy()) continue;
      if (a.isInCoop() || b.isInCoop()) continue; // 合体中的角色不再被掷骰拉去别的互动
        if (a.isDraggingAction() || b.isDraggingAction()) continue;
        if (!a.isIdleOrWalk() || !b.isIdleOrWalk()) continue;
        // 取这对的规则（a→b 优先，否则 b→a，再否则全局默认）
        const rule = (a.config.meetRules && a.config.meetRules[b.config.id])
          || (b.config.meetRules && b.config.meetRules[a.config.id])
          || {};
        // pairs 配对动作：不要求双方有 interactAction（如莫娜只靠 cookMilk 参与），有 pairs 即可触发；
        // 普通相遇仍要求双方都有 interactAction（没互动帧的角色不参与）。
        // 同一对角色可挂多条配对（pairs 数组）→ 按 weight 加权随机抽一条（实现「多种合体可选」）。
        const pairList = pairListBetween(a, b);
        const pair = pairList.length ? pickPair(pairList) : undefined;
        const bothInteract = !!(a.config.interactAction && b.config.interactAction);
        if (!pair && !bothInteract) continue;
        const pa = a.getPosition();
        const pb = b.getPosition();
        const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        const chance = typeof rule.chance === 'number' ? rule.chance : meetCfg.chance;
        const distThresh = typeof rule.distance === 'number' ? rule.distance : meetCfg.distance;
        if (dist > distThresh) continue; // 不够近不掷骰
        if (Math.random() < chance) {
          // ⚠️ 同时只能有一组合体：已有合体在进行时，本回合不发起任何配对演出（普通相遇不受影响）。
          if (pair && !isAnyCoopActive()) {
            // 配对动作：规则拥有者演 self，对方演 other；分别记住各自动作 + 配对标记。
            // owner 按规则来源判定（见 pairOwner），不能写死「a 优先」。
            const { owner, other: otherPet } = pairOwner(a, b, pair);
            const selfId = pair.self || (owner.config.interactAction || 'interact');
            const otherId = pair.other || (otherPet.config.interactAction || 'interact');
            (owner as any)._pendingAction = selfId;
            (otherPet as any)._pendingAction = otherId;
            (owner as any)._pendingIsPair = true;
            (otherPet as any)._pendingIsPair = true;
          } else if (!pair) {
            const actionId = typeof rule.action === 'string' ? rule.action : (a.config.interactAction || 'interact');
            (a as any)._pendingAction = actionId;
            (b as any)._pendingAction = actionId;
          }
          // 落地闸门：任一方在空中/攀爬/贴顶时先落地再走近，否则两人会在半空触发合体动作。
          // 已有合体时（pair 分支被跳过）不再走近，避免叠加第二对。
          if (!(pair && isAnyCoopActive())) {
            startMeetAfterLanding(a, b, () => {
              a.startApproach(b, resolver);
              b.startApproach(a, resolver);
            }, resolver);
          }
        }
      }
    }
  }

  /** 相遇吸附：两人中心移到「连线中点、脸对脸、中间留 interactGap」 */
  function maintainSnap(a: Pet, b: Pet) {
    const gap = Math.max(0, ((a.config.interactGap ?? 30) + (b.config.interactGap ?? 30)) / 2);
    const pa = a.getPosition();
    const pb = b.getPosition();
    const midX = (pa.x + pb.x) / 2;
    const y = Math.min(pa.y, pb.y); // 取较高者高度，避免错位
    const half = (a.config.size.width + b.config.size.width) / 2;
    const leftX = midX - gap / 2 - half / 2;
    const rightX = midX + gap / 2 + half / 2;
    // 按两人「当前实际左右位」决定谁左谁右，而非固定 a=左/b=右：
    // 否则自然在右侧的角色会被每帧强行换到左侧，产生瞬移对调、左右位看起来永远固定。
    // stepApproach 保证走近不会交叉，故首帧 pa.x/pb.x 即自然顺序；落位后锁在 leftX/rightX，稳定不翻面。
    const aOnLeft = pa.x <= pb.x;
    const left = aOnLeft ? a : b;
    const right = aOnLeft ? b : a;
    left.container.x = leftX - left.config.size.width / 2;
    right.container.x = rightX - right.config.size.width / 2;
    left.container.y = right.container.y = y - left.config.size.height / 2;
    // 左位→朝右、右位→朝左，保证面对面。
    left.setFacingDir(true);
    right.setFacingDir(false);
    // —— 贴边相遇会把人挤出屏幕（2026-10-01 修「角色闪现出屏幕外」）——
    // maintainSnap 只按「两人中点」摆位，不做边界夹取：两人在屏幕右边缘相遇时
    // rightX 会超过 innerWidth，右位角色整只被推到屏幕外（且每帧维持，整段互动都在屏外）。
    // 这里按「整对一起平移」收口：保住两人的相对站位与面对面朝向，只把越界的那一侧拉回屏内。
    shiftPairIntoScreen(left, right);
  }

  /** 把一对已摆好相对位置的两人**整体平移**回屏幕内（不破坏站位/朝向）。
   *  优先补左边越界，其次补右边越界；屏幕比两人还窄时退化为各自硬夹。 */
  function shiftPairIntoScreen(left: Pet, right: Pet) {
    const lw = left.config.size.width;
    const rw = right.config.size.width;
    const screenW = window.innerWidth;
    const overLeft = -left.container.x;                                  // >0：左位越出左边界
    const overRight = (right.container.x + rw) - screenW;                // >0：右位越出右边界
    let shift = 0;
    if (overLeft > 0) shift = overLeft;
    else if (overRight > 0) shift = -overRight;
    if (shift !== 0) {
      left.container.x += shift;
      right.container.x += shift;
    }
    // 兜底：屏幕窄到放不下两人（或上面取整误差）时各自硬夹一次，保证绝不留在屏外
    clampPetX(left);
    clampPetX(right);
  }

  /** 把单个角色夹回屏幕横向范围内（container.x = 角色框左上角）。 */
  function clampPetX(p: Pet) {
    const w = p.config.size.width;
    const maxX = Math.max(0, window.innerWidth - w);
    if (p.container.x < 0) p.container.x = 0;
    else if (p.container.x > maxX) p.container.x = maxX;
  }

  /** 配对动作落位后立刻做一次「夹回屏内」（供 triggerPairedAction 首帧调用）。 */
  function maintainSnapIntoScreen(a: Pet, b: Pet) {
    const left = a.container.x <= b.container.x ? a : b;
    const right = left === a ? b : a;
    shiftPairIntoScreen(left, right);
  }

  /** 从「对方剧本」的 interact 动作里随机挑一句台词（如 nina 说 rose 剧本的「露丝！」），构成配对对白。 */
  function pickLine(speaker: Pet): string | undefined {
    const acts = (speaker.config.actions as any) || {};
    const interact = acts[speaker.config.interactAction || 'interact'];
    const dialogue: string[] | undefined = interact?.dialogue;
    if (dialogue && dialogue.length > 0) return dialogue[Math.floor(Math.random() * dialogue.length)];
    return undefined;
  }

  log('info', 'DeskPet started with ' + pets.length + ' pets');
}

/** 用当前配置（含外部 config.json 覆盖）构建/重建所有宠物。
 *  仅在启动时调用：按 config.characters 一次性构建。运行时召唤/删除走 spawnPet/removePet。 */
async function buildPets() {
  Pet.getAll().forEach((p) => {
    try { app.stage.removeChild(p.container); } catch { /* noop */ }
  });
  pets = [];
  Pet.clearInstances();

  const characters = loadUserConfig(configDir);
  for (const charConfig of characters) {
    const pet = new Pet(charConfig, app, resolver);
    app.stage.addChild(pet.container);
    pets.push(pet);
  }
}

/** 召唤一个角色（按 id 从当前配置里找）。已存在则忽略（一个角色只能有一个实例）。 */
export function spawnPet(id: string) {
  if (pets.some((p) => p.config.id === id)) {
    log('warn', 'spawn ignored, already exists: ' + id);
    return false;
  }
  const characters = loadUserConfig(configDir);
  const cfg = characters.find((c) => c.id === id);
  if (!cfg) {
    log('warn', 'spawn failed, no config for id: ' + id);
    return false;
  }
  const pet = new Pet(cfg, app, resolver);
  app.stage.addChild(pet.container);
  pets.push(pet);
  log('info', 'spawned pet: ' + id);
  return true;
}

/** 删除一个在场角色（按 id）：先播退场动画（专属 removeAction 帧 → 通用淡出），动画结束后才真正移除。 */
export function removePet(id: string): boolean {
  const pet = pets.find((p) => p.config.id === id);
  if (!pet) return false;
  // isLeaving() 而非 isRemoving：退场前还有一段「先掉回地面」的等待期，
  // 那期间 isRemoving 仍是 false，用旧判断会二次触发 beginRemove → 人还在半空就被 stage.removeChild 抹掉。
  if (pet.isLeaving()) return true;
  if (pet.isWindowHeld) winInteract?.stop(); // 窗口占用中先释放
  pet.beginRemove(resolver).then(() => {
    try { app.stage.removeChild(pet.container); } catch { /* noop */ }
    const i = pets.indexOf(pet);
    if (i >= 0) pets.splice(i, 1);
    Pet.syncInstances(pets); // 保持全局实例列表与 pets 一致
    log('info', 'removed pet: ' + id);
  });
  return true;
}

/** 返回当前在场角色 id 列表（供管理面板用；退场动画中的角色不算在场）。 */
export function listPets(): string[] {
  return pets.filter((p) => !p.isLeaving()).map((p) => p.config.id);
}

/** 返回配置里全部可用角色 id（含未召唤的）。 */
export function listConfigCharacters(): string[] {
  return loadUserConfig(configDir).map((c) => c.id);
}

/** 热加载功能已移除（用户要求）。需要改参数/美术时，改完在桌宠窗口按 Ctrl+R 重新加载即可。 */

window.addEventListener('resize', () => {
  app.renderer.resize(window.innerWidth, window.innerHeight);
});

init();
