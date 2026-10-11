/**
 * 互动占用判定（谁被占用谁才互斥）。
 *
 * ## 为什么要单独成文件
 * 2026-10-11 修「A、B 互动中，C、D 就永远触发不了互动」：
 * 旧实现 `isAnyCoopActive()` 扫描**全场**角色，只要有一组在演合体/配对，
 * 所有其它角色的配对动作全部被禁 —— 连锁范围远超「互斥」本意。
 * 正确语义是**按角色**判定：别人插不进 A↔B，但 C↔D 之间照常互动。
 *
 * 抽成模块是为了能 headless 单测（见 scripts/test-meet-exclusion.mjs）——
 * 这里的判据曾在五处调用点各写一遍，改漏一处就会退化回全局锁。
 *
 * ## 覆盖的三种占用态
 * ① 真正在播合体帧（coopLead/coopFollow 已置位，一人显形一人隐身）；
 * ② 配对动作走近中（_pendingIsPair=true，如吃奶冻 cook/eat）；
 * ③ 旧式 coop 走近中（_pendingAction 指向 coop 动作，如 rose/interact 拥抱）。
 *
 * 普通（非 coop）互动的走近**不**在此列 —— 普通相遇本就允许并发，
 * 它们靠 `Pet.isMeetBusy()`（meetPhase !== 'none'）做逐对互斥，不走这里。
 */
import type { Pet } from './Pet';

/** 单只角色是否正处在「合体/配对」占用中（含正在走近去演合体）。 */
export function isCoopBusyFor(p: Pet): boolean {
  if (p.isInCoop()) return true;
  if (p.isApproaching()) {
    const anyP = p as any;
    if (anyP._pendingIsPair) return true;
    const act = anyP._pendingAction;
    const def: any = act ? (p.config.actions as any)[act] : null;
    if (def && def.coop) return true;
  }
  return false;
}

/** 这一对能否发起合体/配对：任一人在合体链上即占用。
 *  ⚠️ 只看这一对，不看全场 —— 场上别处正在演的合体与本对无关。 */
export function isCoopBusyForPair(a: Pet, b: Pet): boolean {
  return isCoopBusyFor(a) || isCoopBusyFor(b);
}
