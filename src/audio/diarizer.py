#!/usr/bin/env python3
"""
diarizer.py — Real-time speaker diarization for ARIA
=====================================================

Identifies who is speaking: 'self' (Tanay) or 'other' (prospect/person).

Strategy:
  - Uses resemblyzer locally (no cloud, no pyannote license needed)
  - On first run, enrolls a voice profile for 'self' from a short reference clip
  - Each audio chunk is diarized + speaker-matched against the enrolled profile
  - Outputs JSON: {"speaker": "self"|"other"|"unknown", "confidence": 0.0-1.0}

Voice enrollment:
  - On startup, looks for ~/A.R.I.A/voice_profile.wav
  - If not found, first 5s of speech is used as self-enrollment (bootstrap mode)
  - Can be re-enrolled by deleting the file and restarting

Dependencies:
  pip install resemblyzer torch --break-system-packages

Usage (standalone):
  echo '{"audio_b64": "<base64 pcm>"}' | python3 diarizer.py

Usage (from Node via stdin/stdout pipe):
  Spawned by diarizer.ts, communicates via JSON lines on stdin/stdout
"""

from __future__ import annotations

import sys
import json
import os
import base64
import io
import struct
import wave
from typing import Optional

import numpy as np  # type: ignore[import-not-found]

# ── Config ─────────────────────────────────────────────────────────────────

SAMPLE_RATE          = 16000
CHANNELS             = 1
PROFILE_PATH         = os.path.expanduser("~/A.R.I.A/voice_profile.wav")
ARIA_DIR             = os.path.expanduser("~/A.R.I.A")
ENROLL_SECONDS       = 5      # seconds of speech needed for self-enrollment
MIN_CHUNK_MS         = 500    # ignore chunks shorter than this
SIMILARITY_THRESHOLD = 0.75   # cosine similarity to consider "self"

# ── Type-safe globals ──────────────────────────────────────────────────────
# encoder and self_embedding start as None and are set after load_encoder().
# All call-sites guard against None before use.

_encoder: Optional[object] = None          # resemblyzer.VoiceEncoder once loaded
_self_embedding: Optional[np.ndarray] = None
_enroll_buffer: list[bytes] = []
_enroll_duration_ms: float = 0.0
_enrolled: bool = False

# ── Model loading ──────────────────────────────────────────────────────────

def load_encoder() -> bool:
    global _encoder
    try:
        from resemblyzer import VoiceEncoder  # type: ignore[import-untyped]
        _encoder = VoiceEncoder()
        print("[DIARIZER] VoiceEncoder loaded", flush=True)
        return True
    except Exception as e:
        print(f"[DIARIZER] VoiceEncoder unavailable: {e}", flush=True)
        return False


def load_self_profile() -> bool:
    global _self_embedding, _enrolled
    if not os.path.exists(PROFILE_PATH):
        print("[DIARIZER] No voice profile found — will auto-enroll from first speech", flush=True)
        return False
    if _encoder is None:
        return False
    try:
        from resemblyzer import preprocess_wav  # type: ignore[import-untyped]
        wav = preprocess_wav(PROFILE_PATH)
        _self_embedding = _encoder.embed_utterance(wav)  # type: ignore[union-attr]
        _enrolled = True
        print("[DIARIZER] Voice profile loaded", flush=True)
        return True
    except Exception as e:
        print(f"[DIARIZER] Failed to load profile: {e}", flush=True)
        return False

# ── PCM helpers ────────────────────────────────────────────────────────────

