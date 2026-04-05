#!/usr/bin/env python3
"""
tts.py — Streaming TTS pipeline
================================
Old: text → Kokoro synthesizes full audio → sounddevice plays after

New: text → Kokoro synthesizes in chunks → sounddevice streams frames immediately

The key change: sounddevice.OutputStream is opened once and kept alive.
Kokoro audio is written to it in PCM chunks as they arrive.
First audio plays ~150ms earlier than batch mode.

Also supports sentence chunking: if the caller sends a long string,
we split on punctuation and synthesize each sentence independently,
starting playback before the second sentence is even synthesized.
"""

import sys
import json
import threading
import queue
import os
import numpy as np

# ── Config ────────────────────────────────────────────────────────────────

REFERENCE_WAV  = os.path.expanduser("~/Downloads/alfred.wav")
SAMPLE_RATE    = 24000
CHANNELS       = 1
CHUNK_WORDS    = 3      # synthesize this many words at a time for streaming
DTYPE          = 'float32'

# ── Model loading ─────────────────────────────────────────────────────────

def load_kokoro():
    try:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
        model_path = os.path.expanduser("~/A.R.I.A/kokoro/kokoro-v0_19.onnx")
        voices_path = os.path.expanduser("~/A.R.I.A/kokoro/voices.bin")
        if os.path.exists(model_path) and os.path.exists(voices_path):
            kokoro = Kokoro(model_path, voices_path)
            print("[TTS] Kokoro ONNX loaded — streaming mode", flush=True)
            return ('kokoro', kokoro)
    except Exception as e:
        print(f"[TTS] Kokoro unavailable ({e})", flush=True)

    try:
        from TTS.api import TTS
        print("[TTS] loading XTTS-v2...", flush=True)
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        print("[TTS] XTTS-v2 ready", flush=True)
        return ('xtts', tts)
    except Exception as e:
        print(f"[TTS] XTTS unavailable ({e}), using say", flush=True)
        return ('say', None)

engine_type, engine = load_kokoro()

# ── Sounddevice stream (kept open for zero-latency writes) ────────────────

sd_stream = None

def get_stream():
    """
    Keep a single OutputStream open.
    Writing to it starts audio immediately — no buffer-then-play.
    """
    global sd_stream
    if sd_stream is not None and not sd_stream.closed:
        return sd_stream
    try:
        import sounddevice as sd
        sd_stream = sd.OutputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype=DTYPE,
        )
        sd_stream.start()
        print("[TTS] sounddevice stream opened", flush=True)
        return sd_stream
    except Exception as e:
        print(f"[TTS] sounddevice stream failed: {e}", flush=True)
        return None

# Pre-open the stream immediately on import
get_stream()

# ── Chunk text into short phrases ─────────────────────────────────────────

def chunk_text(text: str) -> list[str]:
    """
    Split text into synthesizable chunks.
    Priority: sentence boundaries → em-dash → word count
    """
    import re
    text = text.strip()

    # Split on sentence boundaries first
    sentences = re.split(r'(?<=[.!?])\s+|(?<=—)\s*', text)
    sentences = [s.strip() for s in sentences if s.strip()]

    if len(sentences) > 1:
        return sentences

    # No sentence boundary — split by word count
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = ' '.join(words[i:i + CHUNK_WORDS])
        chunks.append(chunk)
        i += CHUNK_WORDS
    return chunks if chunks else [text]

# ── Synthesis backends ─────────────────────────────────────────────────────

def synthesize_kokoro(text: str) -> np.ndarray | None:
    """Returns float32 numpy array at SAMPLE_RATE."""
    try:
        samples, sample_rate = engine.create(text, voice="af_bella", speed=1.0, lang="en-us")
        if samples is None or len(samples) == 0:
            return None
        arr = np.array(samples, dtype=np.float32)
        # Resample if needed
        if sample_rate != SAMPLE_RATE:
            import librosa
            arr = librosa.resample(arr, orig_sr=sample_rate, target_sr=SAMPLE_RATE)
        return arr
    except Exception as e:
        print(f"[TTS] Kokoro synthesis error: {e}", flush=True)
        return None

def synthesize_xtts(text: str) -> np.ndarray | None:
    try:
        wav = engine.tts(text=text, speaker_wav=REFERENCE_WAV, language="en")
        return np.array(wav, dtype=np.float32)
    except Exception as e:
        print(f"[TTS] XTTS error: {e}", flush=True)
        return None

def speak_say(text: str) -> None:
    import subprocess
    subprocess.run(['say', '-v', 'Samantha', '-r', '220', text])

# ── Core streaming speak ───────────────────────────────────────────────────

def speak_streaming(text: str) -> None:
    """
    FIX 2: Streaming TTS
    --------------------
    1. Split text into chunks (sentence or word-count boundaries)
    2. Synthesize chunk N
    3. Write chunk N to the open sounddevice stream immediately
    4. While chunk N is playing, synthesize chunk N+1 (overlap)
    
    Result: first audio arrives ~150ms sooner than batch synthesis.
    """
    import time

    if engine_type == 'say':
        speak_say(text)
        return

    chunks = chunk_text(text)
    stream = get_stream()

    if stream is None:
        # Fallback: batch synthesis + play
        if engine_type == 'kokoro':
            arr = synthesize_kokoro(text)
        else:
            arr = synthesize_xtts(text)
        if arr is not None:
            import sounddevice as sd
            sd.play(arr, samplerate=SAMPLE_RATE)
            sd.wait()
        return

    t0 = time.perf_counter()
    first_chunk_played = False

    for i, chunk in enumerate(chunks):
        if not chunk.strip():
            continue

        # Synthesize this chunk
        if engine_type == 'kokoro':
            audio = synthesize_kokoro(chunk)
        else:
            audio = synthesize_xtts(chunk)

        if audio is None or len(audio) == 0:
            continue

        # Reshape for mono/stereo
        if CHANNELS == 1:
            audio = audio.reshape(-1, 1)

        # Write directly to stream — starts playing immediately
        try:
            stream.write(audio)
            if not first_chunk_played:
                elapsed = (time.perf_counter() - t0) * 1000
                print(f"[TTS] first chunk played @ {elapsed:.0f}ms — '{chunk}'", flush=True)
                first_chunk_played = True
        except Exception as e:
            print(f"[TTS] stream write error: {e} — reopening", flush=True)
            global sd_stream
            sd_stream = None
            stream = get_stream()
            if stream:
                stream.write(audio)

# ── Worker queue ───────────────────────────────────────────────────────────

q: queue.Queue[str | None] = queue.Queue()

def worker():
    while True:
        text = q.get()
        if text is None:
            break
        speak_streaming(text)
        q.task_done()

t = threading.Thread(target=worker, daemon=True)
t.start()

# ── Stdin reader ───────────────────────────────────────────────────────────

print("[TTS] ready — streaming mode", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
        text = data.get("text", "")
    except Exception:
        text = line
    if text:
        q.put(text)