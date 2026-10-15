# -*- coding: utf-8 -*-
"""Copy currency glyphs from FontBase into every game font in assets/Font.

Source fonts do not each contain every symbol, and language subsets drop
glyphs the locale strings never use. This transplants only the missing
codepoints, scaled to the target font's unitsPerEm.

NPR रू is two Devanagari characters. Cocos draws them separately; the vowel
sign will not sit on the consonant.

TND د.ت: both Arabic letters stand alone (the dot breaks joining), so the
isolated forms from the cmap are enough without Arabic shaping tables.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys

from fontTools.misc.transform import Transform
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FONT_BASE = os.path.join(ROOT, 'FontBase')
FONT_DIR = os.path.join(ROOT, 'assets', 'Font')

# Codepoint -> source file in FontBase. Unlisted codepoints come from Noto Sans Bold.
SPECIAL = [
    (0x09F3, 'NotoSansBengali-Bold.ttf', 'BDT', '৳'),
    (0x00A5, 'NotoSans-Bold.ttf', 'YEN', '¥'),
    (0x20AC, 'NotoSans-Bold.ttf', 'EUR', '€'),
    (0x20B9, 'NotoSans-Bold.ttf', 'INR', '₹'),
    (0x17DB, 'NotoSansKhmer-Bold.ttf', 'KHR', '៛'),
    (0x20A6, 'NotoSans-Bold.ttf', 'NGN', '₦'),
    (0x0930, 'NotoSans-Bold.ttf', 'NPR1', 'र'),
    (0x0942, 'NotoSans-Bold.ttf', 'NPR2', 'ू'),
    (0x20B1, 'NotoSans-Bold.ttf', 'PHP', '₱'),
    (0x20A8, 'NotoSans-Bold.ttf', 'PKR', '₨'),
    (0x0E3F, 'NotoSansThai_Condensed-ExtraBold.ttf', 'THB', '฿'),
    (0x20BA, 'NotoSans-Bold.ttf', 'TRY', '₺'),
    (0x20AB, 'NotoSans-Bold.ttf', 'VND', '₫'),
    (0x20B5, 'NotoSans-Bold.ttf', 'GHS', '₵'),
    (0x20A9, 'NotoSans-Bold.ttf', 'WON', '₩'),
    (0x20AE, 'NotoSans-Bold.ttf', 'USDT', '₮'),
    (0x062F, 'NotoSansArabic-Bold.ttf', 'TND1', 'د'),
    (0x062A, 'NotoSansArabic-Bold.ttf', 'TND2', 'ت'),
    (0x005A, 'NotoSans-Bold.ttf', 'ZMW', 'Z'),  # "ZK" — CJK/Thai subsets can drop Latin Z
]

WOFF2_BY_TTF = {
    'ko-subset.ttf': 'font_ko.woff2',
    'zh-cn-subset.ttf': 'font_zh-cn.woff2',
    'zh-tw-subset.ttf': 'font_zh-tw.woff2',
    'ja-subset.ttf': 'font_ja.woff2',
    'th-subset.ttf': 'font_th.woff2',
    'tr-subset.ttf': 'font_tr.woff2',
}


def unicode_cmap(font: TTFont) -> dict:
    cmap = {}
    for table in font['cmap'].tables:
        if table.isUnicode():
            cmap.update(table.cmap)
    return cmap


def load_sources() -> dict:
    cache = {}
    for _cp, filename, _label, _ch in SPECIAL:
        if filename in cache:
            continue
        path = os.path.join(FONT_BASE, filename)
        if not os.path.isfile(path):
            raise FileNotFoundError(f'Missing source font: {path}')
        cache[filename] = TTFont(path)
    return cache


def transplant(src: TTFont, dst: TTFont, codepoint: int) -> str:
    dst_tables = [table for table in dst['cmap'].tables if table.isUnicode()]
    if not dst_tables:
        return 'no-cmap'
    if any(codepoint in table.cmap and table.cmap[codepoint] != '.notdef' for table in dst_tables):
        return 'have'

    src_name = unicode_cmap(src).get(codepoint)
    if not src_name or src_name == '.notdef':
        return 'src-missing'

    scale = dst['head'].unitsPerEm / src['head'].unitsPerEm
    # Composite source glyphs (₮, Arabic letters) reference other glyphs — flatten to outlines first.
    src_glyphs = src.getGlyphSet()
    outline = DecomposingRecordingPen(src_glyphs)
    src_glyphs[src_name].draw(outline)
    pen = TTGlyphPen(None)
    outline.replay(TransformPen(pen, Transform(scale, 0, 0, scale, 0, 0)))
    glyph = pen.glyph()
    if glyph.numberOfContours in (0, None):
        return 'blank'

    new_name = f'cur{codepoint:04X}'
    order = list(dst.getGlyphOrder())
    while new_name in order:
        new_name += 'x'
    order.append(new_name)
    dst.setGlyphOrder(order)
    dst['glyf'][new_name] = glyph

    advance, lsb = src['hmtx'][src_name]
    dst['hmtx'][new_name] = (int(round(advance * scale)), int(round(lsb * scale)))
    # CJK subsets carry vertical metrics (vhea/vmtx). Every glyph needs a vmtx entry, otherwise
    # browsers' font sanitizer (OTS) rejects the whole font and Cocos falls back to a system font.
    if 'vmtx' in dst:
        glyph.recalcBounds(dst['glyf'])
        v_adv = dst['head'].unitsPerEm
        v_top = int(round(dst['vhea'].ascent - getattr(glyph, 'yMax', 0))) if 'vhea' in dst else 0
        dst['vmtx'][new_name] = (v_adv, v_top)
    for table in dst_tables:
        table.cmap[codepoint] = new_name
    return 'added'


def inject_font(path: str, sources: dict) -> dict:
    font = TTFont(path)
    added = []
    skipped = []
    failed = []
    for codepoint, filename, label, _ch in SPECIAL:
        status = transplant(sources[filename], font, codepoint)
        if status == 'added':
            added.append(label)
        elif status == 'have':
            skipped.append(label)
        else:
            failed.append(f'{label}:{status}')

    if added:
        font['hhea'].numberOfHMetrics = len(font.getGlyphOrder())
        if 'vhea' in font:
            font['vhea'].numberOfVMetrics = len(font.getGlyphOrder())
        if 'maxp' in font:
            font['maxp'].numGlyphs = len(font.getGlyphOrder())
        tmp = path + '.currency.tmp'
        font.save(tmp)
        os.replace(tmp, path)

    font.close()
    return {'file': os.path.basename(path), 'added': added, 'failed': failed}


def rewrite_woff2(ttf_path: str, woff2_path: str) -> None:
    font = TTFont(ttf_path)
    font.flavor = 'woff2'
    tmp = woff2_path + '.currency.tmp'
    os.makedirs(os.path.dirname(woff2_path), exist_ok=True)
    font.save(tmp)
    os.replace(tmp, woff2_path)
    font.close()


def list_game_fonts(font_dir: str) -> list:
    return [
        os.path.join(font_dir, name)
        for name in sorted(os.listdir(font_dir))
        if name.lower().endswith('.ttf')
    ]


def glyph_missing(font_path: str, char: str) -> bool:
    from PIL import ImageFont
    font = ImageFont.truetype(font_path, 64)
    missing = font.getmask('\uffff', mode='1')
    got = font.getmask(char, mode='1')
    return bytes(got) == bytes(missing)


def render_report(font_dir: str) -> dict:
    from PIL import Image, ImageDraw, ImageFont

    fonts = list_game_fonts(font_dir)
    label_font = ImageFont.load_default()
    cell_w, cell_h = 78, 86
    name_w = 168
    header_h = 36
    width = name_w + cell_w * len(SPECIAL)
    height = header_h + cell_h * len(fonts)
    sheet = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(sheet)

    for index, (_cp, _file, label, _ch) in enumerate(SPECIAL):
        x = name_w + index * cell_w
        draw.rectangle([x, 0, x + cell_w - 1, header_h - 1], fill=(30, 30, 30))
        draw.text((x + 8, 12), label, fill='white', font=label_font)

    rows = []
    for row, font_path in enumerate(fonts):
        y = header_h + row * cell_h
        name = os.path.basename(font_path)
        draw.rectangle([0, y, name_w - 1, y + cell_h - 1], fill=(245, 245, 245))
        draw.text((8, y + 34), name.replace('-subset.ttf', ''), fill='black', font=label_font)
        game_font = ImageFont.truetype(font_path, 42)
        missing = []
        for index, (codepoint, _file, label, char) in enumerate(SPECIAL):
            x = name_w + index * cell_w
            absent = glyph_missing(font_path, char)
            if absent:
                missing.append(label)
            fill = (255, 214, 214) if absent else (255, 255, 255)
            draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=(210, 210, 210), fill=fill)
            bbox = draw.textbbox((0, 0), char, font=game_font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            draw.text((x + (cell_w - tw) / 2 - bbox[0], y + (cell_h - th) / 2 - bbox[1]), char, fill='black', font=game_font)
        rows.append({'file': name, 'missing': missing})

    buf = io.BytesIO()
    sheet.save(buf, format='PNG')
    failed = sum(len(row['missing']) for row in rows)
    return {
        'ok': failed == 0,
        'fonts': len(rows),
        'symbols': len(SPECIAL),
        'failed': failed,
        'rows': rows,
        'png': base64.b64encode(buf.getvalue()).decode('ascii'),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default=FONT_DIR)
    parser.add_argument('--font', action='append', default=[])
    parser.add_argument('--woff2-dir', default='')
    parser.add_argument('--report', action='store_true')
    args = parser.parse_args()

    targets = args.font or list_game_fonts(args.dir)
    if not args.report:
        sources = load_sources()
        for path in targets:
            result = inject_font(path, sources)
            added = ','.join(result['added']) or '-'
            failed = ','.join(result['failed']) or '-'
            print(f"{result['file']}: added [{added}] failed [{failed}]", file=sys.stderr)
            if args.woff2_dir:
                woff2_name = WOFF2_BY_TTF.get(os.path.basename(path))
                if woff2_name:
                    woff2_path = os.path.join(args.woff2_dir, woff2_name)
                    if os.path.isfile(woff2_path):
                        rewrite_woff2(path, woff2_path)
                        print(f'  woff2 {woff2_name}', file=sys.stderr)
        for font in sources.values():
            font.close()

    if not args.report:
        missing = []
        for path in targets:
            font = TTFont(path)
            cmap = unicode_cmap(font)
            absent = [label for cp, _file, label, _ch in SPECIAL if cp not in cmap or cmap[cp] == '.notdef']
            font.close()
            if absent:
                missing.append(f"{os.path.basename(path)}: {' '.join(absent)}")
        if missing:
            print('MISSING ' + ' | '.join(missing), file=sys.stderr)
            return 1
        print(f"OK {len(targets)} fonts x {len(SPECIAL)} symbols", file=sys.stderr)
        return 0

    report = render_report(args.dir)
    json.dump(report, sys.stdout, ensure_ascii=True)
    sys.stdout.write('\n')
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
