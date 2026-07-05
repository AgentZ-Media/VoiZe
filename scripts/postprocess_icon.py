#!/usr/bin/env python3
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


def fallback_icon(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(bg)
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(18 + 12 * t)
        g = int(21 + 20 * t)
        b = int(28 + 34 * t)
        bdraw.line([(0, y), (size, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle((86, 86, size - 86, size - 86), radius=210, fill=255)
    img.alpha_composite(Image.composite(bg, Image.new("RGBA", (size, size)), mask))

    cx = cy = size // 2
    for radius, alpha in [(270, 30), (215, 54), (162, 86)]:
        draw.ellipse(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            outline=(110, 230, 230, alpha),
            width=18,
        )
    for i, h in enumerate([180, 260, 330, 410, 330, 260, 180]):
        x = cx - 210 + i * 70
        draw.rounded_rectangle(
            (x - 16, cy - h // 2, x + 16, cy + h // 2),
            radius=16,
            fill=(214, 245, 244, 235),
        )
    draw.ellipse((cx - 54, cy - 54, cx + 54, cy + 54), fill=(72, 220, 218, 255))
    return img


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def process(src: Path | None, dest: Path) -> None:
    size = 1024
    if src and src.exists():
        base = Image.open(src).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    else:
        base = fallback_icon(size)
    outer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = rounded_rect_mask(size, 225)
    outer.alpha_composite(Image.composite(base, Image.new("RGBA", (size, size)), mask))
    dest.parent.mkdir(parents=True, exist_ok=True)
    outer.save(dest)


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 2 and sys.argv[1] != "-" else None
    output = Path(sys.argv[-1])
    process(source, output)
