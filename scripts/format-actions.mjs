// config/actions/*.json 统一格式化：帧对象**不换行**（一行一个），其余保持 2 空格缩进。
//
// 目标样式（与各角色现有动作文件手工风格一致）：
//   "frames": [
//     { "name": "L-creep-1", "vx": 0, "ms": 700 },
//     { "name": "L-creep-2", "vx": 0, "ms": 500 },
//     "L-fishing-3"
//   ],
//
// 规则：
//   - 数组元素各占一行；整段能塞进 100 字符的短数组直接内联（如 dialogue、next）；
//     但 frames / rightFrames 永不内联——即使全是短字符串也每帧一行（09-17 用户定稿）；
//   - 「值全是原始类型」的对象压成一行（帧对象、impulse、offset 等自然适配）；
//   - 键序、内容一律不动（只改空白），写法幂等：重复跑不会再产生 diff。
//
// 用法：
//   node scripts/format-actions.mjs            # 只检查，列出需要格式化的文件
//   node scripts/format-actions.mjs --write    # 就地写入
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'config', 'actions');
const write = process.argv.includes('--write');
const INLINE_ARRAY_MAX = 100; // 短数组内联的长度上限（字符）

const isPrimitive = (v) => v === null || typeof v !== 'object';
/** 扁平对象：没有嵌套的数组/对象，可安全压成一行 */
const isFlatObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every((k) => isPrimitive(v[k]));

/** 紧凑序列化：保留键序，帧对象一行 */
function print(node, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(node)) {
    if (node.length === 0) return '[]';
    if (node.every(isPrimitive) || node.every(isFlatObject)) {
      const one = '[' + node.map((el) => print(el, indent + 2)).join(', ') + ']';
      if (one.length <= INLINE_ARRAY_MAX) return one;
    }
    const items = node.map((el) => ' '.repeat(indent + 2) + print(el, indent + 2));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.length === 0) return '{}';
    if (keys.every((k) => isPrimitive(node[k]))) {
      return '{ ' + keys.map((k) => JSON.stringify(k) + ': ' + JSON.stringify(node[k])).join(', ') + ' }';
    }
    const items = keys.map((k) => ' '.repeat(indent + 2)
      + JSON.stringify(k) + ': ' + print(node[k], indent + 2));
    return '{\n' + items.join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(node);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const changed = [];
for (const f of files) {
  const p = path.join(dir, f);
  const raw = readFileSync(p, 'utf8');
  const before = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const text = print(before) + '\n';
  const after = JSON.parse(text);
  // 安全闸：格式化只允许改空白，数据必须完全一致，否则拒绝写入
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    console.error(`[ABORT] ${f}: 格式化后数据不一致（键序或内容被改动），已跳过`);
    continue;
  }
  if (text === raw) { console.log(`[ok]   ${f}（已符合格式）`); continue; }
  changed.push(f);
  console.log(`[diff] ${f}  ${raw.length} -> ${text.length} 字节`);
  if (write) writeFileSync(p, text, 'utf8');
}
console.log(`\n共 ${files.length} 个文件，需格式化 ${changed.length} 个${write ? '（已写入）' : '（未写入，加 --write 生效）'}`);
