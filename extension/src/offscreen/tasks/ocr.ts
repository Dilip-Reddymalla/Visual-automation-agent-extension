/**
 * L3 text: OCR over DOM-opaque regions only.
 *
 * "Opaque" means the DOM has nothing to say: an img, a canvas, a video, a cross-origin
 * iframe, an embedded PDF. Everywhere else the DOM already handed over the text, and
 * re-deriving it from pixels costs about 500 ms to learn what was free (CLAUDE.md,
 * mistakes). Never OCR the whole screenshot.
 *
 * What is finished here without weights: which regions qualify, the crop cache, and the
 * region attribution that makes a batched run traceable. The PP-OCR decode itself --
 * differentiable-binarization postprocessing on the detector, CTC on the recogniser --
 * is not, and is called out in the M5b report.
 *
 * Node-pure: hashing and cropping are injected.
 */

import type { Box } from '../../shared/coords';
import type { ObservedElement } from '../../shared/observed';
import type { ModelSession, TensorLike } from '../host';

/** Tags whose contents the DOM cannot describe. */
const OPAQUE_TAGS: ReadonlySet<string> = new Set([
  'img',
  'canvas',
  'video',
  'iframe',
  'embed',
  'object',
]);

/** Smaller than this and there is no text to find: an icon, a spacer, a tracking pixel. */
export const MIN_OCR_SIDE = 48;

/** How many crops to keep. A scanned document across a long session is a few entries. */
export const OCR_CACHE_LIMIT = 32;

export interface OcrLine {
  text: string;
  /** CSS px of the visual viewport, like every other box in the project. */
  box: Box;
  score: number;
  /**
   * Which crop this line came from.
   *
   * Batched crops go to the model as one call and come back as one list; without this
   * there is no way to say which image a line belongs to, and therefore no way to put
   * its box back in the right place or to attribute a finding to an element.
   */
  region: number;
}

export interface OcrRegion {
  /** Index into the batch, and the value that comes back as OcrLine.region. */
  region: number;
  box: Box;
  elementIndex?: number;
  /** Why this region is opaque, for the trace. */
  reason: string;
}

/**
 * The regions worth reading. An element the DOM described is not one of them, however
 * much text is painted inside it.
 */
export function opaqueRegions(elements: ObservedElement[]): OcrRegion[] {
  const regions: OcrRegion[] = [];

  for (const el of elements) {
    const tag = el.tag.toLowerCase();
    const opaqueTag = OPAQUE_TAGS.has(tag);
    // A closed shadow root is opaque in exactly the same sense: something is rendered
    // there and we cannot read it.
    const opaqueShadow = el.opaque === true;
    if (!opaqueTag && !opaqueShadow) continue;

    if (el.box.w < MIN_OCR_SIDE || el.box.h < MIN_OCR_SIDE) continue;

    regions.push({
      region: regions.length,
      box: el.box,
      elementIndex: el.index,
      reason: opaqueShadow ? 'closed-shadow-root' : `tag-${tag}`,
    });
  }

  return regions;
}

export interface CacheEntry {
  lines: OcrLine[];
  lastUsed: number;
}

export interface OcrCache {
  get(hash: string, now: number): OcrLine[] | undefined;
  set(hash: string, lines: OcrLine[], now: number): void;
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  clear(): void;
}

/**
 * Keyed by a hash of the crop's pixels, not by its position or its element index.
 *
 * A scanned document on screen across six steps is the same pixels six times, and
 * reading it once is the difference between 40 ms and 240 ms of the latency budget. The
 * position is deliberately not part of the key: the page scrolling does not change what
 * the document says.
 */
