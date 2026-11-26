"""Cut the ShadowBlack "dock peek" render into src/mascot/sprites/dock.png.

Source: a Qwen Image Edit render of the official master (see the ShadowBlack kit; eyes untouched, never mirrored):
she peeks round the left edge of a dark-purple wall. The wall is dropped: on screen, the screen edge is the wall.
Everything right of WALL_X is cut away flat (that line is flush with the screen's right edge), white background and
enclosed white pockets (the tail curl) become transparent.
Run: python tools/make_dock_sprite.py <render.png> <wall_x> [left]   (needs Pillow, numpy, scipy)
With `left` the wall is on the LEFT of the render (she peeks round its right edge): everything left of wall_x is cut
away and the result is dock-left.png. Never mirrored: a left pose is its own render.
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

src, wall_x = sys.argv[1], int(sys.argv[2])
left = len(sys.argv) > 3 and sys.argv[3] == "left"
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "mascot", "sprites", "dock-left.png" if left else "dock.png")
a = np.array(Image.open(src).convert("RGBA"))
a = a[:, wall_x:] if left else a[:, :wall_x]
rgb = a[..., :3].astype(int)
white = (rgb.min(axis=2) > 232)
lab, n = ndimage.label(white)
sizes = ndimage.sum(white, lab, range(1, n + 1))
kill = np.zeros_like(white)
for i, s in enumerate(sizes, 1):
    if s > 2500:  # background and the tail-curl pocket; fangs and eye highlights are far smaller
        kill |= lab == i
# soften the cut edge one pixel so no white halo survives
kill = ndimage.binary_dilation(kill, iterations=1) & (rgb.min(axis=2) > 200)
a[..., 3] = np.where(kill, 0, 255)
im = Image.fromarray(a)
bbox = im.getbbox()
im = im.crop(bbox)
im.save(out)
print(out, im.size, "bbox", bbox)
