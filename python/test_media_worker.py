import math
import unittest
from types import SimpleNamespace
from media_worker import speech_words


def segment(*words):
    return SimpleNamespace(words=[SimpleNamespace(start=s, end=e, word=t) for s, e, t in words])


class SpeechAlignmentTest(unittest.TestCase):
    def test_zero_length_tokens_keep_uncertainty_without_fabricating_audio(self):
        result = speech_words([segment((0, 0, "在"), (0, .18, "細"), (.18, .36, "節"), (.36, .36, "。"))])
        self.assertEqual(result["transcript"], [
            {"start": 0, "end": .18, "text": "細"}, {"start": .18, "end": .36, "text": "節"}])
        self.assertEqual(result["unalignedWords"], [{"time": 0, "text": "在"}, {"time": .36, "text": "。"}])

    def test_only_unaligned_words_do_not_become_a_valid_transcript(self):
        result = speech_words([segment((0, 0, "word"), (1, 1, "next"))])
        self.assertEqual(result["transcript"], [])
        self.assertEqual(len(result["unalignedWords"]), 2)
        self.assertEqual(speech_words([]), {"transcript": [], "unalignedWords": []})

    def test_invalid_timestamps_still_fail(self):
        for start, end in [(-1, 1), (1, 0), (0, math.nan), (0, math.inf)]:
            with self.assertRaises(ValueError):
                speech_words([segment((start, end, "invalid"))])


if __name__ == '__main__':
    unittest.main()
