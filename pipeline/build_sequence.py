"""Extract EVERY decoded frame, then tile one chronological horizontal PNG.

Usage: python pipeline/build_sequence.py "path/to/source.mp4"
Requires ffmpeg and ffprobe on PATH. No Python packages required.
Gaze landmarks are hand calibrated for the source, not inferred from its prompt.
"""
import argparse
import hashlib
import json
import subprocess
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def run(*args):
    subprocess.run([str(a) for a in args], check=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--calibration', type=Path, default=ROOT / 'pipeline/gaze-225025.json')
    args = parser.parse_args()
    clip = args.source.resolve(strict=True)
    calibration = json.loads(args.calibration.read_text(encoding='utf-8'))
    if calibration['sourceFile'] != clip.name:
        raise ValueError('Calibration is for a different source. Supply the matching --calibration file.')
    with clip.open('rb') as source:
        source_hash = hashlib.file_digest(source, 'sha256').hexdigest()
    probe = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,duration',
        '-of', 'json', str(clip)], text=True))['streams'][0]
    count = int(probe['nb_read_frames'])
    if count != calibration['expectedFrames']:
        raise ValueError('Decoded frame count does not match source calibration.')
    # Separate output directory keeps older attempts available for comparison.
    frames = ROOT / 'build' / f'source-{source_hash[:12]}'
    assets = ROOT / 'assets'
    frames.mkdir(parents=True, exist_ok=True)
    assets.mkdir(parents=True, exist_ok=True)
    run('ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', clip,
        '-fps_mode', 'passthrough', '-start_number', '0', frames / 'frame-%04d.png')
    extracted = sorted(frames.glob('frame-*.png'))
    expected = [f'frame-{i:04d}.png' for i in range(count)]
    if [p.name for p in extracted] != expected:
        raise ValueError('Extracted frame inventory does not match decoded source; check for stale files.')
    # PNG supports this width; JPEG/WebP/AVIF cannot retain 240 detailed cells
    # in a single horizontal image at their format dimension limits.
    run('ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', probe['r_frame_rate'],
        '-start_number', '0', '-i', frames / 'frame-%04d.png',
        '-vf', f'scale=800:450:flags=lanczos,tile={count}x1:nb_frames={count}:padding=0:margin=0',
        '-frames:v', '1', '-compression_level', '6', assets / 'character-sheet.png')
    run('ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', frames / f'frame-{calibration["idleFrame"]:04d}.png',
        '-frames:v', '1', '-quality', '88', assets / 'poster.webp')
    manifest = {
        'version': 3, 'sheet': f'assets/character-sheet.png?v={source_hash[:12]}',
        'frames': count, 'fps': float(Fraction(probe['r_frame_rate'])),
        'duration': float(probe['duration']), 'idleFrame': calibration['idleFrame'],
        'idleFrames': calibration['idleFrames'],
        'extractedFrames': frames.relative_to(ROOT).as_posix(),
        'cell': {'width': 800, 'height': 450},
        'source': {'file': clip.name, 'sha256': source_hash,
                   'width': probe['width'], 'height': probe['height']},
        'order': 'chronological, zero-based, all source frames exactly once',
        'gaze': [dict(frame=f, x=x, y=y) for f, x, y in calibration['gaze']],
        'frameFiles': expected,
    }
    (assets / 'sequence.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Built {count} frames, {manifest["duration"]}s, {count * 800} x 450 pixels.')

if __name__ == '__main__':
    main()
