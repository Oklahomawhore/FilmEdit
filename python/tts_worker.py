"""Offline Piper CPU synthesis. Accept only local model/input/output paths."""
import array
import json
import math
import os
import sys
import wave
from pathlib import Path

# ONNX Runtime can enqueue an initialization upload before its Python API is called.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"


def validate_audio(output):
    with wave.open(str(output), "rb") as audio:
        if audio.getsampwidth() != 2 or audio.getnframes() <= 0:
            raise ValueError("TTS_EMPTY_AUDIO: missing PCM samples")
        duration = audio.getnframes() / audio.getframerate()
        samples = array.array("h", audio.readframes(audio.getnframes()))
        if sys.byteorder != "little":
            samples.byteswap()
    rms = math.sqrt(sum((value / 32768) ** 2 for value in samples) / len(samples))
    if not math.isfinite(rms) or rms < 0.0001:
        raise ValueError("TTS_EMPTY_AUDIO: silent audio")
    return {"duration": duration, "rms": rms}


def main():
    from piper import PiperVoice, SynthesisConfig
    import onnxruntime

    model, input_file, output = map(Path, sys.argv[1:4])
    if not model.is_file() or not Path(str(model) + ".json").is_file():
        raise ValueError("TTS_MODEL_REQUIRED: provision a local Piper voice first")
    data = json.loads(input_file.read_text())
    text = data["text"]
    speed = float(data.get("speed", 1))
    if not isinstance(text, str) or not text.strip() or not math.isfinite(speed) or speed <= 0:
        raise ValueError("Invalid local TTS text or speed")
    onnxruntime.set_seed(0)
    onnxruntime.disable_telemetry_events()
    voice = PiperVoice.load(str(model), use_cuda=False)
    with wave.open(str(output), "wb") as audio:
        voice.synthesize_wav(text, audio, syn_config=SynthesisConfig(length_scale=1 / speed))
    print(json.dumps(validate_audio(output)))


if __name__ == "__main__":
    main()
