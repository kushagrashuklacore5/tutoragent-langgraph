"""Turns the supplied reference image into Vidya's surface textures (run once; outputs are read by build.ts).
    python apps/tutor-demo/tools/vidya/prepare_textures.py "<path to the reference image>"
The face is levelled, its teeth are repainted into a closed smile, and eye openings become transparent, so real
eyeballs and teeth can move behind it. Cloth patterns are taken from the visible parts of the same image."""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'textures')
os.makedirs(OUT, exist_ok=True)
im = Image.open(SRC).convert('RGB')

# ---------- face: measured in the levelled image ----------
level = im.rotate(math.degrees(math.atan2(12, 61)), resample=Image.BICUBIC, center=(474.5, 135))
X0, Y0, SIDE = 352, 19, 250
crop = level.crop((X0, Y0, X0 + SIDE, Y0 + SIDE)).resize((1000, 1000), Image.LANCZOS)
face = np.asarray(crop).astype(np.float32)
S = 1000 / SIDE
yy, xx = np.mgrid[0:1000, 0:1000]
px, py = xx / S + X0, yy / S + Y0

# closed, gentle smile: teeth are replaced by the lips' own colours, meeting on one soft line
def mouth_line(x): return 183.2 + 7.2 * np.clip(1 - ((x - 476) / 27.5) ** 2, 0, 1)
def upper_edge(x): return 183.0 + 3.6 * np.clip(1 - ((x - 476) / 27.5) ** 2, 0, 1)
def lower_edge(x): return 183.4 + 11.6 * np.clip(1 - ((x - 476) / 27.5) ** 2, 0, 1)
for col in range(int((447 - X0) * S), int((506 - X0) * S)):
    x = col / S + X0
    u, m, l = float(upper_edge(x)), float(mouth_line(x)), float(lower_edge(x))
    if l - u < 0.5: continue
    top = face[max(0, int((u - 1.6 - Y0) * S)), col]
    bot = face[min(999, int((l + 2.4 - Y0) * S)), col]
    for row in range(int((u - Y0) * S), int((l - Y0) * S) + 1):
        y = row / S + Y0
        c = top * (0.96 + 0.05 * (y - u) / max(0.5, m - u)) if y < m else bot * (1.03 - 0.05 * (y - m) / max(0.5, l - m))
        face[row, col] = np.clip(c, 0, 255)
    for row in range(int((m - 0.65 - Y0) * S), int((m + 0.65 - Y0) * S) + 1):
        k = 1 - abs(row / S + Y0 - m) / 0.65
        face[row, col] = face[row, col] * (1 - 0.72 * k) + np.array([74, 28, 30]) * 0.72 * k

# outside the measured face outline the head is covered by real hair, so plain skin continues there
OUTLINE = [(437, 77), (460, 67), (478, 65), (497, 68), (512, 77), (522, 98), (526, 125), (525, 150), (521, 170), (515, 190), (506, 205), (496, 218), (484, 227), (468, 226), (450, 218), (433, 205), (420, 188), (412, 165), (412, 140), (417, 115), (424, 95)]
shape = Image.new('L', (1000, 1000), 0)
ImageDraw.Draw(shape).polygon([((x - X0) * S, (y - Y0) * S) for x, y in OUTLINE], fill=255)
inside_face = np.asarray(shape.filter(ImageFilter.GaussianBlur(7))).astype(np.float32)[..., None] / 255
sample = face[int((95 - Y0) * S):int((112 - Y0) * S), int((462 - X0) * S):int((472 - X0) * S)].reshape(-1, 3).mean(0)
rgb = face * inside_face + sample * (1 - inside_face)

# eye openings
def lid(x, a, b, apex):
    t = (x - a[0]) / (b[0] - a[0])
    chord = a[1] + (b[1] - a[1]) * t
    return chord + (apex - (a[1] + b[1]) / 2) * 4 * t * (1 - t)
alpha = np.full((1000, 1000), 255.0)
for a, b, top, bottom in [((431.0, 136.5), (460.0, 139.0), 126.6, 141.6), ((491.0, 139.5), (519.0, 136.0), 126.6, 141.6)]:
    inside = (px > a[0]) & (px < b[0]) & (py > lid(px, a, b, top)) & (py < lid(px, a, b, bottom))
    alpha[inside] = 0
alpha = np.asarray(Image.fromarray(np.uint8(alpha)).filter(ImageFilter.GaussianBlur(1.6))).astype(np.float32)
sharp = Image.fromarray(np.uint8(np.clip(rgb, 0, 255))).filter(ImageFilter.UnsharpMask(radius=5, percent=70, threshold=2))
out = np.dstack([np.asarray(sharp), np.uint8(alpha)])
Image.fromarray(out, 'RGBA').save(os.path.join(OUT, 'face.png'), optimize=True)

