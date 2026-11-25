"""Cuts Vidya into layers from the supplied image without changing any of its pixels.
    python apps/tutor-demo/tools/vidya2d/cutout.py "<path to Indian Woman in Traditional Attire Pose.png>"
Layers keep the image's own size and coordinates. Colours are copied unchanged; only transparency is added:
the background becomes transparent, and each pixel belongs to exactly one layer, except a small skin extension hidden
under each cuff (marked in the report) so a bent forearm never shows a gap.
Writes apps/tutor-demo/public/vidya2d/*.png and rig.json."""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'vidya2d')
os.makedirs(OUT, exist_ok=True)
img = Image.open(SRC).convert('RGB')
W, H = img.size
px = np.asarray(img).astype(np.int16)

# ---- background: connected to the border and close to the paper colour ----
bg_ref = np.median(np.concatenate([px[:20].reshape(-1, 3), px[-20:].reshape(-1, 3), px[:, :20].reshape(-1, 3), px[:, -20:].reshape(-1, 3)]), axis=0)
dist = np.sqrt(((px - bg_ref) ** 2).sum(-1)).astype(np.float32)
near = dist < 16
seed = np.zeros((H, W), bool); seed[0, :] = seed[-1, :] = seed[:, 0] = seed[:, -1] = True
bg = seed & near
while True:  # flood fill through near-background pixels
    grow = bg.copy()
    grow[1:] |= bg[:-1]; grow[:-1] |= bg[1:]; grow[:, 1:] |= bg[:, :-1]; grow[:, :-1] |= bg[:, 1:]
    grow &= near
    if (grow == bg).all(): break
    bg = grow
# soft edge: pixels next to the background fade by how close they are to it (colour itself is never changed)
edge = np.asarray(Image.fromarray(np.uint8(bg * 255)).filter(ImageFilter.MaxFilter(5))) > 0
alpha = np.where(bg, 0, 255).astype(np.float32)
ramp = np.clip((dist - 10) / 34, 0, 1) * 255
soft = edge & ~bg
alpha[soft] = np.maximum(alpha[soft] * 0 + ramp[soft], 0)
alpha = np.uint8(alpha)

# ---- regions (image coordinates measured on the supplied artwork) ----
def mask(draw_fn):
    m = Image.new('L', (W, H), 0); draw_fn(ImageDraw.Draw(m)); return np.asarray(m) > 0
SHOULDER_L, SHOULDER_R = (473, 279), (723, 284)   # rotation centres inside each shoulder
ELBOW_L, ELBOW_R = (296, 280), (899, 285)         # inside each cuff opening
CAP = 27                                           # the sleeve's own shoulder stays on the body as a round cap
armL = mask(lambda d: d.polygon([(0, 200), (478, 200), (478, 352), (0, 352)], fill=255))
armR = mask(lambda d: d.polygon([(714, 200), (W, 200), (W, 360), (714, 360)], fill=255))
capL = mask(lambda d: d.ellipse([SHOULDER_L[0] - CAP, SHOULDER_L[1] - CAP, SHOULDER_L[0] + CAP, SHOULDER_L[1] + CAP], fill=255))
capR = mask(lambda d: d.ellipse([SHOULDER_R[0] - CAP, SHOULDER_R[1] - CAP, SHOULDER_R[0] + CAP, SHOULDER_R[1] + CAP], fill=255))
foreL = armL & (np.arange(W)[None, :] < 291)
foreR = armR & (np.arange(W)[None, :] > 905)
upperL, upperR = armL & ~foreL, armR & ~foreR
body = ~(armL | armR) | capL | capR

def layer(region, name, extend=None):
    a = np.where(region, alpha, 0).astype(np.uint8)
    rgb = np.asarray(img).copy()
    hidden = 0
    if extend:  # skin continuing under the cuff: copied from the forearm's first visible column, drawn beneath the sleeve
        x0, x1, step = extend
        src_col = x0
        for x in range(x0 + step, x1 + step, step):
            col_a = a[:, src_col]
            put = (col_a > 200) & (a[:, x] == 0) & (alpha[:, x] == 255)  # only where the opaque cuff will cover it
            rgb[put, x] = rgb[put, src_col]; a[put, x] = 255; hidden += int(put.sum())
    out = np.dstack([rgb, a])
    ys, xs = np.nonzero(a)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    Image.fromarray(out, 'RGBA').crop(box).save(os.path.join(OUT, f'{name}.png'), optimize=True)
    return {'file': f'{name}.png', 'x': box[0], 'y': box[1], 'w': box[2] - box[0], 'h': box[3] - box[1], 'hiddenFill': hidden}

layers = {
    'body': layer(body, 'body'),
    'upperL': layer(upperL & ~capL, 'upper-left'), 'upperR': layer(upperR & ~capR, 'upper-right'),
    'foreL': layer(foreL, 'fore-left', (290, 312, 1)), 'foreR': layer(foreR, 'fore-right', (906, 884, -1)),
}
# a full upper arm (including the part under the cap) is what actually rotates; the cap stays still on top
layers['upperL'] = layer(upperL, 'upper-left'); layers['upperR'] = layer(upperR, 'upper-right')
rig = {'source': os.path.basename(SRC), 'size': [W, H], 'layers': layers,
       'pivots': {'shoulderL': SHOULDER_L, 'shoulderR': SHOULDER_R, 'elbowL': ELBOW_L, 'elbowR': ELBOW_R},
       'fingertips': {'left': [36, 276], 'right': [1163, 276]}, 'cap': CAP,
       'figure': {'top': int(np.nonzero(alpha.max(1))[0].min()), 'bottom': int(np.nonzero(alpha.max(1))[0].max()), 'centerX': 600}}
json.dump(rig, open(os.path.join(OUT, 'rig.json'), 'w'), indent=1)

# ---- proof: the layers in the original pose rebuild the original image ----
canvas = np.zeros((H, W, 4), np.float32)
def over(name):
    L = layers[name]; im = np.asarray(Image.open(os.path.join(OUT, L['file']))).astype(np.float32)
    region = canvas[L['y']:L['y'] + L['h'], L['x']:L['x'] + L['w']]
    a = im[..., 3:4] / 255
    region[..., :3] = im[..., :3] * a + region[..., :3] * (1 - a)
    region[..., 3:4] = a * 255 + region[..., 3:4] * (1 - a)
for n in ['foreL', 'foreR', 'upperL', 'upperR', 'body']: over(n)
solid = canvas[..., 3] > 254.5
diff = np.abs(canvas[..., :3] - np.asarray(img).astype(np.float32)).max(-1)
print(json.dumps({'opaqueCharacterPixels': int(solid.sum()), 'maxDifferenceOnOpaquePixels': float(diff[solid].max()), 'pixelsChanged': int((diff[solid] > 0).sum()),
                  'layers': {k: (v['w'], v['h'], v['hiddenFill']) for k, v in layers.items()}, 'files': {f: os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)}}))
