/*
 * Generates the PNG icon set: a red rounded square with a white check mark,
 * matching the WATCHED badge drawn on YouTube thumbnails.
 *
 *   node tools/make-icons.mjs
 *
 * Writes icons/icon-{16,32,48,128}.png. Pure Node (zlib only), no image
 * libraries, so the icons are reproducible anywhere.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const BACKGROUND = [0xcc, 0x00, 0x00]; // --accent
const FOREGROUND = [0xff, 0xff, 0xff];

// Check mark polyline and stroke width, in a 0..1 coordinate space.
const CHECK = [
  [0.27, 0.53],
  [0.44, 0.70],
  [0.75, 0.33],
];
const THICKNESS = 0.115;

const CORNER_RADIUS = 0.22; // fraction of the icon size
const SUPERSAMPLE = 4;

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- drawing ---- */

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToCheck(px, py) {
  let best = Infinity;
  for (let i = 0; i < CHECK.length - 1; i += 1) {
    best = Math.min(best, distanceToSegment(px, py, ...CHECK[i], ...CHECK[i + 1]));
  }
  return best;
}

/** Signed distance to a centred rounded square; negative means inside. */
function roundedSquare(px, py, half, radius) {
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  return outside;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      let onCheck = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) / size;
          if (roundedSquare(px, py, 0.5, CORNER_RADIUS) > 0) continue;
          inside += 1;
          if (distanceToCheck(px, py) <= THICKNESS / 2) onCheck += 1;
        }
      }

      const ratio = inside === 0 ? 0 : onCheck / inside;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(BACKGROUND[0] + (FOREGROUND[0] - BACKGROUND[0]) * ratio);
      rgba[i + 1] = Math.round(BACKGROUND[1] + (FOREGROUND[1] - BACKGROUND[1]) * ratio);
      rgba[i + 2] = Math.round(BACKGROUND[2] + (FOREGROUND[2] - BACKGROUND[2]) * ratio);
      rgba[i + 3] = Math.round((inside / samples) * 255);
    }
  }

  return rgba;
}

/** Terminal preview so the shape can be eyeballed without opening a file. */
function preview(size) {
  const rgba = render(size);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    let row = '';
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const alpha = rgba[i + 3];
      if (alpha < 128) row += ' ';
      else row += rgba[i + 1] > 128 ? '#' : '.'; // green: near 255 = check, 0 = red
    }
    rows.push(row);
  }
  return rows.join('\n');
}

/* ------------------------------------------------------------------ main ---- */

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote icons/icon-${size}.png`);
}

const previewSize = Number(process.argv[2] || 32);
console.log(`\n${previewSize}px preview (# = check mark, . = red):\n`);
console.log(preview(previewSize));
