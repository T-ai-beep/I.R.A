#!/usr/bin/env python3
import sys
import json
import subprocess
import threading
import queue
import os

REFERENCE_WAV = os.path.expanduser("~/Downloads/alfred.wav")

def try_xtts():
    try:
        from TTS.api import TTS
        import sounddevice as sd
        import numpy as np
        print("[TTS] loading XTTS-v2 model (first run downloads ~2GB)...", flush=True)
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        print("[TTS] XTTS-v2 ready — voice: Alfred", flush=True)
        return tts, sd, np
    except Exception as e:
        print(f"[TTS] XTTS unavailable ({e}), falling back to say", flush=True)
        return None, None, None

tts_model, sd, np_mod = try_xtts()
q = queue.Queue()

def speak_xtts(text: str):
    try:
        wav = tts_model.tts(
            text=text,
            speaker_wav=REFERENCE_WAV,
            language="en"
        )
        sd.play(np_mod.array(wav), samplerate=24000)
        sd.wait()
    except Exception as e:
        print(f"[TTS] XTTS error: {e}, falling back", flush=True)
        subprocess.run(['say', '-v', 'Samantha', '-r', '220', text])

def speak(text: str):
    if tts_model:
        speak_xtts(text)
    else:
        subprocess.run(['say', '-v', 'Samantha', '-r', '220', text])

def worker():
    while True:
        text = q.get()
        if text is None:
            break
        speak(text)
        q.task_done()

t = threading.Thread(target=worker, daemon=True)
t.start()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
        text = data.get("text", "")
    except:
        text = line
    if text:
        q.put(text)
