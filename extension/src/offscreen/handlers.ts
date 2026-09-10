/**
 * The inference host's message handlers, in one place so both hosts can install them:
 * Chrome's offscreen document and Firefox's background event page (CLAUDE.md invariant
 * 8 -- neither is the service worker, because the service worker has no backend).
 *
 * This file owns the message shapes and nothing else. The model calls belong to
 * offscreen/tasks/*, which M5 writes; loading, unloading and accounting belong to
 * host.ts and sessions.ts. Keeping those three apart is what lets M5 add a task without
 * touching the protocol and M6 seal without knowing what a session is.
 *
 * The host is created lazily and nothing is loaded until a message asks for it.
 */

import {
  handle,
  type HostStats,
  type InferResult,
  type SelfTestResult,
} from '../shared/messages';
import { createInferenceHost, type InferenceHost, type OrtRuntime } from './host';
import { allocatorFor, resolvePlaceholder } from './allocator';
import { clearPanel, getStep, listSteps } from './panel';
import { classForLabel, createNerRunner, type NerAssets } from './tasks/ner';
import {
  createOcrCache,
  createOcrRunner,
  linesToViewport,
  type OcrLine,
} from './tasks/ocr';
import {
  decodeFaces,
  FACE_INPUT,
  fromLetterbox,
  letterbox,
  toTensor,
  type FaceOutputs,
} from './tasks/face';
import { browserDecodeDeps, decodeFrame } from './frames';
import { fromImageSpace, type Box } from '../shared/coords';
import type { InferRequest, NerSpan } from '../shared/messages';

/**
 * The tokenizer and label table, fetched once and kept.
 *
 * 1.4 MB of JSON parsed on every step would show up in the latency budget for no reason:
 * the vocabulary does not change between steps, and the model it belongs to is already
 * cached by the session registry.
 */
let assets: Promise<NerAssets> | null = null;

function nerAssets(runtime: OrtRuntime): Promise<NerAssets> {
  assets ??= (async () => {
    const tokenizer = await runtime.loadJson<{
      model: { vocab: Array<[string, number]>; unk_id: number };
    }>('models/ner-tokenizer.json');
    const config = await runtime.loadJson<{ id2label: Record<string, string> }>(
      'models/ner-config.json',
    );

    const labels: string[] = [];
    for (const [id, label] of Object.entries(config.id2label)) labels[Number(id)] = label;

    return { vocab: tokenizer.model.vocab, unkId: tokenizer.model.unk_id, labels };
  })();
  return assets;
}
import { runSmokeTest } from './smoke';
import { sealAndEncode, type SealDeps } from './seal';
import { createFrameStore } from '../platform/frame-store';
import { policyFor } from '../redaction/policy';

let host: InferenceHost | null = null;

/** Built on first use. A host that exists has probed the GPU; one that does not, has not. */
function ensureHost(runtime: OrtRuntime): InferenceHost {
  host ??= createInferenceHost({ runtime });
  return host;
}

/** Tests and teardown. */
export async function disposeHost(): Promise<void> {
  await host?.dispose();
  host = null;
}

/**
 * One frame through YuNet, and the boxes back in CSS pixels.
 *
 * Three things here are not optional and each of them is a way to be silently wrong.
 *
 * **Letterbox, not squash.** The frame is fitted into the model's 640 square with its
 * aspect preserved and the remainder padded. Stretching a 1024x640 screenshot to a square
 * makes every face 60% of its trained width, and the recall lost that way is invisible --
 * it looks exactly like a page with no faces on it.
 *
 * **One scale factor home.** `fromLetterbox` undoes the padding and the fit; `fromImageSpace`
 * undoes the capture downscale. A box that skips either arrives plausibly sized and in the
 * wrong place, which is worse than no box because it looks like the feature working.
 *
 * **Through `withTask`.** The session is created by sessions.ts and nowhere else, so the
 * timing lands in the ring the M10 waterfall reads and the model unloads on idle with the
 * others. An ORT session made here would be invisible to both.
 *
 * `getImageData` is a pixel *read*. It is not an encode and does not touch the gate's
 * monopoly on turning pixels into bytes -- `test:gate` greps for `toBlob`, `toDataURL` and
 * `convertToBlob`, none of which appear here.
 */
