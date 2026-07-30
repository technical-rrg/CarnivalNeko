#!/usr/bin/env python3
"""Scale Base-boot Spine atlas PNGs so max edge <= MAX_EDGE and rewrite atlas.txt coords."""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow required. pip install Pillow", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1] / "assets" / "bundle" / "newSpine"
MAX_EDGE = 1536

# (png relative to newSpine, atlas relative to newSpine)
TARGETS = [
    ("Longspin/anim-longspin.png", "Longspin/anim-longspin.atlas.txt"),
    ("Anim-Select-New-Feature/Anim-New-Feature.png", "Anim-Select-New-Feature/Anim-New-Feature.atlas.txt"),
    ("Win-Border/anim-win-border.png", "Win-Border/anim-win-border.atlas.txt"),
    ("Anim-TitleGame/TitleGame.png", "Anim-TitleGame/TitleGame.atlas.txt"),
]


def scale_atlas_text(text: str, scale: float, new_w: int, new_h: int) -> str:
    lines = text.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    size_re = re.compile(r"^size:\s*(\d+)\s*,\s*(\d+)\s*$")
    xy_re = re.compile(r"^(\s*xy:\s*)(\d+)\s*,\s*(\d+)\s*$")
    size_kv_re = re.compile(r"^(\s*size:\s*)(\d+)\s*,\s*(\d+)\s*$")
    orig_re = re.compile(r"^(\s*orig:\s*)(\d+)\s*,\s*(\d+)\s*$")
    offset_re = re.compile(r"^(\s*offset:\s*)(-?\d+)\s*,\s*(-?\d+)\s*$")

    # First non-empty line after blank is page name; next "size:" is page size
    page_size_done = False
    for line in lines:
        m = size_re.match(line)
        if m and not page_size_done:
            out.append(f"size: {new_w}, {new_h}")
            page_size_done = True
            continue

        m = xy_re.match(line)
        if m:
            x = max(0, int(round(int(m.group(2)) * scale)))
            y = max(0, int(round(int(m.group(3)) * scale)))
            out.append(f"{m.group(1)}{x}, {y}")
            continue

        m = size_kv_re.match(line)
        if m:
            w = max(1, int(round(int(m.group(2)) * scale)))
            h = max(1, int(round(int(m.group(3)) * scale)))
            out.append(f"{m.group(1)}{w}, {h}")
            continue

        m = orig_re.match(line)
        if m:
            w = max(1, int(round(int(m.group(2)) * scale)))
            h = max(1, int(round(int(m.group(3)) * scale)))
            out.append(f"{m.group(1)}{w}, {h}")
            continue

        m = offset_re.match(line)
        if m:
            x = int(round(int(m.group(2)) * scale))
            y = int(round(int(m.group(3)) * scale))
            out.append(f"{m.group(1)}{x}, {y}")
            continue

        out.append(line)

    return "\n".join(out)


def process(png_rel: str, atlas_rel: str) -> None:
    png_path = ROOT / png_rel
    atlas_path = ROOT / atlas_rel
    if not png_path.is_file():
        print(f"SKIP missing png: {png_path}")
        return
    if not atlas_path.is_file():
        print(f"SKIP missing atlas: {atlas_path}")
        return

    img = Image.open(png_path)
    w, h = img.size
    edge = max(w, h)
    if edge <= MAX_EDGE:
        print(f"OK already <= {MAX_EDGE}: {png_rel} ({w}x{h})")
        img.close()
        return

    scale = MAX_EDGE / float(edge)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    print(f"SCALE {png_rel}: {w}x{h} -> {new_w}x{new_h} (factor={scale:.4f})")

    resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    img.close()
    # Keep PNG; Spine atlases use PNG
    resized.save(png_path, format="PNG", optimize=True)
    resized.close()

    atlas_text = atlas_path.read_text(encoding="utf-8")
    atlas_path.write_text(scale_atlas_text(atlas_text, scale, new_w, new_h), encoding="utf-8", newline="\n")
    print(f"  updated {atlas_rel}")


def main() -> int:
    if not ROOT.is_dir():
        print(f"ERROR: {ROOT} not found", file=sys.stderr)
        return 1
    for png_rel, atlas_rel in TARGETS:
        process(png_rel, atlas_rel)
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
