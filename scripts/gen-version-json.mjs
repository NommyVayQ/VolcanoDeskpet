#!/usr/bin/env node
/**
 * 生成 version.json（远端版本清单），供桌宠内「检查更新」拉取
 * （config.json 的 update.checkUrl 指向它）。
 *
 * 用法：
 *   node scripts/gen-version-json.mjs [--owner OWNER] [--repo REPO] [--branch main]
 *   # 也可把 owner/repo 写进 .release-meta.json：{ "owner":"x", "repo":"y", "branch":"main" }
 *
 * 字段来源：
 *   version  ← package.json
 *   pubDate  ← 今天（YYYY-MM-DD）
 *   notes    ← CHANGELOG.md 顶部第一个版本小节的要点（## 到下一个 ## 之间的 -/* 行）
 *   downloadUrl ← github.com/{owner}/{repo}/releases/download/v{version}/DeskPet-Portable-{version}.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---- 解析参数 ----
const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
let owner = getArg('owner');
let repo = getArg('repo');
let branch = getArg('branch') || 'main';

// 从 .release-meta.json 补齐
const metaPath = path.join(root, '.release-meta.json');
if (fs.existsSync(metaPath)) {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    owner = owner || m.owner;
    repo = repo || m.repo;
    branch = branch || m.branch || 'main';
  } catch { /* ignore */ }
}

if (!owner || !repo) {
  console.warn('[gen-version-json] 未指定 owner/repo，使用占位 OWNER/REPO（发布前请改成你的 GitHub 仓库）');
  owner = owner || 'OWNER';
  repo = repo || 'REPO';
}

// ---- version ----
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;

// ---- pubDate ----
const pubDate = new Date().toISOString().slice(0, 10);

// ---- notes：CHANGELOG.md 顶部第一个版本小节 ----
function extractNotes(changelogPath) {
  if (!fs.existsSync(changelogPath)) return '';
  const lines = fs.readFileSync(changelogPath, 'utf-8').split('\n');
  let started = false;
  const out = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (started) break; // 遇到了下一个版本小节，结束
      started = true; // 第一个 ## 是我们要的小节
      continue;
    }
    if (started) {
      const t = line.trim();
      if (/^[-*]\s+/.test(t)) out.push(t.replace(/^[-*]\s+/, ''));
    }
  }
  return out.join('\n');
}
const notes = extractNotes(path.join(root, 'CHANGELOG.md'));

const downloadUrl = `https://github.com/${owner}/${repo}/releases/download/v${version}/DeskPet-Portable-${version}.zip`;

const manifest = {
  version,
  pubDate,
  notes,
  downloadUrl,
  channel: 'stable',
};

// ---- 写出 ----
const out1 = path.join(root, 'version.json');
fs.writeFileSync(out1, JSON.stringify(manifest, null, 2) + '\n');

console.log('[gen-version-json] 已生成：');
console.log('  ' + path.relative(root, out1));
console.log('  version =', version, ' pubDate =', pubDate);
console.log('  downloadUrl =', downloadUrl);
console.log('');
console.log('把 config.json 的 update.checkUrl 设为：');
console.log('  https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/version.json');
