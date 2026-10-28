import array
import tempfile
import unittest
import wave
from pathlib import Path
from tts_worker import validate_audio


class AudioValidationTest(unittest.TestCase):
    def test_empty_and_silent_wav_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "speech.wav"
            for samples in [[], [0] * 22050]:
                with wave.open(str(target), "wb") as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(22050)
                    audio.writeframes(array.array("h", samples).tobytes())
                with self.assertRaisesRegex(ValueError, "TTS_EMPTY_AUDIO"):
                    validate_audio(target)


if __name__ == "__main__":
    unittest.main()
