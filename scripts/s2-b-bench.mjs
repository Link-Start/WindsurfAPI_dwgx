import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import { StreamingFrameParser } from '../src/connect.js';
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

// Frozen 014204f parser, not a reimplementation of its benchmark result.
class BeforeParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  /** Drain all complete frames. Returns [{ flags, isEndStream, payload }]. */
  drain() {
    // Guard against malformed upstream frames that advertise absurd lengths —
    // without this, Buffer.concat() will happily try to allocate gigabytes.
    const frames = [];
    while (this.buffer.length >= 5) {
      const len = this.buffer.readUInt32BE(1);
      if (len > MAX_FRAME_SIZE) {
        throw new Error(`HTTP/2 frame size ${len} exceeds ${MAX_FRAME_SIZE}`);
      }
      if (this.buffer.length < 5 + len) break;

      const flags = this.buffer[0];
      let payload = this.buffer.subarray(5, 5 + len);
      if (flags & 0x01) {
        // Bound the DECOMPRESSED size too: a high-ratio gzip frame that passes the
        // ≤16MB wire-length check above can still inflate to gigabytes. Without
        // maxOutputLength, gunzipSync accumulates up to kMaxLength (~2GB) and on a
        // memory-constrained host the OOM-killer can reap the process before the
        // throw below is caught (audit CONN-1).
        try { payload = gunzipSync(payload, { maxOutputLength: MAX_FRAME_SIZE }); }
        catch (err) {
          // Don't silently drop a frame whose body we couldn't decompress —
          // upstream is sending something we don't understand and the caller
          // needs to know so the stream can be cancelled rather than continued
          // with missing data.
          throw new Error(`Connect frame decompression failed: ${err.message}`);
        }
      }

      frames.push({
        flags,
        isEndStream: !!(flags & 0x02),
        payload,
      });
      this.buffer = this.buffer.subarray(5 + len);
    }
    return frames;
  }
}


const samples = Number(process.argv[2] || 3);
assert.ok(Number.isInteger(samples) && samples > 0, 'Pass a positive sample count');
console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, platform: process.platform,
  arch: process.arch, cpu: os.cpus()[0]?.model, samples, gc_exposed: !!global.gc }));
let sink = 0;
for (const mib of [1, 2, 4]) {
  // Includes the five-byte header: the 4 MiB case is exactly 256 x 16 KiB chunks.
  const frame = Buffer.alloc(mib * 1024 * 1024, 0x61);
  frame[0] = 0; frame.writeUInt32BE(frame.length - 5, 1);
  for (const chunkBytes of [frame.length, 16 * 1024]) {
    const chunks = [];
    for (let i = 0; i < frame.length; i += chunkBytes) chunks.push(frame.subarray(i, i + chunkBytes));
    for (const [implementation, Parser] of [['before', BeforeParser], ['candidate', StreamingFrameParser]]) {
      const validate = new Parser(); let decoded = [];
      for (const chunk of chunks) { validate.push(chunk); decoded.push(...validate.drain()); }
      assert.equal(decoded.length, 1); assert.deepEqual(decoded[0].payload, frame.subarray(5));
      const once = () => {
        const parser = new Parser(); let count = 0, length = 0;
        for (const chunk of chunks) {
          parser.push(chunk);
          for (const out of parser.drain()) { count++; length += out.payload.length; sink ^= out.payload[0]; }
        }
        if (count !== 1 || length !== frame.length - 5) throw new Error('Benchmark parser output changed');
      };
      once();
      const samples_ms = [];
      for (let i = 0; i < samples; i++) {
        global.gc?.(); const start = performance.now(); once(); samples_ms.push(performance.now() - start);
      }
      const sorted = [...samples_ms].sort((a, b) => a - b);
      console.log(JSON.stringify({ implementation, frame_bytes: frame.length, chunk_bytes: chunkBytes,
        chunks: chunks.length, samples_ms, median_ms: sorted[Math.floor(sorted.length / 2)] }));
    }
  }
}
console.log(JSON.stringify({ sink }));
