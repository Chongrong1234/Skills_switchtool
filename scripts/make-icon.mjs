/**
 * 生成 build/icon.png(512×512):纯 Node 手写最小 PNG 编码器。
 * 设计:深色圆角底(#0f1115 透明圆角)+ 蓝色圆(#4f8cff)+ 白色双向切换箭头。
 * 用法: node scripts/make-icon.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const CX = SIZE / 2;
const CY = SIZE / 2;

// ---- CRC32(PNG chunk 用) ----
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---- 像素绘制 ----
// 颜色
const BG = [0x0f, 0x11, 0x15, 0xff];       // 深底
const BLUE = [0x4f, 0x8c, 0xff, 0xff];     // 主题蓝
const WHITE = [0xff, 0xff, 0xff, 0xff];

function pixel(x, y) {
  // 圆角矩形底板(半径 96),四角透明
  const r = 96;
  const inX = Math.min(x, SIZE - 1 - x);
  const inY = Math.min(y, SIZE - 1 - y);
  if (inX < r && inY < r) {
    const dx = r - inX;
    const dy = r - inY;
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  }
  const d = Math.hypot(x - CX, y - CY);
  if (d > 190) return BG;

  // 双向箭头:上半向右、下半向左(切换意象)
  // 上箭头横条
  if (y >= CY - 62 && y <= CY - 42 && x >= CX - 90 && x <= CX + 70) return WHITE;
  // 上箭头三角头(指向右)
  if (x >= CX + 30 && x <= CX + 100 && Math.abs(y - (CY - 52)) <= (CX + 100 - x)) return WHITE;
  // 下箭头横条
  if (y >= CY + 42 && y <= CY + 62 && x >= CX - 70 && x <= CX + 90) return WHITE;
  // 下箭头三角头(指向左)
  if (x >= CX - 100 && x <= CX - 30 && Math.abs(y - (CY + 52)) <= (x - (CX - 100))) return WHITE;

  return BLUE;
}

// ---- 组装 PNG ----
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const [r_, g, b, a] = pixel(x, y);
    raw[o++] = r_; raw[o++] = g; raw[o++] = b; raw[o++] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
// compression/filter/interlace 均为 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`已生成 ${out}(${png.length} 字节)`);
