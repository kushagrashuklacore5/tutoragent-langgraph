"""
Vidya's mouth shapes (visemes) and eyelids, made from the ORIGINAL face pixels by a smooth warp. Nothing is painted
over her face except the inside of an opened mouth (sampled from the dark lip line of the original).

  jaw open (J px): the lower lip and the skin under it move down, corners stay where the artist drew them, the chin
                   outline stays fixed; the gap that opens between the upper teeth and the lower lip is the inside
                   of the mouth
  width (e):       lips widen (E/I) or round (O/U) around the mouth centre, fading out before the cheeks
  closure (J < 0): the lower lip rises over the teeth (M/B/P, F/V)
  blink (b):       the upper lid moves down over the eye; the eye band compresses into the lash line

Every displacement fades smoothly to zero at the sprite edge, so a sprite laid over body.png has no seam.
  python tools/vidya2d/face.py  (writes public/vidya2d/mouth-*.png, eyes-*.png and the face boxes in rig.json)
"""
import json, os
import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, '..', '..', 'public', 'vidya2d')
rig = json.load(open(os.path.join(OUT, 'rig.json')))
B = rig['layers']['body']
body = np.asarray(Image.open(os.path.join(OUT, B['file'])).convert('RGBA')).astype(np.float32)
OX, OY = B['x'], B['y']  # body.png offset in source coordinates

def src_crop(x0, y0, x1, y1):
    return body[y0 - OY:y1 - OY, x0 - OX:x1 - OX].copy()

def sample(img, xs, ys):
    """bilinear sample of img (H, W, 4) at float coordinates (clamped)"""
    h, w = img.shape[:2]
    xs = np.clip(xs, 0, w - 1.001); ys = np.clip(ys, 0, h - 1.001)
    x0 = np.floor(xs).astype(int); y0 = np.floor(ys).astype(int)
    fx = (xs - x0)[..., None]; fy = (ys - y0)[..., None]
    a = img[y0, x0]; b = img[y0, x0 + 1]; c = img[y0 + 1, x0]; d = img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)

