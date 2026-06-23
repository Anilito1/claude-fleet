// Generates resources/icon.png (128x128) with a hand-rolled PNG encoder.
// No external deps — uses zlib for the IDAT stream.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 128;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

const px = Buffer.alloc(SIZE * SIZE * 4);
const cx = SIZE / 2, cy = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    // rounded-square dark background
    const r = 26;
    const inside =
      x > r - 1 && x < SIZE - r && y > r - 1 && y < SIZE - r
        ? 1
        : roundedAlpha(x, y, SIZE, r);
    let R = 16, G = 18, B = 24, A = 255 * inside;

    // radial orb gradient (coral -> indigo)
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) / (SIZE * 0.5);
    if (d < 0.74) {
      const t = Math.min(1, d / 0.74);
      const orbR = mix(232, 110, t);
      const orbG = mix(140, 150, t);
      const orbB = mix(96, 240, t);
      const glow = Math.pow(1 - t, 1.4);
      R = mix(R, orbR, glow);
      G = mix(G, orbG, glow);
      B = mix(B, orbB, glow);
    }
    // outer ring
    if (d > 0.62 && d < 0.7) {
      const ring = 1 - Math.abs(d - 0.66) / 0.04;
      R = mix(R, 255, ring * 0.5);
      G = mix(G, 235, ring * 0.5);
      B = mix(B, 220, ring * 0.5);
    }
    px[i] = clamp(R);
    px[i + 1] = clamp(G);
    px[i + 2] = clamp(B);
    px[i + 3] = clamp(A);
  }
}

function roundedAlpha(x, y, size, r) {
  const corners = [
    [r, r],
    [size - r, r],
    [r, size - r],
    [size - r, size - r],
  ];
  const nearLeft = x < r, nearRight = x >= size - r, nearTop = y < r, nearBot = y >= size - r;
  if ((nearLeft || nearRight) && (nearTop || nearBot)) {
    const c = corners[(nearBot ? 2 : 0) + (nearRight ? 1 : 0)];
    const d = Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2);
    return d <= r ? 1 : Math.max(0, 1 - (d - r));
  }
  return 1;
}
function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// add filter byte (0) per scanline
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "resources", "icon.png");
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
