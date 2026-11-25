# Vidya 2D: face shapes and the artwork still needed

## Made from the original image (done)
`python tools/vidya2d/face.py` builds, from her own face pixels by a smooth warp (no repainting except the inside of an
opened mouth, coloured from her own lip line):
- 9 mouth shapes: `mouth-a`, `mouth-e-i`, `mouth-o`, `mouth-u`, `mouth-mbp`, `mouth-fv`, `mouth-l`, `mouth-t-d-s`,
  `mouth-k-g` (silence = her original mouth). The jaw opens below the lip line, which follows her smile; the corners and
  the chin outline stay where the artist drew them.
- 2 eyelid shapes for blinks: `eyes-half`, `eyes-closed`.
The boxes are in `rig.json` (`mouth`, `eyes`). Re-run the script if the source image changes.

## Still needs the original artist (cannot be made from the image)
1. **A palm-facing hand for the greeting wave**: `fore-right-wave.png`, the right forearm raised with the palm facing
   the viewer, fingers together, same cuff edge as `fore-right.png`, plus its wrist point. The image's hands are seen
   side-on, palm down; raising that hand shows its edge and reads as a blessing, so the greeting currently uses relaxed
   arms, a lean towards the student, a nod and her smile.
2. **Head layer** (`head.png` + `neck-under.png`) for a real head nod/tilt and looking at the board; today the whole
   figure nods slightly.
3. **Counting and pointing hands** (`fore-right-point.png`, `fore-right-1/2/3.png`); today steps are shown by distinct
   arm heights.

All files: transparent PNG at the source resolution (1199 × 1312), same lighting, line weight and colours.
