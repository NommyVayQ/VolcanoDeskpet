#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从两张源图生成 DeskPet 的应用图标。

【三个图标位，别混】
  window  build/icon.png        窗口/任务栏/Alt-Tab   —— 本脚本不生成，沿用现有图
  tray    build/tray-icon.png   系统托盘小图标         —— TRAY_SRC
  file    build/file-icon.ico   exe 文件图标(资源管理器) —— FILE_SRC，九档 16~256
  查找顺序 resources/<name> → build/<name>（见 src/main/index.ts getIconPath）

【源图要求】
- FILE_SRC：RGBA 带真透明通道，>=256px（矢量导出最佳）。
- TRAY_SRC：任意尺寸，**允许白底无 alpha**（本脚本自动抠）。分辨率越低放大后越糊，
             建议 >=128px。

【白底转透明的关键：反预乘】
源图是「不透明图 + alpha 全 255」，白色背景与抗锯齿边缘的像素里混着白。
只把 alpha 改掉而 RGB 保留原值 -> 缩小后边缘一圈白边（俗称「白毛边」）。
正确做法是按观测色反解出真实前景色：
    观测 = 真实 * a + 255 * (1 - a)   =>   真实 = (观测 - 255*(1-a)) / a
a 由「与白色的距离」推得：min(r,g,b) 越接近 255 越透明。

用法：
  python scripts/make-app-icons.py --file-src <png> --tray-src <png> [--write] [--size 32]

