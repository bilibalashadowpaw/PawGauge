"""Build the ShadowBlack mascot sprites used by PawGauge's perch window.

Source: the official ShadowBlack masters (never edited or mirrored); set SHADOWBLACK_KIT to the folder holding
01_poses/ (the art is not part of the MIT-licensed code, see ART-LICENSE.md).
Output: src/mascot/sprites/  (copied into the project, never referenced from the kit at build time)

- peek-body.png / peek-tail.png: the official `sb-peek` pose with its purple block removed. The cat is cut at the line
  where her paws end, so that line sits exactly on the top edge of the PawGauge window and she appears to rest her
  paws on it. The tail is a separate layer so it can sway about a pivot hidden behind the window edge.
She always stays in this one pose (clinging to the window edge); moods are expressed with motion.

Run: python tools/make_sprites.py   (needs Pillow, numpy and scipy)
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

if not os.environ.get("SHADOWBLACK_KIT"):
    sys.exit("Set SHADOWBLACK_KIT to the folder holding the official ShadowBlack masters (01_poses/). The art is not in this repository.")
KIT = os.path.join(os.environ["SHADOWBLACK_KIT"], "01_poses")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "mascot", "sprites")
os.makedirs(OUT, exist_ok=True)

# Geometry of sb-peek at 1024 px (measured: block top y=597, paw bottoms y=634).
BLOCK_TOP = 597
CUT_Y = 635           # first row that is removed: the paws end here
HEAD_L, HEAD_R = 345, 755   # horizontal span of the head/neck behind the paws (paws sit at 350-470 and 630-750)
ARM_FROM = 580            # first row where the block corner starts to cover the tail arm
TAIL_KEEP = 165             # in the paws strip, tail pixels exist only left of this x
TAIL_X = 277          # tail ends at ~269; the head outline starts at ~283, so cut between them
TAIL_Y0 = 430
EXT = 34              # extra body rows below the window line (hidden at rest; covers hops and head tilts)
CROP = (56, 100, 832, CUT_Y + EXT)  # l, t, r, b of the output sprite in 1024 space
SCALE = 0.60          # 1024-space -> sprite pixels (2x of the 0.30 display scale)

BLOCK = np.array([74, 47, 100])


def is_block(a):
    d = np.abs(a[..., :3].astype(int) - BLOCK)
    return (d[..., 0] < 22) & (d[..., 1] < 22) & (d[..., 2] < 24) & (a[..., 3] > 200)


def peek():
    im = Image.open(os.path.join(KIT, "1024", "sb-peek.png")).convert("RGBA")
    a = np.array(im)
    blk = is_block(a)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]

    cat = a.copy()
    # Below the paws line: nothing. Above the block top: untouched art.
    cat[yy >= CUT_Y] = 0
    ext_rows = (yy >= CUT_Y) & (yy < CUT_Y + EXT) & (xx >= 352) & (xx <= 748)
    # Between block top and paws line, block pixels are the window's stand-in. Where she is (head span) the body
    # simply continues behind her paws, so fill black; outside the head span drop them.
    # In the strip just above the paws line, keep only the tail (x < TAIL_KEEP) and the head/paws span, and fill block
    # pixels inside that span with black. Everything else in the strip is the block's rim and is dropped.
    strip = (yy >= BLOCK_TOP - 14) & (yy < CUT_Y)
    in_span = (xx >= HEAD_L) & (xx <= HEAD_R)
    fill = strip & in_span & blk
    cat[fill] = (0, 0, 0, 255)
    cat[strip & ~in_span & (xx >= TAIL_X)] = 0
    # The tail arm keeps its pixels down to the block top (the block hid the rest); below that is the block's corner.
    cat[(yy >= BLOCK_TOP) & (yy < CUT_Y) & (xx >= TAIL_KEEP) & (xx < TAIL_X)] = 0
    cat[strip & ~in_span & blk] = 0
    # Between the paws only chin and body continue behind them: solid black (drops block speckle).
    cat[strip & (xx >= 470) & (xx <= 630)] = (0, 0, 0, 255)

    tail_mask = (xx < TAIL_X) & (yy > TAIL_Y0)
    tail = cat.copy()
    tail[~tail_mask] = 0
    # Let the tail run straight down behind the window line (no gap whatever she does): the arm repeats its last row
    # below the block top, and the left stem repeats its last row below the cut.
    arm = (xx >= TAIL_KEEP) & (xx < TAIL_X)
    # (the block's rounded corner covered the arm from y~583, so repeat a clean row above it)
    for y in range(ARM_FROM, CUT_Y + EXT):
        sel = arm[y]
        tail[y][sel] = tail[ARM_FROM - 2][sel]
    for y in range(CUT_Y, CUT_Y + EXT):
        sel = (xx[y] < TAIL_KEEP) & (tail[CUT_Y - 1][:, 3] > 0)
        tail[y][sel] = tail[CUT_Y - 1][sel]
    # Keep only the tail itself: drop stray fragments (e.g. slivers of the head outline) with a connected-component pass.
    lab, n = ndimage.label(tail[..., 3] > 0)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        keep = lab == (1 + int(np.argmax(sizes)))
        dropped = sorted((int(s) for s in sizes), reverse=True)[1:]
        print(f"tail: dropped {len(dropped)} fragment(s), sizes {dropped} px (kept {int(sizes.max())} px)")
        tail[~keep] = 0
    body = cat.copy()
    body[tail_mask] = 0
    body[ext_rows] = (0, 0, 0, 255)

    l, t, r, b = CROP
    size = (round((r - l) * SCALE), round((b - t) * SCALE))
    for name, arr in (("peek-body", body), ("peek-tail", tail)):
        img = Image.fromarray(arr).crop(CROP).resize(size, Image.LANCZOS)
        img.save(os.path.join(OUT, f"{name}.png"), optimize=True)

    # Tail pivot: where the tail meets the cut line, in output pixels (hidden behind the window edge).
    ys, xs = np.where(tail[CUT_Y - 6, :, 3] > 128)[0], None
    xs_tail = np.where(tail[CUT_Y - 6, :, 3] > 128)[0]
    px = (float(xs_tail.mean()) - l) * SCALE if len(xs_tail) else 60.0
    py = (CUT_Y - t) * SCALE
    return {"width": size[0], "height": size[1], "tailPivot": [round(px, 1), round(py, 1)]}


if __name__ == "__main__":
    meta = {"peek": peek(), "kitScale": SCALE}
    with open(os.path.join(OUT, "sprites.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta, indent=2))
    sys.exit(0)
