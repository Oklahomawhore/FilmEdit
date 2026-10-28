"""Model workers emit JSON only. Models are provisioned separately, never downloaded inside jobs."""
import json
import math
import os
import sys
from pathlib import Path

# Must precede any indirect ONNX Runtime import (Whisper VAD/rembg). Disabling
# events after import is too late to prevent the initial 1DS uploader and its teardown.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"


def speech_words(segments):
    """Separate decoder tokens with no audible interval; never invent word times."""
    transcript, unaligned = [], []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if not text:
                continue
            if not (math.isfinite(word.start) and math.isfinite(word.end)
                    and 0 <= word.start <= word.end):
                raise ValueError("ASR returned invalid word timestamps")
            if word.start == word.end:
                unaligned.append({"time": word.start, "text": text})
            else:
                transcript.append({"start": word.start, "end": word.end, "text": text})
    return {"transcript": transcript, "unalignedWords": unaligned}


def main():
    action, source = sys.argv[1:3]
    if action == "asr":
        from faster_whisper import WhisperModel
        root = Path(os.environ["FILMEDIT_MODEL_DIR"]) / "whisper"
        if not root.is_dir():
            raise RuntimeError("Run the documented model provisioning before ASR")
        model = WhisperModel(str(root), device="cpu", compute_type="int8", local_files_only=True)
        segments, _ = model.transcribe(source, beam_size=5, word_timestamps=True, vad_filter=True)
        result = speech_words(segments)
    elif action == "beats":
        import librosa
        samples, rate = librosa.load(source, sr=None)
        _, frames = librosa.beat.beat_track(y=samples, sr=rate)
        result = librosa.frames_to_time(frames, sr=rate).tolist()
    elif action == "sound":
        from sound_analysis import analyze_sound
        from faster_whisper import WhisperModel
        root = Path(os.environ["FILMEDIT_MODEL_DIR"])
        result = analyze_sound(source, root)
        recognizer = WhisperModel(str(root / "whisper"), device="cpu", compute_type="int8", local_files_only=True)
        segments, _ = recognizer.transcribe(source, beam_size=5, word_timestamps=True, vad_filter=True)
        result.update(speech_words(segments))
    elif action == "matte":
        from rembg import remove, new_session
        os.environ["U2NET_HOME"] = str(Path(os.environ["FILMEDIT_MODEL_DIR"]) / "matte")
        # The session is provisioned in advance; offline operation must not fetch a model.
        model = Path(os.environ["U2NET_HOME"]) / "u2net.onnx"
        if not model.is_file():
            raise RuntimeError("Missing local u2net.onnx")
        frames = sorted(Path(source).glob("source-*.png"))
        if not frames:
            raise RuntimeError("No source frames to segment")
        session = new_session("u2net", providers=["CPUExecutionProvider"])
        for frame in frames:
            output = frame.with_name(frame.name.replace("source-", "alpha-", 1))
            output.write_bytes(remove(frame.read_bytes(), session=session))
        result = {"directory": source, "frames": len(frames)}
    else:
        raise ValueError("Unknown analysis operation")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
