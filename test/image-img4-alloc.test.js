import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jpegEncode from '../src/vendor/jpeg-js/encoder.js';

const source = readFileSync(new URL('../src/image.js', import.meta.url), 'utf8');
const first = 'function scaleRGBA(';
const last = '\n// Real pixel downscale + JPEG re-encode.';
assert.equal(source.split(first).length, 2);
assert.equal(source.split(last).length, 2);
const scaleText = source.slice(source.indexOf(first), source.indexOf(last)).trimEnd();
function compileScale(bufferApi = Buffer) {
  return new Function('Buffer', `${scaleText}\nreturn scaleRGBA;`)(bufferApi);
}

// Frozen from 014204f; the function name alone is changed for the oracle.
function referenceScaleRGBA(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  // Map dst pixel centers back into src space.
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = (dy + 0.5) * yRatio - 0.5;
    let y0 = Math.floor(sy);
    const wy = sy - y0;
    if (y0 < 0) y0 = 0;
    const y1 = Math.min(y0 + 1, srcH - 1);
    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx + 0.5) * xRatio - 0.5;
      let x0 = Math.floor(sx);
      const wx = sx - x0;
      if (x0 < 0) x0 = 0;
      const x1 = Math.min(x0 + 1, srcW - 1);
      const o = (dy * dstW + dx) * 4;
      const i00 = (y0 * srcW + x0) * 4;
      const i01 = (y0 * srcW + x1) * 4;
      const i10 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bot = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        out[o + c] = (top * (1 - wy) + bot * wy + 0.5) | 0;
      }
    }
  }
  return out;
}

function pixels(width, height) {
  const out = Buffer.alloc(width * height * 4);
  let seed = 0x2468ace1;
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out[i] = seed >>> 24;
  }
  return out;
}

test('IMG-4: the scaler allocates uninitialized storage once and overwrites poison', () => {
  for (const poison of [0, 0xa5, 0xff]) {
    let safeAllocations = 0;
    let unsafeAllocations = 0;
    const api = {
      alloc(size) { safeAllocations++; return Buffer.alloc(size); },
      allocUnsafe(size) { unsafeAllocations++; return Buffer.alloc(size, poison); },
    };
    const input = pixels(19, 11);
    const expected = referenceScaleRGBA(input, 19, 11, 7, 5);
    const actual = compileScale(api)(input, 19, 11, 7, 5);
    assert.deepEqual(actual, expected);
    assert.equal(unsafeAllocations, 1);
    assert.equal(safeAllocations, 0, 'an explicit zero-fill is redundant before full overwrite');
  }
});

test('IMG-4: all RGBA bytes match at odd sizes, one-pixel sides and transparent pixels', () => {
  const scale = compileScale();
  for (const [srcW, srcH, dstW, dstH] of [
    [1, 1, 1, 1], [1, 19, 1, 7], [19, 1, 7, 1], [2, 2, 1, 1],
    [19, 11, 7, 5], [17, 31, 3, 9], [65, 33, 64, 32], [157, 89, 128, 73],
  ]) {
    const input = pixels(srcW, srcH);
    for (let i = 3; i < input.length; i += 8) input[i] = 0;
    const copy = Buffer.from(input);
    for (const data of [input, new Uint8Array(input)]) {
      const expected = referenceScaleRGBA(data, srcW, srcH, dstW, dstH);
      const actual = scale(data, srcW, srcH, dstW, dstH);
      assert.equal(actual.length, dstW * dstH * 4);
      assert.deepEqual(actual, expected);
      assert.deepEqual(Buffer.from(data), copy, 'the input must not be overwritten');
    }
  }
});

test('IMG-4: the real encoder sees byte-identical RGBA at every calibrated quality', () => {
  const input = pixels(157, 89);
  const before = referenceScaleRGBA(input, 157, 89, 128, 73);
  const after = compileScale()(input, 157, 89, 128, 73);
  for (const quality of [85, 75, 65, 60]) {
    const oldJpeg = jpegEncode({ data: before, width: 128, height: 73 }, quality).data;
    const newJpeg = jpegEncode({ data: after, width: 128, height: 73 }, quality).data;
    assert.deepEqual(newJpeg, oldJpeg);
    assert.equal(newJpeg.toString('base64'), oldJpeg.toString('base64'));
  }
});
