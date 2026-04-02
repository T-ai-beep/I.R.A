export const CONFIG = {
  // Paths
  WHISPER_CLI: '/Users/tanayshah/A.R.I.A/whisper.cpp/build/bin/whisper-cli',
  WHISPER_MODEL: '/Users/tanayshah/A.R.I.A/whisper.cpp/models/ggml-small.en.bin',
  VENV_PYTHON: '/Users/tanayshah/A.R.I.A/.venv/bin/python3',

  // Audio
  SAMPLE_RATE: 16000,
  CHANNELS: 1,
  VAD_THRESHOLD: 0.015,     // RMS energy to detect speech
  SILENCE_MS: 800,           // silence before segment ends
  MIN_SPEECH_MS: 200,        // ignore clips shorter than this
  PRE_SPEECH_PAD_MS: 200,   // include audio before speech starts

  // Pipeline
  MAX_OUTPUT_WORDS: 5,
  CONFIDENCE_THRESHOLD: 0.7,
  LATENCY_BUDGET_MS: 300,

  // LLM
  OLLAMA_URL: 'http://localhost:11434/api/chat',
  OLLAMA_MODEL: 'llama3.2',
} as const