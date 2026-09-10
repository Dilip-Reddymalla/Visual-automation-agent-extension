"""What counts as a pixel the gate painted.

The one measurement in this harness that trusts nothing the manifest says. It was wrong
for a while in a way that flattered the score, and these tests exist so that cannot come
back quietly:

`_is_mask` used to require a sample's neighbours *a whole sampling stride away* to be dark
before counting it. At stride 2 and a capture scale of 0.8 that erodes 2.5 CSS px from the
edge of every painted box -- more than the 2 CSS px of glyph padding the gate adds -- so
the pixel measurement deleted exactly the padding it exists to catch. Over 48 corpus pages
it reported 17.28% over-redaction against the reconstruction's 21.44%, a 4.16-point
disagreement that `check_agreement` refused. Without the erosion the two land 0.29 points
apart and the painted area matches the gate's own claim to about a point.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import metrics


class FakePixels:
    """A pixel accessor over a set of painted rectangles, addressed like Pillow's."""

    def __init__(self, width, height, black_rects):
        self.width = width
        self.height = height
        self.rects = black_rects

    def __getitem__(self, xy):
        x, y = xy
        for rx, ry, rw, rh in self.rects:
            if rx <= x < rx + rw and ry <= y < ry + rh:
                return (0, 0, 0)
        return (255, 255, 255)


class TestMaskDetection(unittest.TestCase):
    def test_a_black_pixel_is_painted(self):
        pixels = FakePixels(100, 100, [(10, 10, 20, 20)])
        self.assertTrue(metrics._is_mask(pixels, 15, 15, 100, 100, 2))

    def test_a_white_pixel_is_not(self):
        pixels = FakePixels(100, 100, [(10, 10, 20, 20)])
        self.assertFalse(metrics._is_mask(pixels, 60, 60, 100, 100, 2))

    def test_the_edge_of_a_painted_box_counts(self):
        """The regression. Every pixel on the boundary of a painted region is painted.

        The eroding version answered False here, which is how a two-pixel padding band
        disappeared from the measurement.
        """
        pixels = FakePixels(100, 100, [(10, 10, 20, 20)])
        for x, y in ((10, 15), (29, 15), (15, 10), (15, 29), (10, 10), (29, 29)):
            self.assertTrue(
                metrics._is_mask(pixels, x, y, 100, 100, 2),
                f"({x}, {y}) is inside the painted rectangle and must count",
            )

    def test_a_thin_painted_band_is_not_erased(self):
        """A two-pixel band -- the width of the gate's glyph padding -- survives.

        The eroding version counted none of it, whatever the stride, because no sample in
        a two-pixel band has a dark neighbour two pixels away.
        """
        pixels = FakePixels(100, 100, [(0, 0, 100, 2)])
        painted = sum(
            1
            for y in range(0, 100)
            for x in range(0, 100)
            if metrics._is_mask(pixels, x, y, 100, 100, 2)
        )
        self.assertEqual(painted, 200)

    def test_a_grey_pixel_is_not_painted(self):
        """What the erosion was reaching for, and what the threshold already does.

        A codec smears a hard boundary into grey. Grey is not near-black, so the
        threshold rejects it without any neighbourhood test at all.
        """

        class Grey:
            def __getitem__(self, _xy):
                return (128, 128, 128)

        self.assertFalse(metrics._is_mask(Grey(), 5, 5, 100, 100, 2))

    def test_the_threshold_is_where_the_docstring_says(self):
        class Dim:
            def __init__(self, value):
                self.value = value

            def __getitem__(self, _xy):
                return (self.value, self.value, self.value)

        below = metrics.MASK_SUM_MAX // 3
        self.assertTrue(metrics._is_mask(Dim(below), 5, 5, 100, 100, 2))
        self.assertFalse(metrics._is_mask(Dim(below + 40), 5, 5, 100, 100, 2))


class TestBoxKind(unittest.TestCase):
    """Which padding the reconstruction replays. See `box_kind_of`."""

    def test_a_finding_on_a_control_value_is_element_kind(self):
        # A value sits well inside its field, so the old "IoU above 0.9" rule answered
        # `text` for every one of them and padded each by two pixels a side.
        elements = [{"index": 3, "box": {"x": 100, "y": 200, "w": 300, "h": 32}}]
        finding = {"box": {"x": 110, "y": 208, "w": 90, "h": 16}}
        self.assertEqual(metrics.box_kind_of(finding, elements), "element")

    def test_a_finding_in_a_text_block_is_text_kind(self):
        elements = [{"box": {"x": 100, "y": 200, "w": 300, "h": 32}}]
        finding = {"box": {"x": 110, "y": 208, "w": 90, "h": 16}}
        self.assertEqual(metrics.box_kind_of(finding, elements), "text")

    def test_the_smallest_container_decides(self):
        # A text block nested inside a control: the block is what the box was measured
        # against.
        elements = [
            {"index": 3, "box": {"x": 0, "y": 0, "w": 1000, "h": 800}},
            {"box": {"x": 100, "y": 200, "w": 300, "h": 32}},
        ]
        finding = {"box": {"x": 110, "y": 208, "w": 90, "h": 16}}
        self.assertEqual(metrics.box_kind_of(finding, elements), "text")

    def test_a_box_inside_nothing_gets_the_conservative_answer(self):
        # Recovered from pixels, or spanning two elements. Glyph padding either way.
        self.assertEqual(
            metrics.box_kind_of({"box": {"x": 10, "y": 10, "w": 5, "h": 5}}, []), "text"
        )


if __name__ == "__main__":
    unittest.main()
