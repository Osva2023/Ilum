/**
 * Generates a 22x22 template PNG of a simple shield silhouette at tray/icon.png.
 *
 * Pure Node — no external deps. Built so `npm install` inside tray/ can produce
 * the icon without needing to ship a binary in the repo.
 *
 * The image is a black filled shield on a transparent background, suitable for
 * use as a macOS template image (Electron: nativeImage.setTemplateImage(true)).
 * macOS recolors template images automatically for light/dark menu bars.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const WIDTH = 22;
const HEIGHT = 22;
const OUT = path.join(__dirname, "icon.png");

if (fs.existsSync(OUT) && !process.env.FORCE_REBUILD_ICON) {
  process.exit(0);
}

// ─── shield mask ─────────────────────────────────────────────────────────────
// 22x22 boolean grid where true = filled pixel. The shape is a classic
// heraldic shield: flat top, sides curve in toward a rounded point.

function shieldMask(w, h) {
  const mask = new Array(w * h).fill(false);
  const cx = (w - 1) / 2;

  for (let y = 0; y < h; y++) {
    // Vertical fraction 0..1 from top to bottom.
    const t = y / (h - 1);

    // Half-width of the shield at this row.
    // Top is wide (full), shoulders curve in slightly, then taper to a point.
    let halfW;
    if (t < 0.15) {
      halfW = (w - 2) / 2;                       // flat top, 1px inset
    } else if (t < 0.55) {
      halfW = (w - 2) / 2 * (1 - (t - 0.15) * 0.15);  // gentle shoulder taper
    } else {
      // Lower half tapers to a point with a slight curve.
      const u = (t - 0.55) / 0.45;
      halfW = (w - 2) / 2 * (1 - u * u);
    }

    for (let x = 0; x < w; x++) {
      if (Math.abs(x - cx) <= halfW) {
        mask[y * w + x] = true;
      }
    }
  }
  return mask;
}

// ─── PNG encoder (RGBA, no filter) ───────────────────────────────────────────

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());

  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Add filter byte (0 = none) at the start of each scanline.
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idat = zlib.deflateSync(filtered);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── build pixel buffer ──────────────────────────────────────────────────────

const mask = shieldMask(WIDTH, HEIGHT);
const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);

for (let i = 0; i < mask.length; i++) {
  const off = i * 4;
  if (mask[i]) {
    rgba[off] = 0;        // R
    rgba[off + 1] = 0;    // G
    rgba[off + 2] = 0;    // B
    rgba[off + 3] = 255;  // A — fully opaque black
  }
  // Else: 0,0,0,0 (transparent), already zeroed by Buffer.alloc.
}

fs.writeFileSync(OUT, encodePNG(WIDTH, HEIGHT, rgba));
console.log(`[tray] wrote ${OUT} (${WIDTH}x${HEIGHT})`);
