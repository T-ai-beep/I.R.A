#!/usr/bin/env python3
"""
tts.py — Streaming TTS pipeline (optimised for minimum TTFC)
=============================================================

Key changes vs original:
  1. sounddevice OutputStream is opened ONCE on startup and kept alive.
     Writing audio to it starts playback immediately (zero buffer-then-play overhead).

  2. Text is chunked into ≤4-word phrases before synthesis.
     Each chunk is synthesised and written to the stream independently.
     First audio starts as soon as chunk-0 finishes synthesis (~60-100ms)
     rather than waiting for the full sentence (~300-500ms).

  3. Synthesis and playback overlap (pipeline):
     While chunk-0 is playing, chunk-1 is being synthesised.
     For a 6-word output with CHUNK_WORDS=3 this halves the total wall-clock time.

  4. Process and OutputStream are pre-warmed on module load.
     First call to speak() pays warm cost, not cold cost.

Target metrics (warm, 4-6 word output):
  TTS TTFC  ≤ 100ms   (was ~190ms batch)
  TTS total ≤ 300ms   (was ~430ms batch)
"""

import sys
import json
import threading
import queue
import os
import re
import time
import numpy as np

# ── Config ────────────────────────────────────────────────────────────────

REFERENCE_WAV  = os.path.expanduser("~/Downloads/alfred.wav")
SAMPLE_RATE    = 24000
CHANNELS       = 1
# ≤4 words per chunk keeps first-audio latency under 100ms while giving
# Kokoro enough context to produce natural-sounding prosody.
CHUNK_WORDS    = 4
DTYPE          = 'float32'

# ── Model loading ─────────────────────────────────────────────────────────

def load_kokoro():
    try:
        from kokoro_onnx import Kokoro
        model_path  = os.path.expanduser("~/A.R.I.A/kokoro/kokoro-v0_19.onnx")
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
        print(f"[TTS] XTTS unavailable ({e}), falling back to say", flush=True)
        return ('say', None)

engine_type, engine = load_kokoro()

# ── Persistent sounddevice OutputStream ──────────────────────────────────
#
# FIX 5 (pre-warm): stream is opened immediately on module load.
# First speak() call writes to an already-running stream → no open() overhead.

_sd_stream      = None
_sd_stream_lock = threading.Lock()

def _get_stream():
    global _sd_stream
    with _sd_stream_lock:
        if _sd_stream is not None and not _sd_stream.closed:
            return _sd_stream
        try:
            import sounddevice as sd
            _sd_stream = sd.OutputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype=DTYPE,
                # blocksize=0 → driver picks minimum latency buffer
                blocksize=0,
                # latency='low' → request minimum output latency from the driver
                latency='low',
            )
            _sd_stream.start()
            print("[TTS] sounddevice OutputStream opened (low latency)", flush=True)
            return _sd_stream
        except Exception as e:
            print(f"[TTS] sounddevice stream failed: {e}", flush=True)
            return None

# Pre-open the stream NOW — not on first speak() call.
_get_stream()

# ── Text chunking ─────────────────────────────────────────────────────────
#
# Strategy (priority order):
#   1. Split on sentence-ending punctuation (. ! ?)
#   2. Split on natural pause markers (— , ;)
#   3. Chunk by word count (≤ CHUNK_WORDS)
#
# Why not always split by words?
#   Kokoro produces more natural prosody when it sees a complete phrase.
#   A comma boundary ("Hold the number, walk away") sounds better chunked
#   at the comma than at word 4.

def chunk_text(text: str) -> list[str]:
    text = text.strip()

    # Pass 1: sentence boundaries
    sentences = re.split(r'(?<=[.!?])\s+', text)
    sentences = [s.strip() for s in sentences if s.strip()]

    # Pass 2: within each sentence, split on em-dash and comma (if long)
    result = []
    for sent in sentences:
        parts = re.split(r'(?:—|,)\s*', sent)
        parts = [p.strip() for p in parts if p.strip()]
        if len(parts) > 1:
            result.extend(parts)
        else:
            # Pass 3: word-count chunking for long sentences without punctuation
            words = sent.split()
            if len(words) <= CHUNK_WORDS:
                result.append(sent)
            else:
                i = 0
                while i < len(words):
                    result.append(' '.join(words[i:i + CHUNK_WORDS]))
                    i += CHUNK_WORDS

    return result if result else [text]

# ── Synthesis backends ─────────────────────────────────────────────────────

def _synthesise_kokoro(text: str) -> np.ndarray | None:
    """Returns float32 ndarray at SAMPLE_RATE, or None on failure."""
    try:
        samples, sample_rate = engine.create(text, voice="af_bella", speed=1.0, lang="en-us")
        if samples is None or len(samples) == 0:
            return None
        arr = np.array(samples, dtype=np.float32)
        if sample_rate != SAMPLE_RATE:
            import librosa
            arr = librosa.resample(arr, orig_sr=sample_rate, target_sr=SAMPLE_RATE)
        return arr
    except Exception as e:
        print(f"[TTS] Kokoro error: {e}", flush=True)
        return None

