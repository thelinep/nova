#!/usr/bin/env python3
"""Render the Lipi OS letter sounds: one short MP3 per letter in public/lipi-sounds/.

Uses Kokoro-82M (Apache-2.0) through kokoro-onnx, offline, with a Hindi voice, reading
the IPA stored in lib/lipi-letters.json (so the sound does not depend on a spelling
guesser). Model files come from $KOKORO_DIR (default ~/kokoro), the same place
scripts/kokoro-say.py reads them. Needs ffmpeg on PATH.

Run:  python3 tools/render-lipi-letter-sounds.py [--voice hf_alpha] [--speed 0.8]
"""
import argparse, json, os, subprocess, tempfile

ROOT = os.path.join(os.path.dirname(__file__), '..')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--voice', default='hf_alpha')
    p.add_argument('--speed', type=float, default=0.8)
    a = p.parse_args()
    import soundfile as sf
    from kokoro_onnx import Kokoro
    base = os.environ.get('KOKORO_DIR') or os.path.expanduser('~/kokoro')
    k = Kokoro(os.path.join(base, 'kokoro-v1.0.onnx'), os.path.join(base, 'voices-v1.0.bin'))
    data = json.load(open(os.path.join(ROOT, 'lib', 'lipi-letters.json'), encoding='utf-8'))
    out_dir = os.path.join(ROOT, 'public', 'lipi-sounds')
    os.makedirs(out_dir, exist_ok=True)
    report = []
    with tempfile.TemporaryDirectory() as tmp:
        for l in data['letters']:
            s = l['sound']
            if not s['file']:
                continue
            samples, rate = k.create(s['ipa'], voice=a.voice, speed=a.speed, lang='hi', is_phonemes=True)
            wav = os.path.join(tmp, 'x.wav')
            sf.write(wav, samples, rate)
            mp3 = os.path.join(ROOT, 'public', s['file'].lstrip('/'))
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-af', 'adelay=60,apad=pad_dur=0.12,loudnorm=I=-18:TP=-2',
                            '-ac', '1', '-ar', '24000', '-b:a', '48k', mp3], check=True)
            report.append((l['char'], round(len(samples) / rate, 2)))
    print(json.dumps({'voice': a.voice, 'speed': a.speed, 'files': len(report), 'shortest': min(report, key=lambda r: r[1]), 'longest': max(report, key=lambda r: r[1])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