async function runFace(
  request: Extract<InferRequest, { task: 'face' }>,
  runtime: OrtRuntime,
): Promise<InferResult> {
  const decoded = await decodeFrame(request.frame, request.viewport, browserDecodeDeps());

  try {
    const fit = letterbox(decoded.width, decoded.height);
    const square = new OffscreenCanvas(FACE_INPUT, FACE_INPUT);
    const ctx = square.getContext('2d');
    if (!ctx) throw new Error('face: no 2d context for the letterbox');

    // Padding is black rather than left transparent: an alpha of zero composites as
    // whatever the canvas was, and the model has no alpha plane to be told about it.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FACE_INPUT, FACE_INPUT);
    ctx.drawImage(
      decoded.bitmap as unknown as CanvasImageSource,
      fit.padX,
      fit.padY,
      decoded.width * fit.scale,
      decoded.height * fit.scale,
    );

    const pixels = ctx.getImageData(0, 0, FACE_INPUT, FACE_INPUT);
    const input = toTensor(pixels.data, FACE_INPUT, FACE_INPUT);

    const host = ensureHost(runtime);
    const detections = await host.withTask('face', async (session) => {
      const tensor = runtime.tensor('float32', input, [1, 3, FACE_INPUT, FACE_INPUT]);
      const outputs = await session.run({ input: tensor });
      return decodeFaces(outputs as unknown as FaceOutputs);
    });

    const boxes: Box[] = [];
    const scores: number[] = [];
    for (const detection of detections) {
      boxes.push(fromImageSpace(fromLetterbox(detection.box, fit), decoded.scale));
      scores.push(detection.score);
    }
    return { task: 'face', boxes, scores };
  } finally {
    // The decoded bitmap is a full frame of the user's screen. It is closed on every
    // path, including the throwing one.
    decoded.bitmap.close();
  }
}

let ocrCharsetAssets: Promise<string[]> | null = null;

function ocrCharset(runtime: OrtRuntime): Promise<string[]> {
  ocrCharsetAssets ??= (async () => {
    const text = await runtime.loadText('models/ocr-charset.txt');
    return text.split(/\r?\n/).filter((l) => l.length > 0);
  })();
  return ocrCharsetAssets;
}

const ocrCache = createOcrCache();

async function hashBytes(data: ArrayBufferView): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0;
  const arr = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 4096));
  for (let i = 0; i < arr.length; i++) {
    h = (Math.imul(31, h) + (arr[i] ?? 0)) | 0;
  }
  return h.toString(16);
}

async function runOcr(
  request: Extract<InferRequest, { task: 'ocr' }>,
  runtime: OrtRuntime,
): Promise<InferResult> {
  const viewport = request.viewport ?? {
    w: 1024,
    h: 640,
    scrollX: 0,
    scrollY: 0,
    scale: 1,
  };
  const decoded = await decodeFrame(request.frame, viewport, browserDecodeDeps());

  try {
    const charset = await ocrCharset(runtime);
    const host = ensureHost(runtime);
    const allLines: OcrLine[] = [];

    await host.withTask('ocrDet', async (sessionDet) => {
      await host.withTask('ocrRec', async (sessionRec) => {
        const runner = createOcrRunner(sessionDet, sessionRec, charset, (t, d, dims) =>
          runtime.tensor(t, d, dims),
        );

        for (let r = 0; r < request.regions.length; r++) {
          const regionBox = request.regions[r];
          if (!regionBox) continue;
          const imgX = Math.max(0, Math.floor(regionBox.x * decoded.scale));
          const imgY = Math.max(0, Math.floor(regionBox.y * decoded.scale));
          const imgW = Math.min(decoded.width - imgX, Math.ceil(regionBox.w * decoded.scale));
          const imgH = Math.min(decoded.height - imgY, Math.ceil(regionBox.h * decoded.scale));

          if (imgW < 8 || imgH < 8) continue;

          const canvas = new OffscreenCanvas(imgW, imgH);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;

          ctx.drawImage(
            decoded.bitmap as unknown as CanvasImageSource,
            imgX,
            imgY,
            imgW,
            imgH,
            0,
            0,
            imgW,
            imgH,
          );

          const imgData = ctx.getImageData(0, 0, imgW, imgH);
          const pixelHash = await hashBytes(imgData.data);
          const cached = ocrCache.get(pixelHash, Date.now());
          if (cached) {
            allLines.push(
              ...linesToViewport(
                cached,
                { region: r, box: regionBox, reason: 'cached' },
                decoded.scale,
              ),
            );
            continue;
          }

          const lines = await runner(imgData, r);
          ocrCache.set(pixelHash, lines, Date.now());
          allLines.push(
            ...linesToViewport(
              lines,
              { region: r, box: regionBox, reason: 'inference' },
              decoded.scale,
            ),
          );
        }
      });
    });

    return { task: 'ocr', lines: allLines };
  } finally {
    decoded.bitmap.close();
  }
}

