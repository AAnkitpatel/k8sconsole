"""K8sConsole icon (original artwork): a console prompt ">_" with a three-node cluster mark.

Writes build/assets/icon.svg plus PNG sizes 16-512 drawn from the same geometry.
Usage: python3 -I build/scripts/make-icon.py build/assets
"""
import sys
from PIL import Image, ImageDraw

TOP = (30, 41, 110)      # deep indigo
BOTTOM = (14, 148, 136)  # teal
INK = (255, 255, 255, 255)
ACCENT = (125, 249, 205, 255)  # mint, for the cluster mark

# Geometry in a 512x512 design space.
RADIUS = 112
CHEVRON = [(118, 170), (222, 256), (118, 342)]  # ">" polyline
CHEVRON_W = 46
CURSOR = (250, 318, 380, 360)                   # "_" bar
NODES = [(356, 132), (420, 172), (358, 214)]    # cluster mark (three nodes)
NODE_R = 22
LINK_W = 10


def svg() -> str:
    pts = " ".join(f"{x},{y}" for x, y in CHEVRON)
    links = "".join(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}"/>' for a, b in [(NODES[0], NODES[1]), (NODES[1], NODES[2]), (NODES[2], NODES[0])])
    nodes = "".join(f'<circle cx="{x}" cy="{y}" r="{NODE_R}"/>' for x, y in NODES)
    x1, y1, x2, y2 = CURSOR
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="K8sConsole">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="rgb{TOP}"/><stop offset="1" stop-color="rgb{BOTTOM}"/></linearGradient></defs>
  <rect width="512" height="512" rx="{RADIUS}" fill="url(#g)"/>
  <polyline points="{pts}" fill="none" stroke="#fff" stroke-width="{CHEVRON_W}" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="{x1}" y="{y1}" width="{x2 - x1}" height="{y2 - y1}" rx="{(y2 - y1) // 2}" fill="#fff"/>
  <g stroke="rgb{ACCENT[:3]}" stroke-width="{LINK_W}" stroke-linecap="round">{links}</g>
  <g fill="rgb{ACCENT[:3]}">{nodes}</g>
</svg>
"""


def png(size: int) -> Image.Image:
    s = 4 * size  # supersample
    f = s / 512
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / s
        gd.line([(0, y), (s, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(RADIUS * f), fill=255)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    pts = [(x * f, y * f) for x, y in CHEVRON]
    w = int(CHEVRON_W * f)
    d.line(pts, fill=INK, width=w, joint="curve")
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=INK)
    x1, y1, x2, y2 = [v * f for v in CURSOR]
    d.rounded_rectangle([x1, y1, x2, y2], radius=(y2 - y1) / 2, fill=INK)
    n = [(x * f, y * f) for x, y in NODES]
    for a, b in [(n[0], n[1]), (n[1], n[2]), (n[2], n[0])]:
        d.line([a, b], fill=ACCENT, width=int(LINK_W * f))
    r = NODE_R * f
    for x, y in n:
        d.ellipse([x - r, y - r, x + r, y + r], fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


out = sys.argv[1]
with open(f"{out}/icon.svg", "w") as fh:
    fh.write(svg())
for sz in (16, 32, 48, 64, 128, 256, 512):
    png(sz).save(f"{out}/icon-{sz}.png")
png(512).save(f"{out}/icon.png")
print("ok")