默认 dry-run 只报告并写一张预览图；加 --write 才落盘
（build/ + 自动同步已存在的 release/*/resources/）。
"""

import argparse
import io
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# exe 图标九档：与历史 build/file-icon.ico 保持一致
ICO_SIZES = [16, 24, 32, 48, 64, 72, 96, 128, 256]
TRAY_SIZE = 32          # 托盘最佳 16~32；main/index.ts makeTrayIcon 仅在 >64px 时缩到 32
TRAY_PAD_RATIO = 0.04   # 四周留白比例，避免贴边

# 抠白底：min(r,g,b) >= CUT_FULL 视为纯背景(全透明)；<= CUT_OPAQUE 视为纯前景(不透明)
CUT_FULL = 248
CUT_OPAQUE = 226


def parse_args():
    ap = argparse.ArgumentParser(description='生成 DeskPet 应用图标')
    ap.add_argument('--file-src', required=True, help='exe 文件图标源图（RGBA，>=256px）')
    ap.add_argument('--tray-src', required=True, help='托盘图标源图（可白底）')
    ap.add_argument('--size', type=int, default=TRAY_SIZE, help=f'托盘输出边长（默认 {TRAY_SIZE}）')
    ap.add_argument('--write', action='store_true', help='真正写盘（默认 dry-run）')
    return ap.parse_args()


def describe(img, tag):
    print(f'  {tag}: {img.size[0]}x{img.size[1]} {img.mode}')
    if img.mode in ('RGBA', 'LA'):
        lo, hi = img.getchannel('A').getextrema()
        note = '全不透明，白底需抠' if lo == 255 else '已有真透明通道'
        print(f'         alpha {lo}~{hi}  ← {note}')
    else:
        print('         无 alpha，需抠白底')


def drop_white_bg(img):
    """白底 -> 透明，带反预乘去白边。返回 RGBA。"""
    arr = np.asarray(img.convert('RGB')).astype(np.float64)
    mn = arr.min(axis=2)                      # min 通道：黄色身体≈118，白底≈255

    # alpha: min 通道从 CUT_OPAQUE..CUT_FULL 线性映射到 1..0
    a = (CUT_FULL - mn) / float(CUT_FULL - CUT_OPAQUE)
    a = np.clip(a, 0.0, 1.0)
    # 轻微羽化，抹掉抠图产生的 1px 硬边
    a_img = Image.fromarray((a * 255).astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(0.5))
    a = np.asarray(a_img).astype(np.float64) / 255.0

    # 反预乘解出真实前景色，避免边缘白毛边
    safe_a = np.maximum(a, 1e-6)[..., None]
    fg = (arr - 255.0 * (1.0 - safe_a)) / safe_a
    fg = np.clip(fg, 0, 255)
    # a 极小处（几乎纯背景）直接置白，反正不可见，避免除零放大噪声
    fg[a < 0.02] = 255.0

    out = np.dstack([fg, a * 255.0]).round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def trim_and_pad(img, size, pad_ratio=TRAY_PAD_RATIO):
    """裁到内容 bbox，等比缩放进 size 画布并居中，四周留白。"""
    bbox = img.getchannel('A').point(lambda v: 255 if v > 10 else 0).getbbox()
    if not bbox:
        print('  ⚠ 抠完无可见像素，回退为不透明缩放')
        return img.convert('RGB').resize((size, size), Image.LANCZOS).convert('RGBA')
    content = img.crop(bbox)
    inner = max(1, round(size * (1 - 2 * pad_ratio)))
    w, h = content.size
    scale = min(inner / w, inner / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def build_file_master(src):
    """生成方形 256 母版：补正方形 + 居中 + LANCZOS 缩放（ICO 要求正方形画布）。"""
    img = src.convert('RGBA')
    w, h = img.size
    size = max(w, h)
    if (w, h) != (size, size):
        sq = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        sq.paste(img, ((size - w) // 2, (size - h) // 2), img)
        img = sq
    return img.resize((256, 256), Image.LANCZOS)


def main():
    args = parse_args()
    print('源图检查：')
    file_src = Image.open(args.file_src)
    tray_src = Image.open(args.tray_src)
    describe(file_src, 'file(exe)')
    describe(tray_src, 'tray    ')

    if tray_src.size[0] < 128:
        print(f'  ⚠ 托盘源图仅 {tray_src.size[0]}px，缩到 {args.size}px 虽不放大但细节已丢失；'
              f'若追求清晰请改用 >=256px 源图。')

    file_master = build_file_master(file_src)
    tray_out = trim_and_pad(drop_white_bg(tray_src), args.size)

    bio = io.BytesIO()
    file_master.save(bio, format='ICO', sizes=[(s, s) for s in ICO_SIZES])
    ico_buf = bio.getvalue()

    n = int.from_bytes(ico_buf[4:6], 'little')
    print('\n生成结果：')
    print(f'  file-icon.ico  {len(ico_buf)} 字节, {n} 档:')
    for i in range(n):
        o = 6 + i * 16
        bw, bh = ico_buf[o] or 256, ico_buf[o + 1] or 256
        sz = int.from_bytes(ico_buf[o + 8:o + 12], 'little')
        print(f'    {bw:>3}x{bh:<3} 数据 {sz:>7} 字节')
    a = tray_out.getchannel('A')
    print(f'  tray-icon.png  {args.size}x{args.size}  alpha {a.getextrema()[0]}~{a.getextrema()[1]}'
          f'  内容 bbox {a.point(lambda v: 255 if v > 10 else 0).getbbox()}')

    if not args.write:
        prev = Image.new('RGBA', (256 + 24 + 64, 256), (40, 40, 46, 255))
        prev.paste(file_master, (0, 0), file_master)
        t = tray_out.resize((64, 64), Image.NEAREST)
        prev.paste(t, (256 + 24, 96), t)
        p = os.path.join(ROOT, 'tmp-icon-preview.png')
        prev.save(p)
        print(f'\n[dry-run] 加 --write 才落盘。预览已写：tmp-icon-preview.png（左=ICO 母版，右=托盘 4x 放大）')
        return 0

    ico_path = os.path.join(ROOT, 'build', 'file-icon.ico')
    tray_path = os.path.join(ROOT, 'build', 'tray-icon.png')
    with open(ico_path, 'wb') as f:
        f.write(ico_buf)
    tray_out.save(tray_path)
    print('\n已写入：')
    print(f'  {ico_path}')
    print(f'  {tray_path}')

    rel_root = os.path.join(ROOT, 'release')
    if os.path.isdir(rel_root):
        # ⚠️ 只同步「当前版本 + 桌宠测试版」，**绝不能遍历 release/ 下全部目录**。
        # 历史版本是已交付产物，改它们的图标等于静默篡改旧交付物。
        # （2026-10-04 踩过：一次性污染 19 个目录，Rose 284B 全被换成鸡 1883B。）
        import json
        targets = []
        try:
            with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
                v = json.load(f)['version']
            p = os.path.join(rel_root, f'DeskPet-Portable-{v}', 'resources')
            if os.path.isdir(p):
                targets.append(p)
        except Exception as e:
            print(f'  ⚠ 读 package.json 版本失败：{e}')
        p = os.path.join(rel_root, '桌宠测试版', 'resources')
        if os.path.isdir(p):
            targets.append(p)
        for res in targets:
            shutil.copyfile(tray_path, os.path.join(res, 'tray-icon.png'))
            print(f'  同步 -> {res}/tray-icon.png')
    print('\n生效方式：')
    print('  tray-icon.png  运行期读取 → 需**重启 DeskPet**。')
    print('  file-icon.ico  由 rcedit 内嵌进 exe → 需重跑 npm run repack-portable。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
