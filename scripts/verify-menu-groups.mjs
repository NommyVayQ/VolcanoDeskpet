// 右键菜单二级分组的无头逻辑验证：直接跑「配置 → 分组」的同一套算法并断言。
// 用法：node scripts/verify-menu-groups.mjs [角色id]
// 校验项：
//   1. 每个 menu:true 的动作必须恰好出现一次（一级动作 / 组内二级 / menuHidden 随机池）
//   2. 动作组的随机池非空，且成员都是真实存在的动作
//   3. 组内二级条目非空
// 退出码：0=全过，1=有失败
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const master = JSON.parse(readFileSync(path.join(root, 'config', 'config.json'), 'utf8'));
const id = process.argv[2] || master.characters[0];
const acts = JSON.parse(readFileSync(path.join(root, 'config', 'actions', `${id}.json`), 'utf8')).actions;
const cdef = JSON.parse(readFileSync(path.join(root, 'config', 'characters', `${id}.json`), 'utf8'));
const gdefs = cdef.actionGroups || {};

const menuIds = Object.keys(acts).filter((k) => acts[k].menu === true);
const groups = new Map();
const singles = [];
for (const aid of menuIds) {
  const d = acts[aid];
  const order = typeof d.menuOrder === 'number' ? d.menuOrder : 999;
  const lb = d.label ?? aid;
  if (d.menuGroup) {
    // 与运行时 contextMenu.buildEntries 保持一致：二级直接用动作自己的名字，不再拼「组名·动作名」
    const label = lb;
    if (!groups.has(d.menuGroup)) groups.set(d.menuGroup, []);
    groups.get(d.menuGroup).push({ id: aid, label, labelBase: lb, order });
  } else {
    singles.push({ id: aid, label: lb, order });
  }
}

const entries = singles.map((s, i) => ({ order: s.order, seq: i, kind: 'action', id: s.id, label: s.label }));
for (const [key, chRaw] of groups) {
  const ch = chRaw.slice().sort((a, b) => a.order - b.order);
  const g = gdefs[key] || {};
  let pool = ch.filter((c) => acts[c.id].menuRandom !== false).map((c) => c.id);
  if (g.menuRandom) {
    const n = ch.filter((c) => c.id === g.menuRandom || c.labelBase === g.menuRandom).map((c) => c.id);
    if (n.length) pool = n;
    else if (g.menuRandom === key) pool = ch.map((c) => c.id);
  }
  entries.push({
    order: typeof g.order === 'number' ? g.order : Math.min(...ch.map((c) => c.order)),
    seq: 1000, kind: 'group', key, label: g.label ?? key,
    children: ch.filter((c) => acts[c.id].menuHidden !== true).map((c) => ({ id: c.id, label: c.label })),
    randomIds: pool.length ? pool : ch.map((c) => c.id),
  });
}
entries.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));

// —— 断言 ——
let fail = 0;
const check = (cond, msg) => { if (!cond) { console.log('  ✗ ' + msg); fail++; } };
check(entries.length > 0, '菜单不能为空');
for (const e of entries) {
  if (e.kind === 'action') check(!!acts[e.id], `一级动作 ${e.id} 必须存在`);
  else {
    check(e.children.length > 0, `组 ${e.label} 至少有一个二级条目`);
    check(e.randomIds.length > 0, `组 ${e.label} 随机池非空`);
    for (const c of e.randomIds) check(!!acts[c], `随机池成员 ${c} 必须存在`);
    for (const c of e.children) check(!!acts[c.id], `二级条目 ${c.id} 必须存在`);
  }
}
// 覆盖性：每个 menu:true 的动作必须恰好出现一次（一级或二级）
const seen = [];
for (const e of entries) {
  if (e.kind === 'action') seen.push(e.id);
  else for (const c of e.children) seen.push(c.id);
}
const hiddenOnly = menuIds.filter((a) => acts[a].menuHidden === true);
const covered = [...seen, ...hiddenOnly].sort();
check(JSON.stringify(covered) === JSON.stringify([...menuIds].sort()),
  `menu:true 的动作必须全部被覆盖；缺=${menuIds.filter((a) => !covered.includes(a))} 多=${covered.filter((a) => !menuIds.includes(a))}`);

console.log(`${id}: 一级 ${entries.length} 个（组 ${entries.filter((e) => e.kind === 'group').length}） / 二级覆盖 ${seen.length} / menuHidden ${hiddenOnly.length}`);
for (const e of entries) {
  if (e.kind === 'action') console.log(`  ${e.label}  [${e.id}]`);
  else {
    console.log(`  ▸ ${e.label}  点一级随机→ [${e.randomIds.join(', ')}]`);
    for (const c of e.children) console.log(`      └ ${c.label}  [${c.id}]`);
  }
}
console.log(fail ? `\n断言失败 ${fail} 项` : '\n断言全部通过');
if (fail) process.exit(1);
