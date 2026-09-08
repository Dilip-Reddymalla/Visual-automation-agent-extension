import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDER_CLASSES,
  PlaceholderAllocator,
  extractPlaceholders,
  formatPlaceholder,
  isPlaceholderClass,
  parsePlaceholder,
} from './placeholders';

describe('the frozen vocabulary', () => {
  it('is exactly the seventeen classes in CLAUDE.md', () => {
    expect([...PLACEHOLDER_CLASSES]).toEqual([
      'PERSON',
      'ADDRESS',
      'EMAIL',
      'PHONE',
      'DOB',
      'AADHAAR',
      'PAN',
      'GSTIN',
      'IFSC',
      'UPI',
      'ACCOUNT',
      'CARD',
      'PASSPORT',
      'LICENCE',
      'ORG',
      'SECRET',
      // L3, added in M5c-A. Invariant 5 says the vocabulary, the contract, the server
      // prompt, the eval harness and the label tool move together, and this list is one
      // of the five things that refused the change until they had.
      'FACE',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(PLACEHOLDER_CLASSES).size).toBe(PLACEHOLDER_CLASSES.length);
  });

  it('recognises members and rejects invented classes', () => {
    expect(isPlaceholderClass('AADHAAR')).toBe(true);
    expect(isPlaceholderClass('PINCODE')).toBe(false);
  });
});

describe('format / parse', () => {
  it('round-trips', () => {
    expect(parsePlaceholder(formatPlaceholder('PERSON', 3))).toEqual({
      cls: 'PERSON',
      index: 3,
    });
  });

  it('uses guillemets', () => {
    expect(formatPlaceholder('EMAIL', 1)).toBe('«EMAIL_1»');
  });

  it('rejects index 0 and non-integers', () => {
    expect(() => formatPlaceholder('PERSON', 0)).toThrow(RangeError);
    expect(() => formatPlaceholder('PERSON', 1.5)).toThrow(RangeError);
  });

  it('returns null for near-misses', () => {
    expect(parsePlaceholder('«PINCODE_1»')).toBeNull();
    expect(parsePlaceholder('PERSON_1')).toBeNull();
    expect(parsePlaceholder('«PERSON_0»')).toBeNull();
    expect(parsePlaceholder('«PERSON_1» trailing')).toBeNull();
  });

  it('extracts placeholders from prose, skipping unknown classes', () => {
    const text = 'pay «PERSON_2» at «UPI_1», not «WIDGET_9»';
    expect(extractPlaceholders(text)).toEqual(['«PERSON_2»', '«UPI_1»']);
  });
});

describe('PlaceholderAllocator', () => {
  it('numbers per class from 1', () => {
    const a = new PlaceholderAllocator('s1');
    expect(a.allocate('PERSON', 'Asha Menon')).toBe('«PERSON_1»');
    expect(a.allocate('PERSON', 'R. Iyer')).toBe('«PERSON_2»');
    expect(a.allocate('EMAIL', 'asha@example.in')).toBe('«EMAIL_1»');
  });

  it('is stable across steps -- the same value returns the same placeholder', () => {
    const a = new PlaceholderAllocator('s1');
    const step2 = a.allocate('PERSON', 'Asha Menon');
    a.allocate('PERSON', 'someone else');
    a.allocate('ORG', 'UIDAI');
    const step9 = a.allocate('PERSON', 'Asha Menon');
    expect(step9).toBe(step2);
    expect(a.count('PERSON')).toBe(2);
  });

  it('keeps identical strings in different classes apart', () => {
    const a = new PlaceholderAllocator('s1');
    expect(a.allocate('ORG', 'Axis')).toBe('«ORG_1»');
    expect(a.allocate('PERSON', 'Axis')).toBe('«PERSON_1»');
  });

  it('resolves what it issued', () => {
    const a = new PlaceholderAllocator('s1');
    const p = a.allocate('AADHAAR', '2345 6789 0123');
    expect(a.resolve(p)).toBe('2345 6789 0123');
  });

  it('returns undefined for a placeholder the planner invented', () => {
    const a = new PlaceholderAllocator('s1');
    a.allocate('PERSON', 'Asha Menon');
    expect(a.resolve('«PERSON_7»')).toBeUndefined();
    expect(a.resolve('«SECRET_1»')).toBeUndefined();
  });

  it('numbers independently per session', () => {
    const a = new PlaceholderAllocator('s1');
    const b = new PlaceholderAllocator('s2');
    a.allocate('PHONE', '+91 98765 43210');
    expect(b.allocate('PHONE', 'a different number')).toBe('«PHONE_1»');
  });

  it('for SECRET stores a vault key, never a plaintext secret', () => {
    const a = new PlaceholderAllocator('s1');
    const p = a.allocate('SECRET', 'vault://login-password');
    expect(p).toBe('«SECRET_1»');
    expect(a.resolve(p)).toBe('vault://login-password');
    expect(JSON.stringify(a)).not.toContain('vault://');
  });

  it('does not serialise its map', () => {
    const a = new PlaceholderAllocator('s1');
    a.allocate('PERSON', 'Asha Menon');
    expect(JSON.stringify(a)).not.toContain('Asha');
    expect(Object.keys(a)).toEqual(['sessionId']);
  });

  it('rejects an unknown class at runtime', () => {
    const a = new PlaceholderAllocator('s1');
    // @ts-expect-error the type system already forbids this; the guard is for wire data
    expect(() => a.allocate('PINCODE', 'x')).toThrow(TypeError);
  });
});

/**
 * A face has no value, and nothing may pretend otherwise.
 *
 * Every other class stands for a string the device can put back: «EMAIL_1» is typed into
 * a field and becomes an address again. There is no string a planner could emit that
 * should turn back into a photograph, so FACE must have no token at all -- not an
 * unresolvable one, which would still be a token in the manifest for a planner to try.
 *
 * Asserted rather than left implied, because "never" is not a convention.
 */
describe('FACE cannot be a placeholder', () => {
  it('refuses to allocate one', () => {
    const allocator = new PlaceholderAllocator('s1');
    expect(() => allocator.allocate('FACE', 'anything')).toThrow(/cannot be allocated/);
  });

  it('issues no token, so there is none to resolve', () => {
    const allocator = new PlaceholderAllocator('s1');
    try {
      allocator.allocate('FACE', 'anything');
    } catch {
      // Expected. The point is what the allocator holds afterwards.
    }
    expect(allocator.count('FACE')).toBe(0);
    expect(allocator.resolve('«FACE_1»')).toBeUndefined();
  });

  /**
   * SECRET is also unnumbered and is *not* refused, and the difference is load-bearing:
   * it holds a vault key, which `resolve` returns and the executor exchanges for the
   * credential after a user confirm. Collapsing the two would break the vault.
   */
  it('does not refuse SECRET, which does have a value to hold', () => {
    const allocator = new PlaceholderAllocator('s1');
    const token = allocator.allocate('SECRET', 'vault-key-7');
    expect(allocator.resolve(token)).toBe('vault-key-7');
  });
});
