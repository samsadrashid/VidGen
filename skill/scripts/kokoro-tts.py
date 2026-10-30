#!/usr/bin/env python3
"""Local neural TTS for VidGen (Kokoro-82M via kokoro-onnx). No network.
Usage: kokoro-tts.py --model M --voices V --voice af_heart --speed 1.0 --lang en-us --out file.wav -- "text"
       kokoro-tts.py --model M --voices V --list
Exit 0 on success; non-zero with a message on stderr otherwise."""
import argparse
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--voices", required=True)
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default="en-us")
    ap.add_argument("--out")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("text", nargs="*")
    a = ap.parse_args()
    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
    except ImportError as e:
        print(f"kokoro-onnx not installed: {e}", file=sys.stderr)
        return 3
    k = Kokoro(a.model, a.voices)
    if a.list:
        print("\n".join(sorted(k.get_voices())))
        return 0
    if a.voice not in k.get_voices():
        print(f'voice "{a.voice}" is not a Kokoro voice', file=sys.stderr)
        return 4
    text = " ".join(a.text).strip()
    if not text or not a.out:
        print("need --out and text", file=sys.stderr)
        return 2
    samples, rate = k.create(text, voice=a.voice, speed=a.speed, lang=a.lang)
    sf.write(a.out, samples, rate)
    return 0


if __name__ == "__main__":
    sys.exit(main())
