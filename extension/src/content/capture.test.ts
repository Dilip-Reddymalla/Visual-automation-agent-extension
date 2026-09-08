import { describe, it, expect } from 'vitest';
import { measure, currentToken, type CaptureEnv } from './capture';
import { tokenDrift, tokensMatch } from '../shared/frames';
import { captureScale, viewportBox } from '../shared/coords';

/** A 1x laptop, nothing scrolled, nothing zoomed. */
function env(overrides: Partial<CaptureEnv> = {}): CaptureEnv {
  return {
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
    visualViewport: { width: 1280, height: 720, offsetLeft: 0, offsetTop: 0, scale: 1 },
    documentHeight: 3000,
    mutationSeq: 0,
    ...overrides,
  };
}

describe('the scale that goes with a capture', () => {
  it('is 1 on an ordinary display', () => {
    expect(measure(env()).scale).toBe(1);
  });

  it('follows devicePixelRatio, because captureVisibleTab does', () => {
    // The bug this module exists to prevent: a 2x display returns a 2560px-wide frame
    // while getBoundingClientRect still says 1280. Mix them and every redaction box
    // lands at half its intended position.
    expect(measure(env({ devicePixelRatio: 2 })).scale).toBe(2);
    expect(measure(env({ devicePixelRatio: 1.5 })).scale).toBe(1.5);
  });

  it('accounts for pinch-zoom on top of the device ratio', () => {
    const pinched = env({
      devicePixelRatio: 2,
      visualViewport: { width: 640, height: 360, offsetLeft: 100, offsetTop: 50, scale: 2 },
    });
    expect(measure(pinched).scale).toBe(4);
  });

  it('falls back to the layout viewport where visualViewport does not exist', () => {
    const old = measure(env({ visualViewport: undefined, devicePixelRatio: 2 }));
    expect(old.viewport).toEqual({ w: 1280, h: 720 });
    expect(old.scale).toBe(2);
    expect(old.offsetX).toBe(0);
  });
});

describe('the visual viewport', () => {
  it('reports the visible window, not the layout window, when pinched', () => {
    const pinched = measure(
      env({
        visualViewport: { width: 640, height: 360, offsetLeft: 100, offsetTop: 50, scale: 2 },
      }),
    );
    expect(pinched.viewport).toEqual({ w: 640, h: 360 });
    expect(pinched.offsetX).toBe(100);
    expect(pinched.offsetY).toBe(50);
  });

  it('offsets are zero on an unpinched page, which is nearly always', () => {
    const flat = measure(env({ scrollX: 0, scrollY: 4000 }));
    expect(flat.offsetX).toBe(0);
    expect(flat.offsetY).toBe(0);
  });

  it('turns a layout rect into a visual one', () => {
    const g = measure(
      env({
        visualViewport: { width: 640, height: 360, offsetLeft: 100, offsetTop: 50, scale: 2 },
      }),
    );
    // getBoundingClientRect said the button is at (300, 200) of the layout viewport.
    expect(viewportBox({ x: 300, y: 200, w: 80, h: 30 }, g.offsetX, g.offsetY)).toEqual({
      x: 200,
      y: 150,
      w: 80,
      h: 30,
    });
  });
});

describe('the generation token', () => {
  it('matches itself', () => {
    expect(tokensMatch(currentToken(env()), currentToken(env()))).toBe(true);
  });

  it('notices a scroll', () => {
    const before = currentToken(env());
    const after = currentToken(env({ scrollY: 40 }));
    expect(tokensMatch(before, after)).toBe(false);
    expect(tokenDrift(before, after)).toEqual(['scrollY 0 -> 40']);
  });

  it('notices a reflow that moved nothing else', () => {
    // A lazy image landing below the fold: same scroll, same everything, taller page.
    const before = currentToken(env());
    const after = currentToken(env({ documentHeight: 3400 }));
    expect(tokensMatch(before, after)).toBe(false);
    expect(tokenDrift(before, after)).toEqual(['docHeight 3000 -> 3400']);
  });

  it('notices a DOM change that moved nothing at all', () => {
    // Same size, same position, different content: the element list is still stale.
    const before = currentToken(env({ mutationSeq: 4 }));
    const after = currentToken(env({ mutationSeq: 5 }));
    expect(tokensMatch(before, after)).toBe(false);
  });

  it('notices a pinch', () => {
    const before = currentToken(env());
    const after = currentToken(
      env({
        visualViewport: { width: 640, height: 360, offsetLeft: 20, offsetTop: 0, scale: 2 },
      }),
    );
    expect(tokensMatch(before, after)).toBe(false);
    expect(tokenDrift(before, after)).toContain('vvScale 1 -> 2');
  });

  it('notices the window moving to a different display', () => {
    const before = currentToken(env({ devicePixelRatio: 2 }));
    const after = currentToken(env({ devicePixelRatio: 1 }));
    expect(tokensMatch(before, after)).toBe(false);
  });

  it('lists everything that moved, not just the first thing', () => {
    const before = currentToken(env());
    const after = currentToken(env({ scrollY: 40, mutationSeq: 3, documentHeight: 3200 }));
    expect(tokenDrift(before, after)).toHaveLength(3);
  });
});

describe('end to end, on paper', () => {
  /**
   * The alignment arithmetic, all the way through: a rect from
   * getBoundingClientRect, on a 2x display, on a page that has been pinched, ending as
   * pixels in a downscaled frame. Every step here is a place the DPR factor could be
   * applied twice or not at all.
   */
  it('puts a CSS rect on the right pixels of the downscaled frame', () => {
    const g = measure(
      env({
        devicePixelRatio: 2,
        visualViewport: { width: 640, height: 360, offsetLeft: 100, offsetTop: 50, scale: 2 },
      }),
    );

    // The full frame would be 640x360 CSS px at scale 4 = 2560x1440 image px,
    // downscaled to a 1024 long edge.
    const frameWidth = 1024;
    const scale = captureScale(frameWidth, g.viewport.w); // 1024 / 640 = 1.6

    const layoutRect = { x: 300, y: 200, w: 80, h: 30 };
    const visual = viewportBox(layoutRect, g.offsetX, g.offsetY);
    const image = {
      x: visual.x * scale,
      y: visual.y * scale,
      w: visual.w * scale,
      h: visual.h * scale,
    };

    expect(scale).toBeCloseTo(1.6, 6);
    expect(image).toEqual({ x: 320, y: 240, w: 128, h: 48 });
  });
});
