/**
 * 只读探针：验证「可互动窗口」名单过滤 + 最大化排除（对齐原版 isIE / isViableIE 语义）。
 * 不移动、不枚举之外做任何事。用法：node scripts/probe-window-list.cjs
 */
const w = require('../dist/main/main/winapi.js');

console.log('winapi 可用:', w.initWinApi());
const all = w.listWindows();
console.log('');
console.log('=== 全部可见顶层窗口 ' + all.length + ' 个（已剔除最小化/最大化/无标题/过小）===');
for (const x of all) console.log('  [' + x.w + 'x' + x.h + ' @' + x.x + ',' + x.y + '] ' + x.title);

// 取实际存在的标题，构造「区分大小写」的正反用例
const sample = all.find((x) => /^[A-Za-z]{3,}/.test(x.title));
if (sample) {
  const upper = sample.title.match(/^[A-Za-z]{3,}/)[0];
  const lower = upper.toLowerCase();
  const hitUpper = w.listWindows(undefined, [upper]).length;
  const hitLower = w.listWindows(undefined, [lower]).length;
  console.log('');
  console.log('=== 区分大小写验证（原版 contains 语义，不做 lowercase 归一）===');
  console.log('  样本标题: ' + sample.title);
  console.log('  entry "' + upper + '" → 命中 ' + hitUpper + ' 个（应为 1）');
  console.log('  entry "' + lower + '" → 命中 ' + hitLower + ' 个（大小写不同，应为 0）');
} else {
  console.log('');
  console.log('（没有纯英文标题的窗口，跳过大小写用例）');
}

console.log('');
console.log('=== 名单为空数组 = 不限制（旧行为）===');
console.log('  listWindows(undefined, []) → ' + w.listWindows(undefined, []).length + ' 个（应等于全量 ' + all.length + '）');
console.log('');
console.log(all.length === w.listWindows(undefined, []).length ? 'PASS' : 'FAIL');
