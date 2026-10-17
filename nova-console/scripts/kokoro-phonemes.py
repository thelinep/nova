#!/usr/bin/env python3
"""Prints the phonemes Kokoro would speak for a text, for Character Studio lip-sync.
   echo '{"text": "Hello", "lang": "en-us"}' | python kokoro-phonemes.py
"""
import json, sys
from kokoro_onnx.tokenizer import Tokenizer

job = json.load(sys.stdin)
text = str(job.get('text', ''))[:4000]
lang = str(job.get('lang', 'en-us'))
print(json.dumps({'phonemes': Tokenizer().phonemize(text, lang)}, ensure_ascii=False))
