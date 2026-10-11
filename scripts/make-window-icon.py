#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成 DeskPet 的**窗口图标** build/icon.png（窗口 / 任务栏 / Alt-Tab）。

【三个图标位，别混】
  window  build/icon.png        窗口/任务栏/Alt-Tab   ← 本脚本
  tray    build/tray-icon.png   系统托盘小图标         ← make-app-icons.py
  file    build/file-icon.ico   exe 文件图标           ← make-app-icons.py
  查找顺序 resources/<name> → build/<name>（src/main/index.ts getIconPath）

窗口位没有缩放兜底（loadWindowIcon 直接给 BrowserWindow 的 icon），
所以**尺寸必须自己给对**：输出 256x256（Windows 任务栏/Alt-Tab 的标准档）。
源图建议 >=256px、带真透明通道；白底会自动抠。

用法：
  python scripts/make-window-icon.py --src <png> [--size 256] [--write]

默认 dry-run 只写预览图；--write 才落盘，并同步到「当前版本 + 桌宠测试版」
的 resources/（历史版本一律不动，见下）。
"""

import argparse
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAD_RATIO = 0.03          # 四周留白比例
CUT_FULL = 248            # min(r,g,b) >= 此值 = 纯背景
CUT_OPAQUE = 226          # min(r,g,b) <= 此值 = 纯前景

# 只同步这两个：当前 package.json 版本 + 桌宠测试版。
# ⚠️ 绝不能「同步 release/ 下全部目录」—— 历史版本是已交付的产物，
# 改它们的图标等于静默篡改旧交付物（2026-10-04 踩过：一次性污染 19 个目录）。
def target_releases():
    out = []
    try:
        with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
            v = json.load(f)['version']
        p = os.path.join(ROOT, 'release', f'DeskPet-Portable-{v}', 'resources')
        if os.path.isdir(p):
            out.append(p)
    except Exception as e:
        print(f'  ⚠ 读 package.json 版本失败：{e}')
    p = os.path.join(ROOT, 'release', '桌宠测试版', 'resources')
    if os.path.isdir(p):
        out.append(p)
    return out


def drop_white_bg(img):
    """白底 -> 透明，带反预乘去白边（只改 alpha 会留一圈白毛边）。"""
    arr = np.asarray(img.convert('RGB')).astype(np.float64)
    mn = arr.min(axis=2)
    a = np.clip((CUT_FULL - mn) / float(CUT_FULL - CUT_OPAQUE), 0.0, 1.0)
    a = np.asarray(Image.fromarray((a * 255).astype(np.uint8), 'L')
                   .filter(ImageFilter.GaussianBlur(0.5))).astype(np.float64) / 255.0
    safe = np.maximum(a, 1e-6)[..., None]
    fg = np.clip((arr - 255.0 * (1.0 - safe)) / safe, 0, 255)
    fg[a < 0.02] = 255.0
    return Image.fromarray(np.dstack([fg, a * 255.0]).round().clip(0, 255).astype(np.uint8), 'RGBA')


def fit_square(img, size, pad_ratio=PAD_RATIO):
    """裁内容 bbox -> 等比缩放居中到正方形画布。"""
    bbox = img.getchannel('A').point(lambda v: 255 if v > 10 else 0).getbbox()
    if not bbox:
        print('  ⚠ 无可见像素，回退不透明缩放')
        return img.convert('RGB').resize((size, size), Image.LANCZOS).convert('RGBA')
    content = img.crop(bbox)
    inner = max(1, round(size * (1 - 2 * pad_ratio)))
    w, h = content.size
    s = min(inner / w, inner / h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    r = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(r, ((size - nw) // 2, (size - nh) // 2), r)
    return canvas


def main():
    ap = argparse.ArgumentParser(description='生成 DeskPet 窗口图标 build/icon.png')
    ap.add_argument('--src', required=True, help='源图（建议 >=256px RGBA，白底会自动抠）')
    ap.add_argument('--size', type=int, default=256, help='输出边长（默认 256）')
    ap.add_argument('--write', action='store_true', help='真正写盘（默认 dry-run）')
    args = ap.parse_args()

    src = Image.open(args.src)
    print(f'源图: {src.size[0]}x{src.size[1]} {src.mode}')
    if src.size[0] < args.size:
        print(f'  ⚠ 源图 {src.size[0]}px < 输出 {args.size}px，放大后会模糊')
    if src.mode not in ('RGBA', 'LA'):
        print('  无 alpha，按白底抠图处理')
    else:
        lo, hi = src.getchannel('A').getextrema()
        print(f'  alpha {lo}~{hi}' + ('  ← 全不透明，需抠白底' if lo == 255 else '  ← 已有真透明通道'))

    out = fit_square(drop_white_bg(src), args.size)
    a = out.getchannel('A')
    print(f'输出: {args.size}x{args.size}  alpha {a.getextrema()[0]}~{a.getextrema()[1]}'
          f'  内容 bbox {a.point(lambda v: 255 if v > 10 else 0).getbbox()}')

    if not args.write:
        prev = Image.new('RGBA', (args.size + 24, args.size), (40, 40, 46, 255))
        prev.paste(out, (0, 0), out)
        p = os.path.join(ROOT, 'tmp-window-icon-preview.png')
        prev.save(p)
        print(f'[dry-run] 加 --write 才落盘。预览：tmp-window-icon-preview.png')
        return 0

    dst = os.path.join(ROOT, 'build', 'icon.png')
    out.save(dst)
    print(f'已写入: {dst}')
    for res in target_releases():
        shutil.copyfile(dst, os.path.join(res, 'icon.png'))
        print(f'  同步 -> {res}/icon.png')
    print('\n生效方式：运行期读取 → 需**重启 DeskPet**。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
