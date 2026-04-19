import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export const CONFIG = {
  // Paths — override via env vars or fall back to project-relative defaults
  WHISPER_CLI:   process.env.WHISPER_CLI   ?? path.join(ROOT, 'whisper.cpp/build/bin/whisper-cli'),
  WHISPER_MODEL: process.env.WHISPER_MODEL ?? path.join(ROOT, 'whisper.cpp/models/ggml-tiny.en.bin'),
  VENV_PYTHON:   process.env.VENV_PYTHON   ?? path.join(ROOT, '.venv/bin/python3'),

  // Audio
  SAMPLE_RATE: 16000,
  CHANNELS: 1,
  VAD_THRESHOLD: 0.015,
  SILENCE_MS: 500,
  MIN_SPEECH_MS: 150,
  PRE_SPEECH_PAD_MS: 200,

  // Pipeline
  MAX_OUTPUT_WORDS: 7,
  CONFIDENCE_THRESHOLD: 0.7,
  LATENCY_BUDGET_MS: 300,

  // LLM (disabled for now)
  OLLAMA_URL: 'http://localhost:11434/api/chat',
  OLLAMA_MODEL: 'llama3.2',
} as const
