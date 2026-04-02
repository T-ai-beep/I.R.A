#!/usr/bin/env python3
import sys
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(BASE, "kokoro-v1.0.int8.onnx")
VOICES = os.path.join(BASE, "voices-v1.0.bin")

import sounddevice as sd
from kokoro_onnx import Kokoro

kokoro = Kokoro(MODEL, VOICES)

def speak(text: str):
    samples, sample_rate = kokoro.create(text, voice="af_heart", speed=1.0, lang="en-us")
    sd.play(samples, sample_rate)
    sd.wait()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
        speak(data.get("text", ""))
    except:
        speak(line)