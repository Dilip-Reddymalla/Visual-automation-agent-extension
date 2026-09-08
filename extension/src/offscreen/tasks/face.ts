/**
 * L3: face detection, for photographs on enrolment and KYC pages.
 *
 * Licence watch (CLAUDE.md invariant 3): MIT and Apache-2.0 weights only. No Ultralytics
 * YOLOv8, no OmniParser v2 icon detector -- both are AGPL, and ISRO needs this deployable
 * offline without that obligation. YuNet is MIT, 232 KB, and in the model manifest.
 *
 * ## What the model hands back
 *
 * YuNet 2023mar takes `[1,3,640,640]` and returns twelve tensors -- `cls`, `obj`, `bbox`
 * and `kps` at strides 8, 16 and 32. There is no anchor *box* in the usual sense: the
 * anchor is the feature-map cell itself, and the head predicts an offset from that cell's
 * index plus a log-scale size relative to the stride. So a prediction at cell (col, row) of
 * the stride-8 map decodes to
 *
 *     cx = (col + dx) * 8        w = exp(dw) * 8
 *     cy = (row + dy) * 8        h = exp(dh) * 8
 *
 * and the score is the *geometric* mean of the two heads, `sqrt(cls * obj)`, each clamped
 * to [0,1] first. That fusion is the one detail worth stating plainly: an arithmetic mean
 * or a plain product both produce plausible-looking numbers and a different threshold, and
 * "plausible but wrong" is the failure this whole layer is most exposed to.
 *
 * The keypoints are decoded the same way and are not used here. A face is a region to
 * blur; where its eyes are is not this project's business.
 *
 * ## Everything is in model space until the caller says otherwise
 *
 * `decodeFaces` returns boxes in the 640x640 the model saw. The frame is letterboxed to get
 * there, and `fromLetterbox` undoes exactly that -- one place, so a box cannot pick up half
 * a transform. A face box that reaches the gate still carrying letterbox padding is a blur
 * over the wrong part of the page, which is worse than no blur at all because it looks like
 * it worked.
 *
 * Node-pure: no session is created here and no browser type is touched. The tensors arrive
 * as plain arrays, which is what makes the anchor arithmetic unit-testable.
 */

import type { Box } from '../../shared/coords';
import { iou } from '../../shared/coords';

/** The square the model was exported for. Not configurable; the graph has it baked in. */
export const FACE_INPUT = 640;

/** Feature-map strides, and therefore the three resolutions faces are found at. */
export const STRIDES = [8, 16, 32] as const;

/**
 * OpenCV's own defaults for `FaceDetectorYN`, and deliberately not tuned here.
 *
 * A threshold moved to make a particular picture work is a threshold that will move again
 * for the next picture. If the demo photograph is not detected at 0.9, that is worth
 * reporting as a corpus fact rather than dialling away.
 */
export const FACE_SCORE_THRESHOLD = 0.9;
export const FACE_NMS_IOU = 0.3;

/** One tensor as the runtime hands it over. Plain data, so tests can build them by hand. */
export interface FaceTensor {
  data: ArrayLike<number>;
  dims: readonly number[];
}

/** The twelve outputs, by the names in the graph. */
export type FaceOutputs = Readonly<Record<string, FaceTensor>>;

export interface FaceDetection {
  /** In the model's own 640x640 space, corner form. */
  box: Box;
  score: number;
}