export function createOcrCache(limit = OCR_CACHE_LIMIT): OcrCache {
  const entries = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;

  function evict(): void {
    while (entries.size > limit) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, entry] of entries) {
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      entries.delete(oldestKey);
    }
  }

  return {
    get(hash, now) {
      const entry = entries.get(hash);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      entry.lastUsed = now;
      hits += 1;
      // Copies: a caller re-boxing lines for a new scroll position must not rewrite
      // the cached ones.
      return entry.lines.map((line) => ({ ...line, box: { ...line.box } }));
    },

    set(hash, lines, now) {
      entries.set(hash, {
        lines: lines.map((line) => ({ ...line, box: { ...line.box } })),
        lastUsed: now,
      });
      evict();
    },

    get size() {
      return entries.size;
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * Lines come back in crop coordinates -- pixels within the cropped image. This puts
 * them where they belong on screen.
 *
 * `cropScale` is image px per CSS px of the crop, which is not the frame's scale: a
 * region is often resized before it goes to the recogniser, and using the frame scale
 * here is the same class of mistake as using devicePixelRatio after a downscale.
 */
export function linesToViewport(
  lines: OcrLine[],
  region: OcrRegion,
  cropScale: number,
): OcrLine[] {
  return lines.map((line) => ({
    ...line,
    region: region.region,
    box: {
      x: region.box.x + line.box.x / cropScale,
      y: region.box.y + line.box.y / cropScale,
      w: line.box.w / cropScale,
      h: line.box.h / cropScale,
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// PP-OCR Detection (DBNet) Preprocessing & Postprocessing
// ─────────────────────────────────────────────────────────────────────────────

export interface RawImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Resize an image using bilinear interpolation into target dimensions. */
export function resizeBilinear(
  src: RawImageLike,
  targetWidth: number,
  targetHeight: number,
): RawImageLike {
  const dstData = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  // Hoisted so the inner loop reads one local rather than a property each pixel.
  const srcData = src.data;
  const xRatio = src.width > 1 ? (src.width - 1) / (targetWidth - 1 || 1) : 0;
  const yRatio = src.height > 1 ? (src.height - 1) / (targetHeight - 1 || 1) : 0;

  for (let y = 0; y < targetHeight; y++) {
    const srcY = y * yRatio;
    const yFloor = Math.floor(srcY);
    const yCeil = Math.min(src.height - 1, Math.ceil(srcY));
    const yWeight = srcY - yFloor;

    for (let x = 0; x < targetWidth; x++) {
      const srcX = x * xRatio;
      const xFloor = Math.floor(srcX);
      const xCeil = Math.min(src.width - 1, Math.ceil(srcX));
      const xWeight = srcX - xFloor;

      const dstIdx = (y * targetWidth + x) * 4;

      const idx00 = (yFloor * src.width + xFloor) * 4;
      const idx01 = (yFloor * src.width + xCeil) * 4;
      const idx10 = (yCeil * src.width + xFloor) * 4;
      const idx11 = (yCeil * src.width + xCeil) * 4;

      for (let c = 0; c < 4; c++) {
        // Every index here is clamped into range above, so `?? 0` never fires; it is
        // how the buffer read satisfies noUncheckedIndexedAccess without an assertion.
        const p00 = srcData[idx00 + c] ?? 0;
        const p01 = srcData[idx01 + c] ?? 0;
        const p10 = srcData[idx10 + c] ?? 0;
        const p11 = srcData[idx11 + c] ?? 0;
        const top = p00 * (1 - xWeight) + p01 * xWeight;
        const bottom = p10 * (1 - xWeight) + p11 * xWeight;
        dstData[dstIdx + c] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }

  return { width: targetWidth, height: targetHeight, data: dstData };
}

/** Preprocess image crop for DBNet (scale to multiples of 32, normalize CHW float32). */
export function preprocessDetImage(
  image: RawImageLike,
  maxSide = 960,
): {
  tensorData: Float32Array;
  dims: [number, number, number, number];
  scaleX: number;
  scaleY: number;
} {
  let scale = 1.0;
  const currentMax = Math.max(image.width, image.height);
  if (currentMax > maxSide) {
    scale = maxSide / currentMax;
  }

  const targetW = Math.max(32, Math.round((image.width * scale) / 32) * 32);
  const targetH = Math.max(32, Math.round((image.height * scale) / 32) * 32);

  const resized =
    targetW === image.width && targetH === image.height
      ? image
      : resizeBilinear(image, targetW, targetH);

  const scaleX = targetW / image.width;
  const scaleY = targetH / image.height;

  // Normalization parameters for DBNet (ImageNet standard). Tuples, not arrays: a
  // fixed-length tuple indexes without noUncheckedIndexedAccess widening to undefined.
  const mean: readonly [number, number, number] = [0.485, 0.456, 0.406];
  const std: readonly [number, number, number] = [0.229, 0.224, 0.225];

  const channelSize = targetW * targetH;
  const tensorData = new Float32Array(3 * channelSize);
  const px = resized.data;

  for (let i = 0; i < channelSize; i++) {
    const r = (px[i * 4] ?? 0) / 255.0;
    const g = (px[i * 4 + 1] ?? 0) / 255.0;
    const b = (px[i * 4 + 2] ?? 0) / 255.0;

    tensorData[i] = (r - mean[0]) / std[0];
    tensorData[channelSize + i] = (g - mean[1]) / std[1];
    tensorData[2 * channelSize + i] = (b - mean[2]) / std[2];
  }

  return {
    tensorData,
    dims: [1, 3, targetH, targetW],
    scaleX,
    scaleY,
  };
}

/**
 * DBNet Differentiable-Binarization postprocessing.
 *
 * Extracts bounding boxes from the detector's probability map:
 * 1. Binarize by `thresh` (default 0.3)
 * 2. Connected components extraction
 * 3. Average probability filter (`boxThresh` default 0.5)
 * 4. Polygon unclip expansion (`unclipRatio` default 1.6)
 * 5. Coordinate remapping back to original crop
 */
export function postprocessDet(
  probMap: Float32Array,
  detW: number,
  detH: number,
  scaleX: number,
  scaleY: number,
  thresh = 0.3,
  boxThresh = 0.5,
  unclipRatio = 1.6,
): Box[] {
  const binary = new Uint8Array(detW * detH);
  for (let i = 0; i < binary.length; i++) {
    // A probability map shorter than detW*detH is a model/shape mismatch; treating the
    // missing tail as below-threshold is what the previous assertion did too.
    const p = probMap[i];
    binary[i] = p !== undefined && p > thresh ? 1 : 0;
  }

  const visited = new Uint8Array(detW * detH);
  const boxes: Box[] = [];

  const queueX = new Int32Array(detW * detH);
  const queueY = new Int32Array(detW * detH);

  for (let y = 0; y < detH; y++) {
    for (let x = 0; x < detW; x++) {
      const idx = y * detW + x;
      if (binary[idx] === 0 || visited[idx] === 1) continue;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      let scoreSum = 0;

      let head = 0;
      let tail = 0;

      queueX[tail] = x;
      queueY[tail] = y;
      tail++;
      visited[idx] = 1;

      while (head < tail) {
        const curX = queueX[head] ?? 0;
        const curY = queueY[head] ?? 0;
        head++;

        count++;
        const curIdx = curY * detW + curX;
        scoreSum += probMap[curIdx] ?? 0;

        if (curX < minX) minX = curX;
        if (curX > maxX) maxX = curX;
        if (curY < minY) minY = curY;
        if (curY > maxY) maxY = curY;

        // 8-neighborhood search
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = curX + dx;
            const ny = curY + dy;
            if (nx >= 0 && nx < detW && ny >= 0 && ny < detH) {
              const nIdx = ny * detW + nx;
              if (binary[nIdx] === 1 && visited[nIdx] === 0) {
                visited[nIdx] = 1;
                queueX[tail] = nx;
                queueY[tail] = ny;
                tail++;
              }
            }
          }
        }
      }

      // Ignore noise (tiny clusters < 9 pixels)
      if (count < 9) continue;

      const avgScore = scoreSum / count;
      if (avgScore < boxThresh) continue;

      const rawW = maxX - minX + 1;
      const rawH = maxY - minY + 1;
      if (rawW < 3 || rawH < 3) continue;

      // Unclip expansion
      const area = rawW * rawH;
      const perimeter = 2 * (rawW + rawH);
      const distance = (area * (unclipRatio - 1.0)) / Math.max(1, perimeter);

      const expandedMinX = Math.max(0, minX - distance);
      const expandedMinY = Math.max(0, minY - distance);
      const expandedMaxX = Math.min(detW - 1, maxX + distance);
      const expandedMaxY = Math.min(detH - 1, maxY + distance);

      const finalBox: Box = {
        x: expandedMinX / scaleX,
        y: expandedMinY / scaleY,
        w: (expandedMaxX - expandedMinX) / scaleX,
        h: (expandedMaxY - expandedMinY) / scaleY,
      };

      if (finalBox.w >= 4 && finalBox.h >= 4) {
        boxes.push(finalBox);
      }
    }
  }

  // Sort reading order: top-to-bottom, left-to-right
  boxes.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
    return a.x - b.x;
  });

  return boxes;
}

// ─────────────────────────────────────────────────────────────────────────────
// PP-OCR Recognition (SVTR/CRNN) Preprocessing & CTC Decoding
// ─────────────────────────────────────────────────────────────────────────────

/** Crop a sub-rectangle from a raw image. */
export function cropImage(image: RawImageLike, box: Box): RawImageLike {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.min(image.width - x, Math.max(1, Math.ceil(box.w)));
  const h = Math.min(image.height - y, Math.max(1, Math.ceil(box.h)));

  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * image.width + x) * 4;
    const srcEnd = srcStart + w * 4;
    const dstStart = row * w * 4;
    out.set(image.data.subarray(srcStart, srcEnd), dstStart);
  }

  return { width: w, height: h, data: out };
}

/** Preprocess line crop for SVTR/CRNN recognition (fixed height 48px, normalized [-0.5, 0.5]). */
export function preprocessRecCrop(
  crop: RawImageLike,
  targetHeight = 48,
): {
  tensorData: Float32Array;
  dims: [number, number, number, number];
} {
  const scale = targetHeight / Math.max(1, crop.height);
  const targetWidth = Math.max(32, Math.round(crop.width * scale));

  const resized = resizeBilinear(crop, targetWidth, targetHeight);
  const channelSize = targetWidth * targetHeight;
  const tensorData = new Float32Array(3 * channelSize);

  const px = resized.data;

  // Normalization for PP-OCRv4 recognition: (pixel / 255.0 - 0.5) / 0.5
  for (let i = 0; i < channelSize; i++) {
    const r = ((px[i * 4] ?? 0) / 255.0 - 0.5) / 0.5;
    const g = ((px[i * 4 + 1] ?? 0) / 255.0 - 0.5) / 0.5;
    const b = ((px[i * 4 + 2] ?? 0) / 255.0 - 0.5) / 0.5;

    tensorData[i] = r;
    tensorData[channelSize + i] = g;
    tensorData[2 * channelSize + i] = b;
  }

  return {
    tensorData,
    dims: [1, 3, targetHeight, targetWidth],
  };
}

/**
 * Greedy CTC decoder.
 *
 * Logits shape: [1, timeSteps, vocabSize].
 * Index 0 is the CTC blank token.
 * `charset` has 6,623 lines (line i corresponds to index i + 1).
 */
export function decodeCtc(
  logits: Float32Array | ArrayLike<number>,
  timeSteps: number,
  vocabSize: number,
  charset: string[],
): { text: string; score: number } {
  let prevIdx = -1;
  const chars: string[] = [];
  let scoreSum = 0;
  let scoreCount = 0;

  for (let t = 0; t < timeSteps; t++) {
    let maxIdx = 0;
    let maxLogit = -Infinity;
    const offset = t * vocabSize;

    for (let c = 0; c < vocabSize; c++) {
      // Skip rather than coerce: a short logits buffer must not let index 0 win the
      // argmax by scoring 0, which is what `?? 0` would do here.
      const val = logits[offset + c];
      if (val === undefined) continue;
      if (val > maxLogit) {
        maxLogit = val;
        maxIdx = c;
      }
    }

    if (maxIdx !== 0 && maxIdx !== prevIdx) {
      let char = '';
      if (maxIdx > 0 && maxIdx <= charset.length) {
        char = charset[maxIdx - 1] ?? '';
      } else if (maxIdx === charset.length + 1) {
        char = ' ';
      }

      if (char) {
        chars.push(char);
        const conf = 1.0 / (1.0 + Math.exp(-Math.min(10, Math.max(-10, maxLogit))));
        scoreSum += conf;
        scoreCount++;
      }
    }

    prevIdx = maxIdx;
  }

  const text = chars.join('').trim();
  const score = scoreCount > 0 ? scoreSum / scoreCount : 0;
  return { text, score };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compound OCR Runner
// ─────────────────────────────────────────────────────────────────────────────

export interface OcrRunnerAssets {
  charset: string[];
}

export type TensorFactory = (
  type: string,
  data: ArrayLike<number>,
  dims: number[],
) => TensorLike;

export type OcrRunner = (crop: RawImageLike, regionIndex?: number) => Promise<OcrLine[]>;

/**
 * Constructs a callable OCR runner combining detection (DBNet) and recognition (CRNN).
 */
export function createOcrRunner(
  sessionDet: ModelSession,
  sessionRec: ModelSession,
  charset: string[],
  tensorFactory: TensorFactory,
): OcrRunner {
  return async function runOcrOnCrop(
    image: RawImageLike,
    regionIndex = 0,
  ): Promise<OcrLine[]> {
    if (image.width < 8 || image.height < 8) return [];

    // 1. Detection
    const detPre = preprocessDetImage(image);
    const detTensor = tensorFactory('float32', detPre.tensorData, detPre.dims);
    const detOut = await sessionDet.run({ [sessionDet.inputNames[0] ?? 'x']: detTensor });

    const detOutputTensor = detOut[sessionDet.outputNames[0] ?? 'sigmoid_0'];
    if (!detOutputTensor) return [];

    const probMap = detOutputTensor.data as Float32Array;
    const detH = detPre.dims[2];
    const detW = detPre.dims[3];

    let boxes = postprocessDet(probMap, detW, detH, detPre.scaleX, detPre.scaleY);

    // Fallback: if no discrete box was found but crop has text proportions, evaluate as single line
    if (boxes.length === 0 && image.width >= MIN_OCR_SIDE && image.height >= 16) {
      boxes = [{ x: 0, y: 0, w: image.width, h: image.height }];
    }

    const lines: OcrLine[] = [];

    // 2. Recognition for each box
    for (const box of boxes) {
      const lineCrop = cropImage(image, box);
      if (lineCrop.width < 4 || lineCrop.height < 4) continue;

      const recPre = preprocessRecCrop(lineCrop);
      const recTensor = tensorFactory('float32', recPre.tensorData, recPre.dims);
      const recOut = await sessionRec.run({ [sessionRec.inputNames[0] ?? 'x']: recTensor });

      const recOutputTensor = recOut[sessionRec.outputNames[0] ?? 'softmax_0'];
      if (!recOutputTensor) continue;

      const logits = recOutputTensor.data as Float32Array;
      const dims = recOutputTensor.dims;
      const timeSteps =
        (dims.length === 3 ? dims[1] : undefined) ?? Math.floor(logits.length / 6625);
      const vocabSize = (dims.length === 3 ? dims[2] : undefined) ?? 6625;

      const decoded = decodeCtc(logits, timeSteps, vocabSize, charset);
      if (decoded.text.length > 0) {
        lines.push({
          text: decoded.text,
          box,
          score: decoded.score,
          region: regionIndex,
        });
      }
    }

    return lines;
  };
}