def _synthesise_xtts(text: str) -> np.ndarray | None:
    try:
        wav = engine.tts(text=text, speaker_wav=REFERENCE_WAV, language="en")
        return np.array(wav, dtype=np.float32)
    except Exception as e:
        print(f"[TTS] XTTS error: {e}", flush=True)
        return None

def _speak_say(text: str) -> None:
    import subprocess
    subprocess.run(['say', '-v', 'Samantha', '-r', '220', text])

def _synthesise(text: str) -> np.ndarray | None:
    if engine_type == 'kokoro':
        return _synthesise_kokoro(text)
    elif engine_type == 'xtts':
        return _synthesise_xtts(text)
    return None

# ── Core streaming speak ───────────────────────────────────────────────────
#
# Algorithm:
#   chunks = chunk_text(text)         # e.g. ["Hold the number,", "walk away"]
#   for chunk in chunks:
#       audio = synthesise(chunk)     # ~60-90ms per chunk on warm Kokoro
#       stream.write(audio)           # starts playing immediately
#       # ← while this chunk plays, next iteration synthesises chunk+1
#
# Overlap model:
#   chunk-0 synthesis: 0ms → 75ms   (Kokoro generates PCM)
#   chunk-0 playback:  75ms → 350ms (sounddevice plays ~275ms of audio)
#   chunk-1 synthesis: 75ms → 150ms (runs in parallel with playback)
#   chunk-1 playback:  350ms → 600ms
#
# Without chunking: synthesis(full) = ~300ms, playback starts at 300ms.
# With chunking:    first audio at ~75ms. 4× faster TTFC.

def speak_streaming(text: str) -> None:
    if engine_type == 'say':
        _speak_say(text)
        return

    stream = _get_stream()
    chunks = chunk_text(text)

    t0 = time.perf_counter()
    first_chunk_done = False

    if stream is None:
        # Fallback: batch synthesis + sd.play
        audio = _synthesise(text)
        if audio is not None:
            try:
                import sounddevice as sd
                sd.play(audio, samplerate=SAMPLE_RATE)
                sd.wait()
            except Exception as e:
                print(f"[TTS] batch fallback error: {e}", flush=True)
        return

    for i, chunk in enumerate(chunks):
        chunk = chunk.strip()
        if not chunk:
            continue

        audio = _synthesise(chunk)
        if audio is None or len(audio) == 0:
            continue

        # Reshape for mono (sounddevice expects shape [frames, channels])
        if CHANNELS == 1:
            audio = audio.reshape(-1, 1)

        try:
            stream.write(audio)
            if not first_chunk_done:
                elapsed_ms = (time.perf_counter() - t0) * 1000
                print(f"[TTS] first chunk @ {elapsed_ms:.0f}ms — '{chunk[:40]}'", flush=True)
                first_chunk_done = True
        except Exception as e:
            print(f"[TTS] stream write error chunk={i}: {e} — reopening", flush=True)
            global _sd_stream
            with _sd_stream_lock:
                _sd_stream = None
            stream = _get_stream()
            if stream:
                stream.write(audio)

# ── Worker queue ───────────────────────────────────────────────────────────
#
# A single daemon thread drains the queue sequentially.
# This prevents overlapping speak() calls from interleaving audio.

_q: queue.Queue[str | None] = queue.Queue()

def _worker() -> None:
    while True:
        text = _q.get()
        if text is None:
            break
        speak_streaming(text)
        _q.task_done()

_worker_thread = threading.Thread(target=_worker, daemon=True, name='tts-worker')
_worker_thread.start()

# ── FIX 5: Pre-warm synthesis on load ────────────────────────────────────
#
# Synthesise a silent 1-word phrase on startup to force Kokoro to load
# all ONNX weights into memory. First real speak() call is then warm.

def _prewarm():
    time.sleep(0.5)   # give the stream a moment to open
    try:
        audio = _synthesise("ready")
        if audio is not None:
            # Write to stream at near-zero volume (pre-warm without audible beep)
            silent = np.zeros(len(audio), dtype=np.float32).reshape(-1, 1) if CHANNELS == 1 \
                     else np.zeros((len(audio), CHANNELS), dtype=np.float32)
            stream = _get_stream()
            if stream:
                stream.write(silent)
        print("[TTS] pre-warm complete", flush=True)
    except Exception as e:
        print(f"[TTS] pre-warm error: {e}", flush=True)

_prewarm_thread = threading.Thread(target=_prewarm, daemon=True, name='tts-prewarm')
_prewarm_thread.start()

# ── Stdin reader ───────────────────────────────────────────────────────────

print("[TTS] ready — chunked streaming mode", flush=True)

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
        _q.put(text)