import unittest
from sound_analysis import sound_windows


class SoundWindowTest(unittest.TestCase):
    def test_one_sample_tail_is_retained_with_enough_context(self):
        windows = sound_windows(480001, 48000)
        self.assertEqual(windows, [(0, 240000), (240000, 480001)])

    def test_windows_cover_every_sample_once_without_truncation_or_padding(self):
        for length in [1, 2, 1199, 1200, 479999, 480000, 480001, 960001, 1440001]:
            ranges = sound_windows(length, 48000)
            self.assertEqual(ranges[0][0], 0)
            self.assertEqual(ranges[-1][1], length)
            self.assertTrue(all(a[1] == b[0] for a, b in zip(ranges, ranges[1:])))
            widths = [end - start for start, end in ranges]
            self.assertTrue(all(0 < width <= 480000 for width in widths))
            self.assertLessEqual(max(widths) - min(widths), 1)

    def test_empty_input_is_not_a_silent_observation(self):
        with self.assertRaises(ValueError):
            sound_windows(0, 48000)


if __name__ == '__main__':
    unittest.main()