export function installInferenceHandlers(runtime: OrtRuntime, sealDeps?: SealDeps): void {
  handle('INFER', async (request): Promise<InferResult> => {
    if (request.task === 'face') return runFace(request, runtime);
    if (request.task === 'ocr') return runOcr(request, runtime);

    if (request.task !== 'ner') {
      throw new Error(`not implemented: ${(request as InferRequest).task} task. The host itself is ready.`);
    }

    const assets = await nerAssets(runtime);
    const host = ensureHost(runtime);

    const spans = await host.withTask('ner', async (session) => {
      const run = createNerRunner(session, assets, (t, d, dims) => runtime.tensor(t, d, dims));
      const out: NerSpan[][] = [];
      for (const text of request.texts) {
        // Sequentially, on purpose. The registry hands out one session per task, and
        // two concurrent runs on one session is how ORT produces garbage rather than an
        // error.
        const found = await run(text);
        out.push(
          found.flatMap((span) => {
            const cls = classForLabel(span.label);
            return cls ? [{ start: span.start, end: span.end, cls, score: span.score }] : [];
          }),
        );
      }
      return out;
    });

    return { task: 'ner', spans };
  });

  handle('HOST_STATS', (): HostStats => {
    // Deliberately does not create a host: asking for stats must not load a GPU
    // context. Before the first inference the honest answer is 'none', and the popup
    // and the M10 HUD both depend on getting it.
    if (!host) return { backend: 'none', residentBytes: 0, loaded: [], timings: {} };
    return host.stats();
  });

  handle('HOST_UNLOAD', async ({ task }) => {
    if (!host) return { freedBytes: 0 };
    return { freedBytes: await host.unload(task) };
  });

  handle('SELF_TEST', async (): Promise<SelfTestResult> => {
    return runSmokeTest(ensureHost(runtime));
  });

  handle('PLACEHOLDER_RESOLVE', ({ sessionId, placeholder }) => {
    const outcome = resolvePlaceholder(sessionId, placeholder);
    if (outcome.ok) return { value: outcome.value };
    return { reason: outcome.reason };
  });

  handle('PLACEHOLDER_ALLOCATE', ({ sessionId, items }) => {
    const allocator = allocatorFor(sessionId);
    const placeholders: Record<string, string> = {};

    // Which of the returned tokens stand for something the operator typed themselves.
    //
    // The allocator is the only thing that can answer this: provenance belongs to the
    // token, not to the sighting, so a value first seen in the task box and later found on
    // the page comes back the same token and keeps the claim. Reported per id so the
    // caller can mark its findings without holding any values of its own.
    const fromUser: string[] = [];

    for (const item of items) {
      if (item.value === '') continue;
      // SECRET is deliberately unnumbered and unallocated (invariant 6): its token
      // resolves to nothing, and the value comes from the vault after a user confirm.
      if (!policyFor(item.cls).numbered) continue;
      const token = allocator.allocate(item.cls, item.value, item.fromUser === true);
      placeholders[item.id] = token;
      if (allocator.isFromUser(token)) fromUser.push(item.id);
    }
    return { placeholders, fromUser };
  });

  handle('PANEL_LIST', () => ({ steps: listSteps() }));

  handle('PANEL_STEP', ({ stepIndex }) => {
    const step = getStep(stepIndex);
    if (!step) return { found: false as const };
    return {
      found: true as const,
      preGate: step.preGate,
      sentUrl: step.sentUrl,
      sentMime: step.sentMime,
      manifest: step.manifest,
      capture: step.capture,
    };
  });

  handle('PANEL_CLEAR', () => ({ dropped: clearPanel() }));

  handle('SEAL_AND_ENCODE', async (request) => {
    return sealAndEncode(request, sealDeps ?? { store: createFrameStore() });
  });
}
