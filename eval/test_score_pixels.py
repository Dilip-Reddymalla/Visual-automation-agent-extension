"""Unit tests for L3 / pixel-baked sensitive information scoring integration in score.py.

Verifies the 7 focused requirements:
1. correctly detected pixel-sensitive span counts as a true positive
2. missed pixel-sensitive span counts as a false negative
3. incorrect OCR redaction in an unlabeled region remains a false positive
4. correctly redacted labeled pixel region is not counted as over-redaction
5. DOM/text scoring behavior remains unchanged
6. pixel and non-pixel ground truth cannot be double-counted
7. coordinate matching uses existing coordinate system without new conversion path
"""

import unittest
from pathlib import Path
import sys

# Ensure eval directory is in sys.path
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import score
import metrics


class TestPixelScoring(unittest.TestCase):

    def setUp(self):
        self.viewport = {"w": 1280, "h": 800}
        self.base_labels = {
            "id": "test-page",
            "title": "Test Page",
            "half": "synthetic",
            "archetype": "scanned-id",
            "heldOut": False,
            "viewport": self.viewport,
            "spans": [],
            "negatives": [],
            "elements": [],
        }
        self.pixel_span = {
            "cls": "AADHAAR",
            "box": {"x": 100, "y": 100, "w": 200, "h": 40},
            "boxKind": "element",
            "medium": "pixels",
            "tag": "img",
            "inViewport": True,
        }
        self.text_span = {
            "cls": "PAN",
            "box": {"x": 400, "y": 100, "w": 200, "h": 40},
            "boxKind": "element",
            "medium": "text",
            "tag": "input",
            "inViewport": True,
        }

    def test_1_correctly_detected_pixel_span_counts_as_tp(self):
        """1. correctly detected pixel-sensitive span counts as a true positive"""
        labels = {**self.base_labels, "spans": [self.pixel_span]}
        manifest = {
            "findings": [
                {
                    "id": "f1",
                    "cls": "AADHAAR",
                    "layer": "L3",
                    "mode": "mask",
                    "box": {"x": 100, "y": 100, "w": 200, "h": 40},
                    "reason": "ocr:verhoeff",
                }
            ]
        }
        record = {"manifest": manifest, "step": {}}
        page_result = score.score_page(record, labels, "highPrecision")

        tps = [m for m in page_result["matches"] if m.kind == "tp"]
        fps = [m for m in page_result["matches"] if m.kind == "fp"]
        fns = [m for m in page_result["matches"] if m.kind == "fn"]

        self.assertEqual(len(tps), 1)
        self.assertEqual(len(fps), 0)
        self.assertEqual(len(fns), 0)
        self.assertEqual(tps[0].truth["cls"], "AADHAAR")
        self.assertEqual(tps[0].finding["layer"], "L3")

    def test_2_missed_pixel_span_counts_as_fn(self):
        """2. missed pixel-sensitive span counts as a false negative"""
        labels = {**self.base_labels, "spans": [self.pixel_span]}
        manifest = {"findings": []}
        record = {"manifest": manifest, "step": {}}
        page_result = score.score_page(record, labels, "highPrecision")

        tps = [m for m in page_result["matches"] if m.kind == "tp"]
        fns = [m for m in page_result["matches"] if m.kind == "fn"]

        self.assertEqual(len(tps), 0)
        self.assertEqual(len(fns), 1)
        self.assertEqual(fns[0].truth["cls"], "AADHAAR")

    def test_3_incorrect_ocr_redaction_unlabeled_region_remains_fp(self):
        """3. incorrect OCR redaction in an unlabeled region remains a false positive"""
        labels = {**self.base_labels, "spans": []}
        manifest = {
            "findings": [
                {
                    "id": "f1",
                    "cls": "ACCOUNT",
                    "layer": "L3",
                    "mode": "mask",
                    "box": {"x": 600, "y": 600, "w": 150, "h": 30},
                    "reason": "ocr:spurious",
                }
            ]
        }
        record = {"manifest": manifest, "step": {}}
        page_result = score.score_page(record, labels, "highPrecision")

        fps = [m for m in page_result["matches"] if m.kind == "fp"]
        self.assertEqual(len(fps), 1)
        self.assertEqual(fps[0].finding["cls"], "ACCOUNT")

    def test_4_correctly_redacted_pixel_region_not_counted_as_over_redaction(self):
        """4. correctly redacted labeled pixel region is not counted as over-redaction"""
        # When element is present in elements list, boxKind is 'element' (0px padding)
        element = {
            "role": "img",
            "name": "Aadhaar Card Scan",
            "tag": "img",
            "type": None,
            "box": {"x": 100, "y": 100, "w": 200, "h": 40},
            "inViewport": True,
            "index": 1,
        }
        labels = {**self.base_labels, "spans": [self.pixel_span], "elements": [element]}
        manifest = {
            "findings": [
                {
                    "id": "f1",
                    "cls": "AADHAAR",
                    "layer": "L3",
                    "mode": "mask",
                    "box": {"x": 100, "y": 100, "w": 200, "h": 40},
                    "reason": "ocr:verhoeff",
                }
            ]
        }
        record = {"manifest": manifest, "step": {"elements": [element]}}
        page_result = score.score_page(record, labels, "highPrecision")

        by_class = page_result["overRedactionByClass"]
        self.assertIn("AADHAAR", by_class)
        # With element padding (0px), painted box matches ground truth box exactly -> outsideArea == 0
        self.assertEqual(by_class["AADHAAR"]["outsideArea"], 0.0)

        # Without element (text boxKind with 2px padding), the painted box covers ground truth,
        # so outsideArea is strictly limited to the 2px padding ring rather than 100% of the box.
        labels_no_el = {**self.base_labels, "spans": [self.pixel_span]}
        record_no_el = {"manifest": manifest, "step": {}}
        page_no_el = score.score_page(record_no_el, labels_no_el, "highPrecision")
        by_class_no_el = page_no_el["overRedactionByClass"]
        # Total painted area is ~8976; outside area (padding ring) is ~1026, so > 85% of painted area is covered
        painted_area = by_class_no_el["AADHAAR"]["paintedArea"]
        outside_area = by_class_no_el["AADHAAR"]["outsideArea"]
        self.assertLess(outside_area, painted_area * 0.2)

    def test_5_dom_text_scoring_behavior_remains_unchanged(self):
        """5. DOM/text scoring behavior remains unchanged"""
        labels = {**self.base_labels, "spans": [self.text_span]}
        manifest = {
            "findings": [
                {
                    "id": "f1",
                    "cls": "PAN",
                    "layer": "L1",
                    "mode": "mask",
                    "box": {"x": 400, "y": 100, "w": 200, "h": 40},
                }
            ]
        }
        record = {"manifest": manifest, "step": {}}
        page_result = score.score_page(record, labels, "highPrecision")

        tps = [m for m in page_result["matches"] if m.kind == "tp"]
        self.assertEqual(len(tps), 1)
        self.assertEqual(tps[0].truth["cls"], "PAN")

        scored, below, pixels = score.visible_truths(labels)
        self.assertEqual(len(scored), 1)
        self.assertEqual(scored[0]["cls"], "PAN")
        self.assertEqual(len(pixels), 0)

    def test_6_pixel_and_non_pixel_ground_truth_cannot_be_double_counted(self):
        """6. pixel and non-pixel ground truth cannot be double-counted"""
        duplicate_pixel_span = {
            "cls": "PAN",
            "box": {"x": 400, "y": 100, "w": 200, "h": 40},
            "boxKind": "element",
            "medium": "pixels",
            "tag": "img",
            "inViewport": True,
        }
        labels = {**self.base_labels, "spans": [self.text_span, duplicate_pixel_span]}

        scored, below, pixels = score.visible_truths(labels)
        self.assertEqual(len(scored), 1)
        self.assertEqual(len(pixels), 1)

    def test_7_coordinate_matching_uses_existing_coordinate_system(self):
        """7. coordinate matching uses the existing coordinate system without a new conversion path"""
        labels = {**self.base_labels, "spans": [self.pixel_span]}
        manifest = {
            "findings": [
                {
                    "id": "f1",
                    "cls": "AADHAAR",
                    "layer": "L3",
                    "mode": "mask",
                    "box": {"x": 110, "y": 100, "w": 200, "h": 40},
                }
            ]
        }
        record = {"manifest": manifest, "step": {}}
        page_result = score.score_page(record, labels, "highPrecision")

        matches = page_result["matches"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].kind, "tp")
        self.assertGreaterEqual(matches[0].score, metrics.MATCH_IOU)


if __name__ == "__main__":
    unittest.main()
