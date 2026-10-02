#!/usr/bin/env python3
"""NOVA voice helper: Kokoro-82M text to speech with kokoro-onnx, offline.

Usage:
  kokoro-say.py --list
  kokoro-say.py --text-file in.txt --voice af_heart --lang en-us --speed 1.0 --out out.wav
  kokoro-say.py --text-file in.txt --mix af_heart:0.7,bf_emma:0.3 --lang en-us --out out.wav

--mix blends voices by weight into a new voice (Voice Studio characters).
--batch jobs.json reads [{"text","voice"|"mix","speed","lang","out"}, …] and
renders them all with one model load (a character line with several moods).

The model files (kokoro-v1.0.onnx, voices-v1.0.bin) are read from
$KOKORO_DIR (default ~/kokoro). Prints JSON on stdout.
"""
import argparse, json, os, sys

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--list', action='store_true')
    p.add_argument('--text-file')
    p.add_argument('--voice', default='af_heart')
    p.add_argument('--mix', help='voice:weight,voice:weight blends voices')
    p.add_argument('--batch', help='JSON file with several lines to render')
    p.add_argument('--lang', default='en-us')
    p.add_argument('--speed', type=float, default=1.0)
    p.add_argument('--out')
    a = p.parse_args()
    base = os.environ.get('KOKORO_DIR') or os.path.expanduser('~/kokoro')
    model, voices = os.path.join(base, 'kokoro-v1.0.onnx'), os.path.join(base, 'voices-v1.0.bin')
    if not (os.path.exists(model) and os.path.exists(voices)):
        print(json.dumps({'error': 'Kokoro model files are missing in ' + base}))
        return 2
    from kokoro_onnx import Kokoro
    k = Kokoro(model, voices)
    if a.list:
        print(json.dumps({'voices': sorted(k.get_voices())}))
        return 0
    import soundfile as sf

    def style(voice, mix):
        if not mix:
            return voice
        parts = []
        for item in mix.split(','):
            name, _, weight = item.partition(':')
            w = float(weight or 1)
            if w > 0: parts.append((name.strip(), w))
        if not parts:
            raise ValueError('The voice mix is empty')
        total = sum(w for _, w in parts)
        return sum(k.get_voice_style(n) * (w / total) for n, w in parts)

    if a.batch:
        jobs = json.load(open(a.batch, encoding='utf-8'))
        done = []
        for j in jobs:
            samples, rate = k.create(j['text'], voice=style(j.get('voice', 'af_heart'), j.get('mix')), speed=max(0.5, min(2.0, float(j.get('speed', 1)))), lang=j.get('lang', 'en-us'))
            sf.write(j['out'], samples, rate)
            done.append(round(len(samples) / rate, 2))
        print(json.dumps({'ok': True, 'seconds': done}))
        return 0
    text = open(a.text_file, encoding='utf-8').read().strip()
    samples, rate = k.create(text, voice=style(a.voice, a.mix), speed=max(0.5, min(2.0, a.speed)), lang=a.lang)
    sf.write(a.out, samples, rate)
    print(json.dumps({'ok': True, 'seconds': round(len(samples) / rate, 2), 'rate': rate}))
    return 0

if __name__ == '__main__':
    sys.exit(main())
