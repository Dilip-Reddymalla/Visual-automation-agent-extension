/**
 * The worker's independent verification of the gate's receipt (CLAUDE.md invariant 1).
 *
 * Recomputes SHA-256 over the bytes about to be sent and the digest over the
 * canonicalised manifest, and compares both against the receipt. A mismatch is not a
 * warning: the step fails and nothing leaves the device.
 *
 * "Independent" is the whole value. The gate already refuses to encode an unsealed
 * canvas, but that check runs inside the module it is protecting -- one disabled lint
 * rule, one refactor, one caching layer between seal and encode, and it protects
 * nothing. This check runs in a different process, over the bytes as they actually are
 * at the moment of transmission, and it does not care how they got there.
 *
 * Node-pure: bytes in, verdict out.
 */

import { canonicaliseFindings, digest, manifestDigest } from '../redaction/gate';
import type { Manifest } from '../shared/contract';

export interface VerificationResult {
  ok: boolean;
  /** Machine-readable reason on failure, e.g. "image-digest-mismatch". */
  reason?: string;
  /** What was expected and what was found, for the step log. Never the bytes. */
  detail?: { expected: string; actual: string };
}

export async function verifyReceipt(
  bytes: Uint8Array,
  manifest: Manifest,
): Promise<VerificationResult> {
  const receipt = manifest.receipt;

  if (receipt.algo !== 'SHA-256') {
    return { ok: false, reason: 'unknown-digest-algorithm' };
  }
  if (!receipt.hash) {
    // seal() leaves this empty and encode() fills it. An empty hash here means the
    // payload never went through encode at all.
    return { ok: false, reason: 'receipt-not-completed' };
  }

  const actualImage = await digest(bytes);
  if (actualImage !== receipt.hash) {
    return {
      ok: false,
      reason: 'image-digest-mismatch',
      detail: { expected: receipt.hash, actual: actualImage },
    };
  }

  const actualManifest = await manifestDigest(withoutReceipt(manifest));
  if (actualManifest !== receipt.manifestHash) {
    return {
      ok: false,
      reason: 'manifest-digest-mismatch',
      detail: { expected: receipt.manifestHash, actual: actualManifest },
    };
  }

  return { ok: true };
}

/**
 * Stable serialisation of a manifest, so two processes hash the same string.
 *
 * The receipt is excluded, necessarily: it contains the hash of this very string, and
 * including it would be asking for a fixed point.
 */
export function canonicalise(manifest: Manifest): string {
  return canonicaliseFindings(withoutReceipt(manifest));
}

function withoutReceipt(manifest: Manifest): Omit<Manifest, 'receipt'> {
  const { receipt: _receipt, ...rest } = manifest;
  return rest;
}
