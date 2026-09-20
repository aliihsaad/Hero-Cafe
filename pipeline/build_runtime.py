"""Losslessly split the canonical horizontal atlases into browser-sized strips.

Run after build_sequence.py and build_motion.py. Requires FFmpeg and OpenCV.
All original cells and optical-flow bytes are preserved; no frames are dropped.
"""
import hashlib
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PAGE_FRAMES = 10


def main():
    manifest = ROOT / 'assets/sequence.json'
    meta = json.loads(manifest.read_text(encoding='utf-8'))
    output = ROOT / 'assets/runtime'
    output.mkdir(parents=True, exist_ok=True)
    pages = [dict(start=i, count=min(PAGE_FRAMES, meta['frames'] - i))
             for i in range(0, meta['frames'], PAGE_FRAMES)]
    total_bytes = 0
    for kind, source, cell_width, height in [
        ('sheet', ROOT / 'assets/character-sheet.png', meta['cell']['width'], meta['cell']['height']),
        ('motion', ROOT / 'assets/character-motion.png', meta['motion']['width'], meta['motion']['height'] * 2),
    ]:
        labels = ''.join(f'[s{i}]' for i in range(len(pages)))
        filters = [f'[0:v]split={len(pages)}{labels}']
        for i, page in enumerate(pages):
            filters.append(f'[s{i}]crop={page["count"] * cell_width}:{height}:{page["start"] * cell_width}:0[o{i}]')
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1',
                   '-i', str(source), '-filter_complex_threads', '1', '-filter_complex', ';'.join(filters)]
        for i in range(len(pages)):
            command += ['-map', f'[o{i}]', '-frames:v', '1', '-threads', '1', '-compression_level', '6',
                        str(output / f'{kind}-{i:02d}.png')]
        subprocess.run(command, check=True)
        original = cv2.imread(str(source), cv2.IMREAD_UNCHANGED)
        if original is None:
            raise ValueError(f'Cannot read canonical {kind} atlas')
        for i, page in enumerate(pages):
            path = output / f'{kind}-{i:02d}.png'
            image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            x = page['start'] * cell_width
            expected = original[:, x:x + page['count'] * cell_width]
            if not np.array_equal(image, expected):
                raise ValueError(f'Pixel mismatch in {path.name}')
            digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
            page[kind] = f'assets/runtime/{path.name}?v={digest}'
            total_bytes += path.stat().st_size
        print(f'{kind}: {len(pages)} lossless strips verified', flush=True)
    meta['runtime'] = {'framesPerPage': PAGE_FRAMES, 'pages': pages}
    manifest.write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
    report = ROOT / 'output/runtime-build.json'
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({'frames': meta['frames'], 'pages': len(pages),
                                 'pixelMismatches': 0, 'bytes': total_bytes}, indent=2) + '\n')
    print(f'All {meta["frames"]} frames and flow cells preserved; {total_bytes:,} bytes.')


if __name__ == '__main__':
    main()
