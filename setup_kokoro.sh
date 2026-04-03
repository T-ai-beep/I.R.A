#!/bin/bash
set -e

VENV="/Users/tanayshah/A.R.I.A/.venv"
KB_DIR="$HOME/.aria/knowledge"

echo "=== Installing Kokoro TTS ==="
"$VENV/bin/pip" install "kokoro>=0.9.4" sounddevice

echo ""
echo "=== Creating ARIA data dirs ==="
mkdir -p "$KB_DIR"
echo "Knowledge base dir: $KB_DIR"

echo ""
echo "=== Kokoro voice test ==="
"$VENV/bin/python3" - <<'PYEOF'
from kokoro import KPipeline
import sounddevice as sd
import numpy as np
p = KPipeline(lang_code='a')
gen = p('ARIA online.', voice='am_adam', speed=1.05)
for _, _, audio in gen:
    sd.play(np.array(audio), samplerate=24000)
    sd.wait()
print('Voice OK')
PYEOF

echo "=== Done ==="