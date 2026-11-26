"""PawGauge icon, "Peek": ShadowBlack peeks round a vertical usage meter. One design for the app and the tray.

Source: the right-hand hiding render used for the tucked sprite (official master, Qwen Image Edit; never mirrored),
upscaled 4x with RealESRGAN x4plus anime (an upscaler only, nothing is generated). Her pixels are only cut out and
scaled. Added here: the meter, and a light rim so a black cat stays visible on a dark taskbar. At 24 px and below the
paw is left out, because it only turns into a blur there.

Writes build/icon.png, build/icon.ico, docs/icon.png and src/assets/tray/tray-<level>[@<scale>x].png.
Run: python tools/make_icon.py <render.png>   (square render, any size; needs Pillow, numpy, scipy)
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
S = 1024
SS = 2  # supersample factor for the drawn meter
TRACK = (46, 28, 84)
RIM = (196, 176, 255)
LEVEL = {"ok": (84, 211, 160), "warn": (242, 184, 75), "crit": (242, 107, 102)}
FRAC = {"ok": 0.62, "warn": 0.82, "crit": 0.97}  # a picture of the state, not a live reading
BAR = 270  # meter width on the 1024 canvas
WALL = 543  # x of the wall edge in the 1024 render
SMALL = 24  # at this size and below: face only

# Cut lines, traced on the 1024 render.
PAW = [(155, 93), (542, 93), (542, 538), (567, 550), (577, 595), (556, 620), (538, 633), (517, 672), (470, 667),
       (455, 620), (467, 592), (393, 597), (321, 572), (259, 507), (196, 372)]
FACE = [(155, 93), (542, 93), (542, 524), (517, 531), (494, 548), (472, 587), (414, 591), (341, 575), (281, 522),
        (233, 439), (186, 310)]


def curve(pts, steps=12):
    """Smooth a cut line (Catmull-Rom). Points on the wall edge and the top corners stay sharp."""
    n = len(pts)
    sharp = [x == 542 or y <= 100 for x, y in pts]
    out = []
    for i in range(n):
        p1, p2 = pts[i], pts[(i + 1) % n]
        if sharp[i] and sharp[(i + 1) % n]:
            out.append(p1)
            continue
        p0 = p1 if sharp[i] else pts[i - 1]
        p3 = p2 if sharp[(i + 1) % n] else pts[(i + 2) % n]
        for j in range(steps):
            t = j / steps
            out.append(tuple(0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t ** 3)
                             for a, b, c, d in zip(p0, p1, p2, p3)))
    return out


def cut(render, line):
    """Her cut-out, cropped to its box, and the x of the wall edge inside that crop."""
    k = render.width / 1024
    a = np.array(render)
    rgb = a[..., :3].astype(int)
    lab, n = ndimage.label(rgb.min(axis=2) > 232)
    sizes = np.bincount(lab.ravel())
    # background and the tail pocket; fangs and eye highlights are far smaller
    bg = np.isin(lab, [i for i in range(1, n + 1) if sizes[i] > 2500 * k * k])
    bg = ndimage.binary_dilation(bg, iterations=round(2 * k)) & (rgb.min(axis=2) > 185)
    ss = 2
    m = Image.new("L", (render.width * ss, render.height * ss), 0)
    ImageDraw.Draw(m).polygon([(x * k * ss, y * k * ss) for x, y in curve(line)], fill=255)
    alpha = np.where(bg, 0, np.array(m.resize(render.size, Image.LANCZOS)))
    lab, n = ndimage.label(alpha > 128)  # keep her only, no loose specks
    if n > 1:
        main = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
        alpha = np.where(ndimage.binary_dilation(main, iterations=round(2 * k)), alpha, 0)
    a[..., 3] = alpha
    out = Image.fromarray(a)
    box = out.getchannel("A").point(lambda v: 255 if v > 128 else 0).getbbox()
    return out.crop(box), WALL * k - box[0]


def design(her, wall, level):
    """The 1024 artwork: meter on the right, her wall edge tucked just inside it."""
    k = min((S - BAR - 16) / wall, (S - 16) / her.height)
    w, h = round(her.width * k), round(her.height * k)
    big = her.convert("RGBa").resize((w, h), Image.LANCZOS).convert("RGBA")
    x0 = (S - (round(wall * k) + BAR)) // 2
    bx = x0 + round(wall * k)
    meter = Image.new("RGBA", (S * SS, S * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(meter)
    y0, y1, inset = 14, S - 14, round(BAR * 0.17)
    d.rounded_rectangle([bx * SS, y0 * SS, (bx + BAR) * SS, y1 * SS], radius=70 * SS, fill=TRACK + (255,))
    top = y1 - inset - round((y1 - y0 - 2 * inset) * FRAC[level])
    d.rounded_rectangle([(bx + inset) * SS, top * SS, (bx + BAR - inset) * SS, (y1 - inset) * SS],
                        radius=(BAR - 2 * inset) * SS // 3, fill=LEVEL[level] + (255,))
    canvas = meter.resize((S, S), Image.LANCZOS)
    top_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    top_layer.paste(big, (bx + 6 - round(wall * k), (S - h) // 2), big)
    canvas.alpha_composite(top_layer)
    return canvas


def render_at(art, size):
    """Downscale, then add the rim at the target size so it never gets thinner than about 1 px."""
    pad = max(1, round(size * 0.035))
    inner = art.convert("RGBa").resize((size - 2 * pad, size - 2 * pad), Image.LANCZOS).convert("RGBA")
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    c.alpha_composite(inner, (pad, pad))
    dist = ndimage.distance_transform_edt(np.array(c.getchannel("A")) < 128)
    ring = np.clip(max(0.8, size * 0.018) + 0.5 - dist, 0, 1) * (0.85 if size <= 48 else 0.9)
    rim = np.zeros((size, size, 4), np.uint8)
    rim[..., :3] = RIM
    rim[..., 3] = (ring * 255).astype(np.uint8)
    out = Image.fromarray(rim)
    out.alpha_composite(c)
    return out


def main(src):
    render = Image.open(src).convert("RGBA")
    paw, face = cut(render, PAW), cut(render, FACE)

    def icon(size, level="ok"):
        return render_at(design(*(face if size <= SMALL else paw), level), size)

    (ROOT / "src/assets/tray").mkdir(parents=True, exist_ok=True)
    icon(1024).save(ROOT / "build/icon.png")
    icon(256).save(ROOT / "docs/icon.png")
    sizes = [256, 128, 64, 48, 40, 32, 24, 20, 16]
    frames = [icon(s) for s in sizes]
    frames[0].save(ROOT / "build/icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])
    for level in LEVEL:  # Electron picks the @<scale>x file that matches the display scaling
        for suffix, size in (("", 16), ("@1.25x", 20), ("@1.5x", 24), ("@2x", 32)):
            icon(size, level).save(ROOT / f"src/assets/tray/tray-{level}{suffix}.png")
    print("icons written")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
