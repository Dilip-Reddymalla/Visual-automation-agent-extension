import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs build script, deliberately not part of the TS project.
import { countEncoders, isFirstParty, vendorAllows } from './test-gate.mjs';

/**
 * The vendor exemption added in M2 narrows invariant 1, so it gets tested like the
 * invariant it is. The failure this guards against is the exemption quietly widening:
 * a rule that lets ORT keep `toDataURL` must not also let it acquire `toBlob`, and it
 * must never cover a file of ours.
 */

const ORT = 'node_modules/onnxruntime-web/dist/ort.min.mjs';

describe('first-party attribution', () => {
  it('claims our own modules', () => {
    expect(isFirstParty('extension/src/redaction/gate.ts')).toBe(true);
    expect(isFirstParty('extension/src/offscreen/runtime-ort.ts')).toBe(true);
  });

  it('does not claim vendored ones', () => {
    expect(isFirstParty(ORT)).toBe(false);
    expect(isFirstParty('node_modules/anything/index.js')).toBe(false);
  });
});

describe('counting hits', () => {
  it('counts occurrences, not lines', () => {
    // ORT really does have a line with two calls on it. Counting lines would let a
    // third be added to that line without the pinned total moving.
    expect(countEncoders('if ("toDataURL" in n) return n.toDataURL();')).toBe(2);
    expect(countEncoders('toDataURL(t) {')).toBe(1);
    expect(countEncoders('nothing here')).toBe(0);
  });

  it('counts each encoder identifier', () => {
    expect(countEncoders('a.toBlob(); b.convertToBlob(); c.toDataURL();')).toBe(3);
  });

  it('does not count a longer identifier that merely contains one', () => {
    expect(countEncoders('myToBlobHelper()')).toBe(0);
  });
});

describe('the pinned vendor exemption', () => {
  it('allows exactly the identifier it was pinned for', () => {
    expect(vendorAllows(ORT, 'toDataURL(t) {')).toBe(true);
    expect(vendorAllows(ORT, 'if ("toDataURL" in n) return n.toDataURL();')).toBe(true);
  });

  it('refuses an encoder the rule does not name, in the same file', () => {
    expect(vendorAllows(ORT, 'canvas.toBlob(cb);')).toBe(false);
    expect(vendorAllows(ORT, 'offscreen.convertToBlob();')).toBe(false);
  });

  it('refuses a line that mixes an allowed encoder with a disallowed one', () => {
    expect(vendorAllows(ORT, 'x.toDataURL(); y.toBlob();')).toBe(false);
  });

  it('refuses any vendor module that was never pinned', () => {
    expect(vendorAllows('node_modules/some-lib/dist/index.js', 'c.toDataURL()')).toBe(false);
  });

  it('never exempts our own code, whatever the line says', () => {
    // Belt and braces: the scanner checks isFirstParty before asking, and the answer
    // here is false anyway.
    expect(vendorAllows('extension/src/content/capture.ts', 'c.toDataURL()')).toBe(false);
  });
});
