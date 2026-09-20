# Animation asset pipeline

The committed assets are ready to serve. Run this pipeline only when rebuilding or replacing the source animation.

## Requirements

- Python 3.11 or later.
- `ffmpeg` and `ffprobe` available on PATH.
- `python -m pip install -r pipeline/requirements.txt` for the optical-flow stage.

Run from the repository root:

```sh
python pipeline/build_sequence.py "Character_looking_around_animation_1080p_20260919225025.mp4"
python pipeline/build_motion.py
python pipeline/build_runtime.py
```

## Extraction and sheet assembly

`build_sequence.py` hashes and probes the source, verifies its calibration filename and frame count, and uses FFmpeg with `-fps_mode passthrough` to extract every decoded frame. Full-resolution frames remain in `build/source-<hash>/frame-0000.png`, onward.

FFmpeg then scales each complete image to 800 × 450 and assembles the chronological sheet with `tile=240x1` for the included clip. The output includes every source frame exactly once. `assets/poster.webp` is the calibrated startup neutral frame, and `assets/sequence.json` records the source identity, frame inventory, dimensions, and gaze map.

## Gaze calibration

`gaze-225025.json` describes the actual recorded poses, not the original generation prompt:

- `sourceFile`: exact input filename.
- `expectedFrames`: expected decoded count.
- `idleFrame`: startup neutral pose.
- `idleFrames`: other recorded neutral passes suitable for nearby returns.
- `gaze`: chronological `[frame, x, y]` landmarks. Negative X is left, positive X is right; negative Y is up and positive Y is down. Directional values use the range −1 to 1.

Inspect the replacement clip and create its own calibration before building:

```sh
python pipeline/build_sequence.py "replacement.mp4" --calibration pipeline/replacement-gaze.json
python pipeline/build_motion.py
python pipeline/build_runtime.py
```

Keep source frames chronological. The runtime favors nearby candidates when the film contains multiple similar poses. Desktop's side-row adjustment is an additional clip-specific tuning parameter in `hero.js`, so review it when changing the source.

## Motion interpolation data

`build_motion.py` reads the extracted frames and calculates forward and backward OpenCV DIS optical flow for each adjacent pair. It packs vectors as signed 12-bit X/Y values into RGB, with 1/32 source-cell-pixel precision. The final atlas cell contains zero motion because replay does not wrap.

Outputs:

- `assets/character-motion.png`: both flow directions in one auxiliary atlas.
- `assets/sequence.json`: flow format and cumulative visual-motion distances.
- `output/motion-build.json`: local build statistics, excluded from Git.

Run extraction before motion generation. The motion stage relies on the exact extracted-frame folder identified by the manifest. These intermediate PNGs can occupy substantial disk space; they are excluded from the repository.

After rebuilding, serve the page and check replay, the neutral pose, both side directions, and touch behavior. Refresh any versioned manifest/script URLs used by a caching deployment.

## Browser-sized runtime strips

`build_runtime.py` is the final required stage for the current browser loader. It uses FFmpeg to losslessly crop the canonical sheet and vector atlas into ten-frame horizontal strips, then compares every output pixel with its original using OpenCV. It writes `assets/runtime/`, adds a `runtime` page inventory to the manifest, and records verification in `output/runtime-build.json`.

All 240 source cells remain present at 800 × 450, in their original order. Each vector strip preserves both directions, including the motion from its last frame to the following page's first frame. The browser's four-page cache avoids decoding the entire 192,000px canonical image. The canonical atlases remain in Git for reproducibility, but `.vercelignore` excludes them from the deployed site.
