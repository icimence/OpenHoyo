// 纯 Node 生成图标：手写 PNG 编码（zlib + CRC32）→ to-ico 打包规范 ICO
// 运行：node scripts/gen-icon.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import toIco from "to-ico";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "src-tauri", "icons");

// ---------------------------------------------------------------------------
// 1. 绘制 256x256 RGBA 位图：蓝色渐变圆角底 + 白色 "H"
// ---------------------------------------------------------------------------

const S = 256;
const px = new Uint8Array(S * S * 4);

const inRoundedRect = (x, y, r) => {
  const dx = Math.max(r - x, x - (S - 1 - r), 0);
  const dy = Math.max(r - y, y - (S - 1 - r), 0);
  return dx * dx + dy * dy <= r * r;
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!inRoundedRect(x, y, 48)) {
      px[i + 3] = 0; // 透明
      continue;
    }
    const t = y / S;
    px[i] = Math.round(76 + (47 - 76) * t); // R
    px[i + 1] = Math.round(194 + (111 - 194) * t); // G
    px[i + 2] = Math.round(255 + (216 - 255) * t); // B
    px[i + 3] = 255;

    // 白色 H
    const stemL = x >= 72 && x < 106;
    const stemR = x >= 150 && x < 184;
    const bar = y >= 111 && y < 145 && x >= 72 && x < 184;
    if (stemL || stemR || bar) {
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. PNG 编码
// ---------------------------------------------------------------------------

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) {
    c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); // width
ihdr.writeUInt32BE(S, 4); // height
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// 每行前置 filter 字节 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(join(iconsDir, "icon.png"), png);
console.log(`icon.png written (${png.length} bytes)`);

// ---------------------------------------------------------------------------
// 3. ICO 打包
// ---------------------------------------------------------------------------

const ico = await toIco([png], { resize: true, sizes: [16, 24, 32, 48, 64, 128, 256] });
writeFileSync(join(iconsDir, "icon.ico"), ico);
console.log(`icon.ico written (${ico.length} bytes)`);
