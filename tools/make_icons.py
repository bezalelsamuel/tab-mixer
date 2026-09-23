#!/usr/bin/env python3
"""Draws every Tab Mixer icon: the app icon, the extension icons shown in
Safari Settings, and the monochrome toolbar glyph.

    python3 tools/make_icons.py

Requires Pillow. Output paths are relative to the repo root.
"""
from pathlib import Path
import json

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
EXT_IMAGES = ROOT / "extension" / "images"
APPICON = ROOT / "Tab Mixer" / "Tab Mixer" / "Assets.xcassets" / "AppIcon.appiconset"
HOST_ICON = ROOT / "Tab Mixer" / "Tab Mixer" / "Resources" / "Icon.png"

S = 2048  # master canvas; everything is downscaled from this


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def vertical_gradient(w, h, top, bottom):
    t = Image.linear_gradient("L").resize((w, h))  # 0 at the top, 255 at the bottom
    return Image.composite(Image.new("RGBA", (w, h), hex_rgb(bottom)),
                           Image.new("RGBA", (w, h), hex_rgb(top)), t)


def squircle_mask(size, box, n=5.0):
    """macOS-style continuous-corner square (superellipse) filling `box`."""
    x0, y0, x1, y1 = box
    a = (x1 - x0) / 2
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    for y in range(int(y0), int(y1) + 1):
        r = 1 - abs((y + 0.5 - cy) / a) ** n
        if r > 0:
            half = a * r ** (1 / n)
            d.line((cx - half, y, cx + half, y), fill=255)
    return mask


def app_icon():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # Apple's macOS grid: 824/1024 body, centered, with a soft drop shadow.
    body = (S * 100 / 1024, S * 92 / 1024, S * 924 / 1024, S * 916 / 1024)
    mask = squircle_mask(S, body)

    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.putalpha(mask.point(lambda v: v * 0.45))
    shadow = shadow.transform(shadow.size, Image.AFFINE, (1, 0, 0, 0, 1, -S * 0.012))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(S * 0.018)))

    bg = vertical_gradient(S, S, "#6E5BFF", "#2A1A7A")
    img.paste(bg, (0, 0), mask)

    # Soft white highlight fading out by ~45% of the height, clipped to the body.
    fade = Image.linear_gradient("L").resize((S, S)).point(lambda v: max(0, 50 - v * 50 * 2.2 / 255))
    gloss = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    gloss.putalpha(ImageChops.multiply(fade, mask))
    img.alpha_composite(gloss)

    d = ImageDraw.Draw(img)
    u = S / 1024
    top, bottom = 250 * u, 760 * u
    track_w = 60 * u
    knob_w, knob_h = 164 * u, 84 * u
    faders = [  # (x center, level 0..1, fill top, fill bottom)
        (512 - 196, 0.42, "#64D2FF", "#0A84FF"),
        (512, 0.80, "#7CF29A", "#30D158"),
        (512 + 196, 0.58, "#FF9FBC", "#FF375F"),
    ]
    for x, level, c_top, c_bottom in faders:
        cx = x * u
        # Groove, blended over the background (drawing it directly would punch a hole).
        groove = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(groove).rounded_rectangle((cx - track_w / 2, top, cx + track_w / 2, bottom),
                                                 radius=track_w / 2, fill=(10, 6, 40, 110))
        img.alpha_composite(groove)
        # Level fill, bottom up to the knob.
        ky = bottom - level * (bottom - top)
        fill = vertical_gradient(int(track_w), int(bottom - ky), c_top, c_bottom)
        fmask = Image.new("L", fill.size, 0)
        ImageDraw.Draw(fmask).rounded_rectangle((0, 0, fill.size[0] - 1, fill.size[1] - 1),
                                                radius=track_w / 2, fill=255)
        img.paste(fill, (int(cx - track_w / 2), int(ky)), fmask)
        # Knob with a small shadow.
        ks = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(ks).rounded_rectangle(
            (cx - knob_w / 2, ky - knob_h / 2 + 10 * u, cx + knob_w / 2, ky + knob_h / 2 + 10 * u),
            radius=knob_h / 2, fill=(0, 0, 0, 90))
        img.alpha_composite(ks.filter(ImageFilter.GaussianBlur(10 * u)))
        d.rounded_rectangle((cx - knob_w / 2, ky - knob_h / 2, cx + knob_w / 2, ky + knob_h / 2),
                            radius=knob_h / 2, fill=(255, 255, 255, 255))
        d.rounded_rectangle((cx - knob_w * 0.28, ky - 5 * u, cx + knob_w * 0.28, ky + 5 * u),
                            radius=5 * u, fill=(120, 110, 170, 255))
    return img


def toolbar_glyph():
    """Black shape on transparency; Safari tints toolbar icons to match the toolbar."""
    img = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(img)
    line_w, knob_w, knob_h, gap = S * 0.085, S * 0.26, S * 0.17, S * 0.05
    top, bottom = S * 0.08, S * 0.92
    for x, level in ((0.2, 0.35), (0.5, 0.66), (0.8, 0.45)):
        cx = S * x
        ky = bottom - level * (bottom - top)
        d.rounded_rectangle((cx - line_w / 2, top, cx + line_w / 2, bottom), radius=line_w / 2, fill=255)
        # Clear a gap around the knob so it reads as separate from its track.
        d.rounded_rectangle((cx - knob_w / 2 - gap, ky - knob_h / 2 - gap, cx + knob_w / 2 + gap, ky + knob_h / 2 + gap),
                            radius=knob_h / 2 + gap, fill=0)
        d.rounded_rectangle((cx - knob_w / 2, ky - knob_h / 2, cx + knob_w / 2, ky + knob_h / 2),
                            radius=knob_h / 2, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.putalpha(img)
    return out


def save(img, path, px):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.resize((px, px), Image.LANCZOS).save(path, optimize=True)


def main():
    app = app_icon()
    glyph = toolbar_glyph()

    for px in (48, 96, 128, 256, 512):
        save(app, EXT_IMAGES / f"icon-{px}.png", px)
    for px in (16, 19, 32, 38, 48, 72):
        save(glyph, EXT_IMAGES / f"toolbar-{px}.png", px)

    images = []
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            name = f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
            save(app, APPICON / name, pt * scale)
            images.append({"filename": name, "idiom": "mac", "scale": f"{scale}x", "size": f"{pt}x{pt}"})
    (APPICON / "Contents.json").write_text(json.dumps(
        {"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n")

    save(app, HOST_ICON, 384)
    print("icons written")


if __name__ == "__main__":
    main()
