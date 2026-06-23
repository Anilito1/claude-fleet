// Generates resources/activity.png — a simple white "network" glyph (no SVG, transparent bg).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 48;
const px = Buffer.alloc(S * S * 4); // RGBA, transparent

function setPx(x, y, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  if (a <= px[i + 3]) return; // keep max alpha
  px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = a;
}
function disc(cx, cy, r) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) setPx(x, y, 255);
      else if (d <= r + 1) setPx(x, y, Math.round(255 * (r + 1 - d)));
    }
}
function seg(x1, y1, x2, y2, w) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, w / 2);
  }
}

// links first, then nodes on top
seg(24, 13, 12, 35, 2.4);
seg(24, 13, 36, 35, 2.4);
disc(24, 12, 5.2);
disc(12, 36, 4.2);
disc(36, 36, 4.2);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const idat = zlib.deflateSync(raw, { level: 9 });
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
const out = path.join(__dirname, "..", "resources", "activity.png");
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