# ---------- kurta: its real motifs and hem, made seamless by mirroring ----------
source = np.asarray(im)
band = np.vstack([source[650:985, 352:500], source[650:1105, 352:500]])
tile = np.hstack([band, band[:, ::-1]])
Image.fromarray(tile).resize((512, 1024), Image.LANCZOS).save(os.path.join(OUT, 'kurta.jpg'), quality=86)

# ---------- dupatta: its real print and border, with the background keyed out ----------
d = source[275:1285, 520:705].astype(np.float32)
r, g, b = d[..., 0], d[..., 1], d[..., 2]
keep = ~((r > 205) & (b / np.maximum(r, 1) > 0.76))
DUP = [(520, 275), (600, 282), (608, 360), (592, 440), (615, 520), (640, 600), (660, 700), (680, 800), (693, 860), (664, 900), (656, 1000), (646, 1100), (651, 1200), (640, 1242), (556, 1272), (536, 1200), (518, 1130)]
outline = Image.new('L', (d.shape[1], d.shape[0]), 0)
ImageDraw.Draw(outline).polygon([(x - 520, y - 275) for x, y in DUP], fill=255)
keep = keep & (np.asarray(outline) > 0)
mask = Image.fromarray(np.uint8(keep * 255)).filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.GaussianBlur(0.8))
rgba = np.dstack([np.uint8(d), np.asarray(mask)])
Image.fromarray(rgba, 'RGBA').resize((370, 1024), Image.LANCZOS).save(os.path.join(OUT, 'dupatta.png'), optimize=True)


# ---------- hair: tapered strands with soft highlights ----------
rng = np.random.default_rng(7)
H, W = 512, 256
col = np.zeros((H, W, 3), np.float32) + np.array([31, 20, 16])
al = np.zeros((H, W), np.float32)
for _ in range(260):
    x0 = rng.uniform(0, W); w = rng.uniform(1.2, 5.5); drift = rng.uniform(-10, 10); light = rng.uniform(0, 1) ** 2.4
    tone = np.array([31, 20, 16]) + np.array([92, 66, 50]) * light
    end = rng.uniform(0.82, 1.0) * H
    for y in range(int(end)):
        t = y / end
        cx = x0 + drift * t + 2.4 * math.sin(t * 7 + x0)
        half = w * (1 - t ** 3)
        for x in range(int(cx - half - 1), int(cx + half + 2)):
            k = max(0.0, 1 - abs(x - cx) / max(half, 0.6))
            xw = x % W
            if k > 0:
                col[y, xw] = col[y, xw] * (1 - k * 0.8) + tone * k * 0.8
                al[y, xw] = max(al[y, xw], k * 255)
shine = np.exp(-(((np.arange(H) / H) - 0.32) / 0.11) ** 2)[:, None, None] * np.array([34, 25, 20])
Image.fromarray(np.dstack([np.uint8(np.clip(col + shine, 0, 255)), np.uint8(al)]), 'RGBA').save(os.path.join(OUT, 'hair.png'), optimize=True)

# ---------- eye: iris colours sampled from the reference's own eye ----------
E = 256
yy, xx = np.mgrid[0:E, 0:E]
dx, dy = (xx - 128) / 128, (yy - 128) / 128
rad, ang = np.hypot(dx, dy), np.arctan2(dy, dx)
eye = np.dstack([np.full((E, E), 248.0), np.full((E, E), 243.0), np.full((E, E), 238.0)])
R = 0.58
t = np.clip(rad / R, 0, 1)
fib = 0.88 + 0.12 * np.sin(ang * 37) * np.sin(ang * 11 + 1)
iris = np.dstack([(70 + 92 * t ** 1.3) * fib, (40 + 58 * t ** 1.3) * fib, (20 + 26 * t) * fib]) * (1 - np.clip((t - 0.86) * 5, 0, 0.74))[..., None]
eye = np.where((rad < R)[..., None], iris, eye)
eye[rad < 0.27] = [12, 8, 8]
eye[np.hypot(dx + 0.15, dy + 0.2) < 0.1] = [255, 255, 255]
eye[np.hypot(dx - 0.18, dy - 0.2) < 0.045] = [232, 220, 212]
Image.fromarray(np.uint8(np.clip(eye, 0, 255))).save(os.path.join(OUT, 'eye.jpg'), quality=90)

# ---------- ID card: redrawn from the reference at usable size ----------
Image.fromarray(source[478:552, 475:517]).resize((128, 224), Image.LANCZOS).save(os.path.join(OUT, 'card.jpg'), quality=88)
print({f: os.path.getsize(os.path.join(OUT, f)) for f in sorted(os.listdir(OUT))})