export interface DecodeOptions {
  scoreThreshold?: number;
  nmsIou?: number;
  /** The square the tensors describe. Only tests pass anything but FACE_INPUT. */
  input?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Decode one stride's three heads into candidate boxes.
 *
 * Row-major over the feature map, which is the order the flattened tensors are in: cell
 * `i` is at `(col, row) = (i % cols, floor(i / cols))`. Getting that transposed puts every
 * box on the wrong side of the image and still looks like a working detector on a
 * horizontally symmetric photograph, which is why the fixture pins it.
 */
function decodeStride(
  stride: number,
  cls: FaceTensor,
  obj: FaceTensor,
  bbox: FaceTensor,
  input: number,
  threshold: number,
): FaceDetection[] {
  const cols = Math.floor(input / stride);
  const cells = cols * Math.floor(input / stride);
  const out: FaceDetection[] = [];

  for (let i = 0; i < cells; i += 1) {
    // Each head is clamped before the fusion, not after. A raw logit that overshoots 1
    // would otherwise pull the geometric mean above what either head actually claimed.
    const score = Math.sqrt(clamp01(cls.data[i] ?? 0) * clamp01(obj.data[i] ?? 0));
    if (score < threshold) continue;

    const col = i % cols;
    const row = Math.floor(i / cols);
    const at = i * 4;

    const cx = (col + (bbox.data[at] ?? 0)) * stride;
    const cy = (row + (bbox.data[at + 1] ?? 0)) * stride;
    const w = Math.exp(bbox.data[at + 2] ?? 0) * stride;
    const h = Math.exp(bbox.data[at + 3] ?? 0) * stride;

    // Centre form to corner form. Everything downstream in this project is corner form.
    out.push({ box: { x: cx - w / 2, y: cy - h / 2, w, h }, score });
  }

  return out;
}

/**
 * Greedy non-maximum suppression by IoU.
 *
 * Highest score first, and a candidate is kept only if it overlaps nothing already kept.
 * The same face fires on several cells and often on two strides at once, so without this
 * one face becomes four overlapping blurs and four manifest rows.
 */
export function nms(
  detections: readonly FaceDetection[],
  threshold = FACE_NMS_IOU,
): FaceDetection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: FaceDetection[] = [];

  for (const candidate of sorted) {
    if (kept.some((k) => iou(k.box, candidate.box) > threshold)) continue;
    kept.push(candidate);
  }

  return kept;
}

/** The twelve tensors to boxes, in model space. Pure. */
export function decodeFaces(
  outputs: FaceOutputs,
  options: DecodeOptions = {},
): FaceDetection[] {
  const input = options.input ?? FACE_INPUT;
  const threshold = options.scoreThreshold ?? FACE_SCORE_THRESHOLD;

  const candidates: FaceDetection[] = [];
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    // A missing head is a graph that is not the one we shipped. Loud, because a silent
    // skip here reads downstream as "no faces on this page".
    if (!cls || !obj || !bbox) {
      throw new Error(`face: stride ${stride} is missing a head (cls/obj/bbox)`);
    }
    candidates.push(...decodeStride(stride, cls, obj, bbox, input, threshold));
  }

  return nms(candidates, options.nmsIou ?? FACE_NMS_IOU);
}

/**
 * RGBA pixels to the NCHW float tensor the graph wants.
 *
 * Raw 0-255, not normalised to 0-1. That is worth pinning rather than assuming: YuNet was
 * exported without a scaling layer, so feeding it 0-1 does not error -- it produces
 * confident nonsense, which is the failure mode this layer is least able to notice.
 *
 * Channel order is RGB. The alpha channel is dropped; a screenshot is opaque and the model
 * has three input planes.
 */
export function toTensor(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array {
  const plane = width * height;
  const out = new Float32Array(3 * plane);

  for (let i = 0; i < plane; i += 1) {
    const at = i * 4;
    out[i] = pixels[at] ?? 0;
    out[plane + i] = pixels[at + 1] ?? 0;
    out[2 * plane + i] = pixels[at + 2] ?? 0;
  }
  return out;
}

// ── Letterbox ─────────────────────────────────────────────────────────────────

/**
 * How a frame was fitted into the model's square.
 *
 * Aspect preserved and the remainder padded, rather than squashed: a face squeezed to 60%
 * of its width is a face the detector was never trained on, and the recall lost that way
 * is invisible -- it looks exactly like a page with no faces on it.
 */
export interface Letterbox {
  /** Model pixels per source pixel. */
  scale: number;
  /** Where the image starts inside the 640 square. */
  padX: number;
  padY: number;
}

export function letterbox(width: number, height: number, input = FACE_INPUT): Letterbox {
  const scale = Math.min(input / width, input / height);
  return {
    scale,
    padX: (input - width * scale) / 2,
    padY: (input - height * scale) / 2,
  };
}

/**
 * A box in model space back to the source image's own pixels.
 *
 * The inverse of `letterbox`, and the only one. Everywhere else in this project a box
 * carries exactly one scale factor (CLAUDE.md invariant 2); a face box that arrives at the
 * gate still holding the padding offset is a blur beside the face rather than on it, and
 * it looks like the feature is working.
 */
export function fromLetterbox(box: Box, fit: Letterbox): Box {
  return {
    x: (box.x - fit.padX) / fit.scale,
    y: (box.y - fit.padY) / fit.scale,
    w: box.w / fit.scale,
    h: box.h / fit.scale,
  };
}
