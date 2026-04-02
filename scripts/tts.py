#!/usr/bin/env python3
import sys
import json
import subprocess

def speak(text: str):
    subprocess.run(['say', '-v', 'Samantha', '-r', '220', text])

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
        speak(data.get("text", ""))
    except:
        speak(line)