# ── mouth (source coordinates, measured on the original) ──
MX0, MY0, MX1, MY1 = 552, 148, 636, 202     # sprite box: lips, corners, the skin down to above the chin outline
CX, LIP = 594.0, 171.5                      # mouth centre; the line between the upper teeth and the lower lip
LEFT, RIGHT = 569.0, 618.0                  # corners
CHIN = 197.0
SMILE = 8.0                                 # how far the lip line rises from the centre to the corners                                # lowest row that moves (the chin outline below it stays)
mouth = src_crop(MX0, MY0, MX1, MY1)
H, W = mouth.shape[:2]
YY, XX = np.mgrid[0:H, 0:W].astype(np.float32)
X = XX + MX0; Y = YY + MY0
# how much of the jaw drop a column gets: 1 at the centre, 0 at the corners (the opening is lens-shaped)
half = (RIGHT - LEFT) / 2
colw = np.maximum(0, np.cos(np.clip((X - CX) / (half + 2), -1, 1) * np.pi / 2)) ** 1.4
# the dark of the lip line in the original: the inside of the mouth is drawn in these colours
line = mouth[(np.abs(Y - LIP) < 1.6) & (np.abs(X - CX) < half - 6)]
dark = line[np.argsort(line[:, :3].sum(1))[: max(3, len(line) // 5)]].mean(0)
INSIDE = np.array([dark[0] * 0.72, dark[1] * 0.55, dark[2] * 0.55, 255.0])
TONGUE = np.array([176.0, 86.0, 84.0, 255.0])

def mouth_shape(J, e):
    # 1) width: inverse horizontal scale around the centre, fading out above/below the lips and beyond the corners
    band = smooth(1 - np.abs(Y - LIP) / 13.0)
    side = smooth(1 - (np.abs(X - CX) - half) / 12.0)
    k = 1 + e * band * side
    xs = CX + (X - CX) / k
    # 2) jaw: below the lip line, a row moves by J * colw * fall(y); invert the monotone column mapping
    out = np.zeros_like(mouth)
    for j in range(W):
        x = X[0, j]
        cw = colw[0, j] if J >= 0 else colw[0, j] ** 0.6
        # the lip line follows her smile: lowest at the centre, rising to the corners
        lip = LIP - SMILE * min(1.0, ((x - CX) / half) ** 2)
        ysrc = Y[:, j]
        fall = smooth(1 - (ysrc - lip) / (CHIN - lip))
        lower = ysrc >= lip
        fwd = np.where(lower, ysrc + J * cw * fall, ysrc)                # where each source row lands
        inv = np.interp(Y[:, j], fwd[lower], ysrc[lower])                 # source row for each output row (lower part)
        top = lip + J * cw                                                # top edge of the moved lower lip
        upper_c = sample(mouth, xs[:, j] - MX0, Y[:, j] - MY0)
        lower_c = sample(mouth, xs[:, j] - MX0, inv - MY0)
        # per-row share of the lower lip (anti-aliased edge at `top`)
        share = np.clip(Y[:, j] + 0.5 - top, 0, 1)[:, None]
        col = upper_c * (1 - share) + lower_c * share
        if J > 0.3 and cw > 0.05:
            # the opened gap between the upper teeth and the lower lip: the inside of the mouth
            cov = np.clip(np.minimum(Y[:, j] + 0.5, top) - np.maximum(Y[:, j] - 0.5, lip), 0, 1)[:, None]
            t = np.clip((Y[:, j] - lip) / max(0.5, top - lip), 0, 1)[:, None]
            tongue = np.clip((t - 0.55) / 0.45, 0, 1) * min(1.0, J / 6)
            inside = INSIDE * (1 - tongue) + TONGUE * tongue
            col = col * (1 - cov) + inside * cov
        out[:, j] = col
    # alpha: everything moved lies inside the box; feather the outer 3 px so the sprite edge never shows
    fx = smooth(np.minimum(XX, W - 1 - XX) / 3.0); fy = smooth(np.minimum(YY, H - 1 - YY) / 3.0)
    out[..., 3] = mouth[..., 3] * fx * fy
    return out

# viseme → (jaw opening px, width change); sizes are for a 49 px wide mouth
VISEMES = {
    'aa': (7.0, 0.02), 'ee': (2.6, 0.10), 'oh': (5.2, -0.17), 'oo': (3.0, -0.27), 'mbp': (-3.6, -0.03),
    'fv': (-2.2, 0.0), 'l': (3.6, 0.04), 'td': (1.8, 0.06), 'kg': (4.0, 0.0),
}
FILES = {'aa': 'mouth-a.png', 'ee': 'mouth-e-i.png', 'oh': 'mouth-o.png', 'oo': 'mouth-u.png', 'mbp': 'mouth-mbp.png', 'fv': 'mouth-fv.png', 'l': 'mouth-l.png', 'td': 'mouth-t-d-s.png', 'kg': 'mouth-k-g.png'}
for v, (J, e) in VISEMES.items():
    Image.fromarray(np.clip(mouth_shape(J, e), 0, 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, FILES[v]))
rig['mouth'] = {'box': [MX0, MY0, MX1 - MX0, MY1 - MY0], 'shapes': FILES, 'madeFrom': 'original face pixels (tools/vidya2d/face.py)'}

# ── eyelids ──
EX0, EY0, EX1, EY1 = 548, 100, 644, 140   # both eyes, brows excluded
LID = {'l': (566.0, 109.0, 128.0), 'r': (626.0, 111.5, 130.0)}  # per eye: centre x, upper lid y, lower lid y
eyes = src_crop(EX0, EY0, EX1, EY1)
EH, EW = eyes.shape[:2]
EYY, EXX = np.mgrid[0:EH, 0:EW].astype(np.float32)
EXs = EXX + EX0; EYs = EYY + EY0

def eyes_shape(b):
    """b = 0 open .. 1 closed. Per column: the lid skin above the lash stretches down, the lash band (3.5 px) moves
    down with it, and what is left of the eye squeezes into the space between the lash and the lower lid."""
    ys = EYs.copy()
    for cx, top0, low0 in LID.values():
        u = np.clip((EXs - cx) / 17.0, -1, 1)
        wid = smooth(1 - (np.abs(EXs - cx) - 16) / 5.0)
        top = top0 + 4.5 * u * u          # the almond shape: the lid is higher at the centre
        low = low0 - 3.5 * u * u
        LASH = 3.5
        target = top + (low - LASH - top) * b              # where the upper lash now starts
        s_above = EY0 + (EYs - EY0) * (top - EY0) / np.maximum(0.5, target - EY0)
        s_lash = top + (EYs - target)
        room = np.maximum(0.01, low - (target + LASH))
        s_eye = (top + LASH) + (EYs - target - LASH) * (low - top - LASH) / room
        s = np.where(EYs < target, s_above, np.where(EYs < target + LASH, s_lash, np.where(EYs < low, s_eye, EYs)))
        ys = ys + (s - EYs) * wid
    out = sample(eyes, EXs - EX0, ys - EY0)
    fx = smooth(np.minimum(EXX, EW - 1 - EXX) / 3.0); fy = smooth(np.minimum(EYY, EH - 1 - EYY) / 3.0)
    out[..., 3] = eyes[..., 3] * fx * fy
    return out

EYE_FILES = {'half': 'eyes-half.png', 'closed': 'eyes-closed.png'}
for name, b in (('half', 0.5), ('closed', 0.93)):
    Image.fromarray(np.clip(eyes_shape(b), 0, 255).astype(np.uint8), 'RGBA').save(os.path.join(OUT, EYE_FILES[name]))
rig['eyes'] = {'box': [EX0, EY0, EX1 - EX0, EY1 - EY0], 'shapes': EYE_FILES, 'madeFrom': 'original face pixels (tools/vidya2d/face.py)'}
json.dump(rig, open(os.path.join(OUT, 'rig.json'), 'w'), indent=1)
print('ok', list(FILES.values()), list(EYE_FILES.values()))
