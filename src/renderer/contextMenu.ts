import { Pet } from './Pet';
import { SpriteResolver } from './SpriteResolver';
import { eventBus, EVENTS } from './eventBus';

// 鼠标穿透已统一由 app.ts 的 reconcile() 驱动，菜单不再自行发送 set-ignore-mouse-events。

/**
 * 菜单渲染产出的一个一级条目：要么是一个可直接点击的动作，要么是一个可展开的分组。
 *
 * ⚠️ 角色右键菜单**只放角色动作**（2026-09-25 用户拍板）：
 * 「角色管理面板 / 设置 / 关于」这类面板入口一律不进这里，统一只在**系统托盘菜单**（右键托盘图标）。
 * 历史教训：面板入口曾以 specials 形式插进菜单，因 order(900~902) 小于未显式写 menuOrder 的动作
 * 默认值 999，排序后跑到动作列表**前面**，表现就是「面板入口混进了触发动作栏」。
 */
type MenuEntry =
  | { kind: 'action'; id: string; label: string }
  | { kind: 'group'; key: string; label: string; children: { id: string; label: string }[]; randomIds: string[] };

/**
 * 右键动作菜单（最多两级）。
 *
 * 一级 = 动作（`menu:true`）或**动作组**（动作上写了 `menuGroup`，同组的多个变体折叠成一条）。
 * 二级 = 组内的具体变体。
 *
 * 点击行为：
 *   - 点一级「普通动作」   → 直接执行该动作。
 *   - 点一级「动作组」     → 从组内候选池**随机抽一个**变体执行（抽哪个见 ActionGroupDef.menuRandom）。
 *   - 点二级「具体变体」   → 精确执行该变体。
 *
 * 全部由 config 驱动，新增/调整动作零代码。
 */
export class ContextMenu {
  private el: HTMLDivElement;
  /** 本次菜单的宿主角色：菜单关闭但**没选**动作时要解除它的「原地冻结」（见 hide()）。 */
  private owner: Pet | null = null;
  /** 动作过滤器：返回 false 的动作不出现在菜单（如 koffi 不可用时的窗口系动作）。 */
  public actionFilter: ((owner: Pet, id: string) => boolean) | null = null;
  /** 悬停高亮色 / 常态色（一级与二级共用一套视觉）。 */
  private static readonly HOVER_BG = 'rgba(255,255,255,0.15)';

  constructor() {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'z-index:9999', 'display:none',
      'background:rgba(30,30,35,0.95)', 'color:#fff', 'font:13px/1.4 sans-serif',
      'border-radius:8px', 'padding:4px', 'min-width:120px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)', 'user-select:none',
    ].join(';');
    document.body.appendChild(this.el);