def pcm_to_wav_bytes(pcm_bytes: bytes) -> bytes:
    """Wrap raw 16-bit PCM in a WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def duration_ms(pcm_bytes: bytes) -> float:
    return (len(pcm_bytes) / 2 / SAMPLE_RATE) * 1000

# ── Enrollment ─────────────────────────────────────────────────────────────

def try_enroll(pcm_bytes: bytes) -> bool:
    """
    Accumulate audio until we have ENROLL_SECONDS of speech,
    then save as voice profile and embed.
    Returns True when enrollment is complete.
    """
    global _enroll_buffer, _enroll_duration_ms, _self_embedding, _enrolled

    if _encoder is None:
        return False

    _enroll_buffer.append(pcm_bytes)
    _enroll_duration_ms += duration_ms(pcm_bytes)

    if _enroll_duration_ms < ENROLL_SECONDS * 1000:
        pct = int(_enroll_duration_ms / (ENROLL_SECONDS * 1000) * 100)
        print(f"[DIARIZER] Enrolling self... {pct}%", flush=True)
        return False

    # Enough audio — save and embed
    combined = b"".join(_enroll_buffer)
    os.makedirs(ARIA_DIR, exist_ok=True)

    with open(PROFILE_PATH, "wb") as f:
        f.write(pcm_to_wav_bytes(combined))

    try:
        from resemblyzer import preprocess_wav  # type: ignore[import-untyped]
        wav = preprocess_wav(PROFILE_PATH)
        _self_embedding = _encoder.embed_utterance(wav)  # type: ignore[union-attr]
        _enrolled = True
        print("[DIARIZER] Self-enrollment complete — voice profile saved", flush=True)
        return True
    except Exception as e:
        print(f"[DIARIZER] Enrollment failed: {e}", flush=True)
        return False

# ── Cosine similarity ──────────────────────────────────────────────────────

def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))

# ── Diarize a single chunk ─────────────────────────────────────────────────

def diarize_chunk(pcm_bytes: bytes) -> dict:
    """
    Returns {"speaker": "self"|"other"|"unknown", "confidence": float}
    """
    if _encoder is None:
        return {"speaker": "unknown", "confidence": 0.0, "reason": "encoder_not_loaded"}

    dur = duration_ms(pcm_bytes)
    if dur < MIN_CHUNK_MS:
        return {"speaker": "unknown", "confidence": 0.0, "reason": "chunk_too_short"}

    # Bootstrap enrollment — treat first chunks as "self"
    if not _enrolled:
        complete = try_enroll(pcm_bytes)
        if not complete:
            return {"speaker": "self", "confidence": 0.5, "reason": "enrolling"}
        return {"speaker": "self", "confidence": 0.9, "reason": "enrolled"}

    # self_embedding is guaranteed non-None here because _enrolled is True
    assert _self_embedding is not None

    # Embed the incoming chunk
    try:
        from resemblyzer import preprocess_wav  # type: ignore[import-untyped]

        wav_bytes = pcm_to_wav_bytes(pcm_bytes)
        wav = preprocess_wav(io.BytesIO(wav_bytes))

        if len(wav) < SAMPLE_RATE * 0.3:
            return {"speaker": "unknown", "confidence": 0.0, "reason": "too_short_after_preprocess"}

        chunk_embedding: np.ndarray = _encoder.embed_utterance(wav)  # type: ignore[union-attr]
        similarity = cosine_sim(chunk_embedding, _self_embedding)

        if similarity >= SIMILARITY_THRESHOLD:
            return {
                "speaker": "self",
                "confidence": round(similarity, 3),
                "reason": "similarity_match",
            }
        else:
            return {
                "speaker": "other",
                "confidence": round(1.0 - similarity, 3),
                "reason": "similarity_mismatch",
            }

    except Exception as e:
        return {"speaker": "unknown", "confidence": 0.0, "reason": str(e)}

# ── Re-enrollment command ──────────────────────────────────────────────────

def handle_reenroll() -> None:
    global _enroll_buffer, _enroll_duration_ms, _self_embedding, _enrolled
    if os.path.exists(PROFILE_PATH):
        os.remove(PROFILE_PATH)
    _enroll_buffer = []
    _enroll_duration_ms = 0.0
    _self_embedding = None
    _enrolled = False
    print("[DIARIZER] Re-enrollment triggered — speak to re-enroll", flush=True)

# ── Main loop ──────────────────────────────────────────────────────────────

def main() -> None:
    print("[DIARIZER] loading encoder...", flush=True)
    ok = load_encoder()
    if not ok:
        print("[DIARIZER] running in fallback mode (no encoder)", flush=True)
    else:
        load_self_profile()

    print("[DIARIZER] ready", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg: dict = json.loads(line)
        except Exception:
            continue

        cmd = msg.get("cmd")

        if cmd == "reenroll":
            handle_reenroll()
            print(json.dumps({"ok": True, "msg": "re-enrollment started"}), flush=True)
            continue

        if cmd == "status":
            print(json.dumps({
                "enrolled": _enrolled,
                "profile_exists": os.path.exists(PROFILE_PATH),
                "enroll_progress_pct": int(
                    min(100.0, _enroll_duration_ms / (ENROLL_SECONDS * 1000) * 100)
                ),
            }), flush=True)
            continue

        # Default: diarize audio chunk
        audio_b64: Optional[str] = msg.get("audio_b64")
        if not audio_b64:
            print(json.dumps({"speaker": "unknown", "confidence": 0.0, "reason": "no_audio"}), flush=True)
            continue

        try:
            pcm_bytes = base64.b64decode(audio_b64)
        except Exception as e:
            print(json.dumps({"speaker": "unknown", "confidence": 0.0, "reason": f"decode_error: {e}"}), flush=True)
            continue

        result = diarize_chunk(pcm_bytes)
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()