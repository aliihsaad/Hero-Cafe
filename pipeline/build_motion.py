"""Build bidirectional optical-flow data without modifying the source sprite.

Requires numpy + opencv-python. Run AFTER build_sequence.py.
Forward and backward vectors are packed losslessly as two signed 12-bit values
in RGB, with 1/32 source-cell pixel precision. No alpha-channel data loss.
"""
from pathlib import Path
import json
import time
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
W, H = 400, 225
FW, FH = 200, 112
SCALE = 32.0

def pack(flow):
    v = np.rint(flow * SCALE + 2048).clip(0, 4095).astype(np.uint16)
    rgb = np.empty((*v.shape[:2], 3), np.uint8)
    rgb[..., 0] = v[..., 0] >> 4
    rgb[..., 1] = ((v[..., 0] & 15) << 4) | (v[..., 1] >> 8)
    rgb[..., 2] = v[..., 1] & 255
    return rgb

def main():
    start = time.perf_counter()
    cv2.setNumThreads(4)
    manifest = ROOT / 'assets/sequence.json'
    meta = json.loads(manifest.read_text(encoding='utf-8'))
    frames = ROOT / meta['extractedFrames']
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(0)
    dis.setGradientDescentIterations(25)
    dis.setVariationalRefinementIterations(5)
    atlas = np.zeros((FH * 2, FW * meta['frames'], 3), np.uint8)
    atlas[:] = pack(np.zeros((1, 1, 2), np.float32))[0, 0]
    distances = [0.0]
    statistics = []
    def read(index):
        image = cv2.imread(str(frames / f'frame-{index:04d}.png'))
        if image is None:
            raise ValueError(f'Missing frame {index}')
        return cv2.cvtColor(cv2.resize(image, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    previous = read(0)
    for i in range(meta['frames'] - 1):
        following = read(i + 1)
        forward = dis.calc(previous, following, None)
        backward = dis.calc(following, previous, None)
        # Measure visible motion in the character region, excluding the still
        # backdrop. A 0.55px floor avoids rushing through holds and codec noise.
        magnitude = np.linalg.norm(forward[8:215, 140:270], axis=2) * (meta['cell']['width'] / W)
        distance = max(.55, float(np.percentile(magnitude, 90)))
        distances.append(round(distances[-1] + distance, 6))
        for direction, flow in enumerate((forward, backward)):
            small = cv2.resize(flow, (FW, FH), interpolation=cv2.INTER_AREA)
            small[..., 0] *= meta['cell']['width'] / W
            small[..., 1] *= meta['cell']['height'] / H
            atlas[direction * FH:(direction + 1) * FH, i * FW:(i + 1) * FW] = pack(small)
        statistics.append(distance)
        previous = following
        if i % 30 == 0:
            print(f'Flow {i + 1}/{meta["frames"] - 1}', flush=True)
    output = ROOT / 'assets/character-motion.png'
    cv2.imwrite(str(output), cv2.cvtColor(atlas, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    meta['motion'] = {
        'src': f'assets/character-motion.png?v={meta["source"]["sha256"][:12]}', 'width': FW, 'height': FH,
        'directions': ['forward', 'backward'], 'packing': 'xy12-rgb',
        'zero': 2048, 'scale': SCALE, 'distance': distances,
    }
    manifest.write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
    report = {'pairs': meta['frames'] - 1, 'totalDistance': distances[-1],
              'medianStep': float(np.median(statistics)), 'maxStep': max(statistics),
              'bytes': output.stat().st_size, 'seconds': time.perf_counter() - start}
    report_dir = ROOT / 'output'
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / 'motion-build.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    main()