    // 点击别处 / ESC 关闭
    window.addEventListener('pointerdown', (e) => {
      if (this.el.style.display !== 'none' && !this.el.contains(e.target as Node)) this.hide();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
    // 阻止右键默认菜单
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 在屏幕坐标 (x,y) 弹出 owner 的动作菜单。 */
  show(owner: Pet, x: number, y: number, resolver: SpriteResolver) {
    const entries = this.buildEntries(owner);
    if (entries.length === 0) {
      this.hide();
      return;
    }
    // 唤起菜单的瞬间让角色「静止」：地面 → 站住；墙上/贴顶/空中 → 原地冻结（右键时不动）。
    // 必须放在「确认菜单真的会弹出」之后：否则空菜单路径把人冻住却没人解冻。
    owner.standStill(resolver);
    this.owner = owner;
    this.el.innerHTML = '';
    // 记住当前展开的组（同一角色同一组在菜单存活期间保持展开，重新弹出时折叠）
    for (const entry of entries) this.el.appendChild(this.renderEntry(owner, entry));
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
    this.el.style.display = 'block';
    // 视口边界回拉：点击靠近屏幕边缘时，菜单可能溢出（向上/向左/向右/向下都被裁）。
    // 先设 display:block 才能读到 offsetHeight/Width，再按视口尺寸回拉。
    {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = this.el.offsetWidth;
      const h = this.el.offsetHeight;
      const m = 4; // 距视口边缘最小留白
      let fx = x;
      let fy = y;
      if (fx + w > vw - m) fx = vw - w - m;
      if (fy + h > vh - m) fy = vh - h - m;
      if (fx < m) fx = m;
      if (fy < m) fy = m;
      this.el.style.left = fx + 'px';
      this.el.style.top = fy + 'px';
    }
    Pet.menuOpen = true;
    // 穿透态由 app.ts 的 reconcile() 统一驱动：弹菜单即进入阻塞态，reconcile 会强制窗口捕获点击（菜单可点）。
  }

  /** 把角色的 actions 整理成一级条目列表：普通动作 + 折叠后的动作组（按 menuOrder 排序）。 */
  private buildEntries(owner: Pet): MenuEntry[] {    const acts = owner.config.actions;
    const ok = (id: string) => !!acts[id] && (!this.actionFilter || this.actionFilter(owner, id));
    // 只收集显式 menu:true 的项：动作组本身也要求组内至少有一个 menu:false 之外的有效动作
    const menuIds = Object.keys(acts).filter((id) => acts[id].menu === true && ok(id));

    const groups = new Map<string, { id: string; label: string; labelBase: string; order: number }[]>();
    const singles: { id: string; label: string; order: number }[] = [];

    for (const id of menuIds) {
      const def = acts[id];
      const order = typeof def.menuOrder === 'number' ? def.menuOrder : 999;
      const labelBase = def.label ?? id;
      if (def.menuGroup) {
        // 二级条目名 = 动作自己的名字，不再拼「组名·动作名」：
        // 二级面板已经挂在「做饭 / 钓鱼」这些一级标题下，再重复前缀是冗余（做饭·面包 → 面包）。
        const label = labelBase;
        if (!groups.has(def.menuGroup)) groups.set(def.menuGroup, []);
        groups.get(def.menuGroup)!.push({ id, label, labelBase, order });
      } else {
        singles.push({ id, label: labelBase, order });
      }
    }

    const entries: { order: number; seq: number; entry: MenuEntry }[] = singles.map((s, i) => ({
      order: s.order, seq: i,
      entry: { kind: 'action', id: s.id, label: s.label },
    }));

    for (const [key, childrenRaw] of groups) {
      const children = childrenRaw.slice().sort((a, b) => a.order - b.order);
      const gdef = owner.config.actionGroups?.[key];
      // 一级「随机抽一个」的候选池：
      //   - group.menuRandom 指定了 → 优先用它的池（值=某个动作 id 时只抽该动作的变体；值=组 key 时整组）
      //   - 否则 = 组内所有未标 menuRandom:false 的变体
      let pool = children.filter((c) => acts[c.id].menuRandom !== false).map((c) => c.id);
      const pick = gdef?.menuRandom;
      if (pick) {
        const narrowed = children.filter((c) => c.id === pick || c.labelBase === pick).map((c) => c.id);
        if (narrowed.length > 0) pool = narrowed;
        else if (pick === key) pool = children.map((c) => c.id);
      }
      entries.push({
        order: typeof gdef?.order === 'number' ? gdef.order : Math.min(...children.map((c) => c.order)),
        seq: 1000,
        entry: {
          kind: 'group',
          key,
          label: gdef?.label ?? key,
          // 二级列表只列「未标 menuHidden」的变体；menuHidden 的变体仍留在随机池里
          children: children.filter((c) => acts[c.id].menuHidden !== true).map((c) => ({ id: c.id, label: c.label })),
          randomIds: pool.length > 0 ? pool : children.map((c) => c.id),
        },
      });
    }

    entries.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    return entries.map((e) => e.entry);
  }

  /** 渲染一个一级条目（普通动作 = 单个可点行；组 = 可展开行 + 二级列表）。 */
  private renderEntry(owner: Pet, entry: MenuEntry): HTMLDivElement {
    if (entry.kind === 'action') {
      return this.makeRow(entry.label, () => this.commit(owner, entry.id), 0);
    }

    const wrap = document.createElement('div');
    // 二级面板要贴在一级行的右侧悬浮，故 wrap 作为定位参照
    wrap.style.cssText = 'position:relative;';
    // 一级：动作组（点击 = 随机抽一个；悬停/点箭头 = 展开二级选具体样式）
    const head = document.createElement('div');
    const caret = document.createElement('span');
    caret.textContent = '▸';
    // 箭头做成有实际面积的点击热区（padding + 负 margin 抵消，避免只挤占文字空间）
    caret.style.cssText = 'font-size:11px;opacity:0.8;transition:transform .12s;display:inline-block;' +
      'cursor:pointer;padding:3px 7px;margin:-3px 2px -3px -5px;border-radius:4px;';
    caret.title = '展开/收起全部样式（鼠标悬停这行也会自动展开）';
    const txt = document.createElement('span');
    txt.textContent = entry.label;
    txt.style.flex = '1';
    const hint = document.createElement('span');
    hint.textContent = '随机';
    hint.title = '点这一行 = 从该组的多种样式里随机抽一个；悬停或点箭头 = 展开挑具体样式';
    hint.style.cssText = 'font-size:10px;opacity:0.45;cursor:pointer;padding:3px 4px;';
    head.appendChild(caret);
    head.appendChild(txt);
    head.appendChild(hint);
    const headRow = this.styleRow(head);
    // styleRow() 会整体覆盖 cssText，flex 布局必须在其之后再补，否则箭头/文字/提示会掉成块级
    headRow.style.display = 'flex';
    headRow.style.alignItems = 'center';
    headRow.style.gap = '4px';
    // 二级 = 侧向 flyout 面板（系统菜单风格）：绝对定位在一级行右侧，不挤占一级列表的高度。
    // 用 margin-left:-2px 与一级行轻微重叠，消除「行 → 面板」之间的空隙（否则鼠标穿过空隙会触发收起）。
    const sub = document.createElement('div');
    sub.style.cssText = 'position:absolute;left:100%;top:-4px;margin-left:-2px;display:none;z-index:2;' +
      'background:rgba(30,30,35,0.97);border-radius:8px;padding:4px;min-width:120px;white-space:nowrap;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.45);';

    let open = false;
    let pinned = false; // 点箭头「钉住」：钉住后鼠标移开也不收起
    const setOpen = (v: boolean) => {
      if (v === open) return;
      open = v;
      sub.style.display = v ? 'block' : 'none';
      caret.style.transform = v ? 'rotate(90deg)' : 'none';
      caret.style.opacity = v ? '1' : '0.8';
      if (v) this.positionSub(sub); // 右侧放不下时翻到左侧，下沿超出时上移
    };
    // 悬停即展开（与系统右键菜单一致），移开自动收起；点箭头可钉住/取消钉住。
    wrap.onmouseenter = () => { if (!pinned) setOpen(true); };
    wrap.onmouseleave = () => { if (!pinned) setOpen(false); };
    const togglePin = () => { pinned = !pinned; setOpen(pinned); };
    caret.addEventListener('click', (e) => { e.stopPropagation(); togglePin(); });
    hint.addEventListener('click', (e) => { e.stopPropagation(); togglePin(); });
    headRow.onclick = (e) => {
      // 点箭头/「随机」标签之外的任意位置 → 随机执行（朝向也一起随机）
      if (e.target === caret || e.target === hint) return;
      this.commit(owner, this.pickRandom(owner, entry.randomIds), true);
    };
    wrap.appendChild(headRow);

    for (const c of entry.children) {
      const row = this.makeRow(c.label, () => this.commit(owner, c.id), 0);
      sub.appendChild(row);
    }
    if (entry.children.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '（仅随机，无独立条目）';
      empty.style.cssText = 'padding:4px 10px;opacity:0.4;font-size:11px;';
      sub.appendChild(empty);
    }
    wrap.appendChild(sub);
    return wrap;
  }

  /** 通用可点行（一级普通动作 / 二级变体）：缩进通过 paddingLeft 表达。 */
  private makeRow(label: string, onClick: () => void, indent: number): HTMLDivElement {
    const row = document.createElement('div');
    const txt = document.createElement('span');
    txt.textContent = label;
    row.appendChild(txt);
    const el = this.styleRow(row);
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.paddingLeft = (10 + indent) + 'px';
    el.onclick = onClick;
    return el;
  }

  /** 统一行的视觉（hover 高亮），返回同一个节点便于挂事件。 */
  private styleRow(row: HTMLDivElement): HTMLDivElement {
    row.style.cssText = 'padding:6px 10px;cursor:pointer;border-radius:4px;';
    row.onmouseenter = () => { row.style.background = ContextMenu.HOVER_BG; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    return row;
  }

  /** 展开/折叠导致菜单变高后，把菜单拉回视口内（与 show() 的边界回拉同一套规则）。 */
  private clampToViewport() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const m = 4;
    let fx = parseFloat(this.el.style.left) || 0;
    let fy = parseFloat(this.el.style.top) || 0;
    if (fx + w > vw - m) fx = vw - w - m;
    if (fy + h > vh - m) fy = vh - h - m;
    if (fx < m) fx = m;
    if (fy < m) fy = m;
    this.el.style.left = fx + 'px';
    this.el.style.top = fy + 'px';
  }

  /** 二级 flyout 面板定位：默认贴一级行右侧；右侧放不下翻到左侧；下沿超出视口则整体上移。 */
  private positionSub(sub: HTMLDivElement) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 基准：先把 top 复位到设计值再量。翻转/上移是「每次展开重算」，若带着上次的残留值量，
    // 误差会累积（越展开越靠上）。
    const baseTop = -4;
    sub.style.top = baseTop + 'px';
    const r = sub.getBoundingClientRect();
    if (r.right > vw - 4) {
      // 右侧空间不足 → 翻到一级行左侧
      sub.style.left = 'auto';
      sub.style.right = '100%';
      sub.style.marginLeft = '0';
      sub.style.marginRight = '-2px';
    } else {
      sub.style.left = '100%';
      sub.style.right = 'auto';
      sub.style.marginLeft = '-2px';
      sub.style.marginRight = '0';
    }
    // r 是「top=baseTop」时量到的屏幕坐标；需要的位移量是 dy。
    // 注意写回的是**相对 wrap 的偏移**，只能是 baseTop + dy —— 不能掺入 r.top 这个屏幕坐标。
    const M = 4; // 距视口边缘最小留白
    let dy = 0;
    if (r.bottom > vh - M) dy = vh - M - r.bottom; // 下沿超出 → 上移（dy 为负）
    if (r.top + dy < M) dy = M - r.top;            // 上移后越过上沿 → 夹回，只保证上沿进视口
    // dy === 0 时也显式写回，避免面板继承上一次翻转/上移残留的定位
    sub.style.top = (baseTop + dy) + 'px';
  }

  /** 从候选池里等权随机挑一个动作 id（池为空返回 null）。 */
  private pickRandom(owner: Pet, pool: string[]): string | null {
    const valid = pool.filter((id) => !!owner.config.actions[id]);
    if (valid.length === 0) return null;
    return valid[Math.floor(Math.random() * valid.length)];
  }

  /** 执行动作并关菜单（统一出口，保证「随机」与「精确」两条路径行为一致）。
   *  randomFacing=true 仅用于「点一级动作组 → 随机抽一个样式」：此时朝向也一起随机（左右各 50%）。 */
  private commit(owner: Pet, id: string | null, randomFacing = false) {
    if (!id) { this.hide(); return; }
    // 交给 app 统一分流：合体动作需找搭档，窗口交互动作走 WindowInteract，普通动作直接执行
    eventBus.emit(EVENTS.PET_MENU_ACTION, { pet: owner, actionId: id, randomFacing });
    this.hide();
  }

  /** 判断菜单当前是否可见（供 Pet 右键分支判断是否需要先关穿透）。 */
  get isVisible(): boolean {
    return this.el.style.display !== 'none';
  }

  hide() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
    Pet.menuOpen = false;
    // 关闭菜单（点别处 / ESC / 空菜单）但**没有选动作** → 解除角色的原地冻结，行为自然接管
    // （攀爬从原位置继续爬）。选了动作时 menuHold 已被 app.ts 的菜单处理分支清掉，这里是 no-op。
    if (this.owner) {
      this.owner.resumeAfterMenu();
      this.owner = null;
    }
    // 菜单关闭（点菜单项 / 点别处 / ESC）后立即通知 app 按「当前光标坐标」重算穿透态。
    // 关键：hide() 把 menuOpen 置 false 发生在 click 阶段，晚于 window 的 mouseup；
    // 而 mouseup 那次 reconcile 仍看到 menuOpen=true（菜单还开着）→ 强制捕获。
    // 若关闭后不立即重算，窗口会残留「捕获」态 → 桌面点不动，须移动鼠标（点任务栏）才自愈。
    // 这正是「点完动作还要点任务栏」的真正根因。改为关闭即刻主动 reconcile(最后光标坐标)。
    window.dispatchEvent(new CustomEvent('context-menu-closed'));
  }
}
