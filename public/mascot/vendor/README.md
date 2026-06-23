# Mascot Live2D runtime (vendored)

The mascot's `live2d` renderer loads its runtime from this folder. The files are
**not** committed by default — fetch them with:

```bash
npm run fetch:mascot-runtime
```

That script downloads the **MIT-licensed** pieces:

| File | Source | License |
|------|--------|---------|
| `pixi.min.js` | PixiJS v6 | MIT |
| `pixi-live2d-display.min.js` | pixi-live2d-display (cubism4 bundle) | MIT |

## Live2D Cubism Core (you must supply this)

`live2dcubismcore.min.js` is **proprietary** (Live2D Cubism Core License Agreement)
and is **not** downloaded automatically. To enable Live2D characters:

1. Obtain `live2dcubismcore.min.js` from Live2D, agreeing to their license.
2. Place it here as `public/mascot/vendor/live2dcubismcore.min.js`.

Until it is present, Live2D character packs fall back gracefully to the built-in
placeholder character.

## Models

This product ships the **engine**, not third-party Live2D models. Download free
models from the Live2D / VTuber ecosystem (mind each model's license), then import
them on the dashboard's **Desktop Mascot** page (or drop a pack folder into
`~/.cligate/mascot-characters/<id>/` with a `character.json`).
