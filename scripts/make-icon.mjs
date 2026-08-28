/**
 * 生成应用图标:build/icon.png(512×512,Linux/macOS 用)+ build/icon.ico(256×256 PNG 内嵌,Windows 用)。
 * 纯 Node 手写,零依赖:PNG 编码器(CRC32 + zlib)+ ICO 容器(ICONDIR + 内嵌 PNG,Vista+ 支持)。
 * 设计:深色圆角底(#0f1115)+ 蓝色圆(#4f8cff)+ 白色双向切换箭头。
 * 用法: node scripts/make-icon.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ---- 像素绘制(按尺寸参数化,512 与 256 共用同一套比例) ----
const BG = [0x0f, 0x11, 0x15, 0xff];       // 深底
const BLUE = [0x4f, 0x8c, 0xff, 0xff];     // 主题蓝
const WHITE = [0xff, 0xff, 0xff, 0xff];

function makePixelFn(size) {
  const c = size / 2;
  const R = size * (96 / 512);      // 圆角半径
  const disc = size * (190 / 512);  // 蓝圆半径
  return function pixel(x, y) {
    // 圆角矩形底板,四角透明
    const inX = Math.min(x, size - 1 - x);
    const inY = Math.min(y, size - 1 - y);
    if (inX < R && inY < R) {
      const dx = R - inX;
      const dy = R - inY;
      if (dx * dx + dy * dy > R * R) return [0, 0, 0, 0];
    }
    if (Math.hypot(x - c, y - c) > disc) return BG;

    const u = size / 512; // 比例尺
    // 双向箭头:上半向右、下半向左(切换意象)
    if (y >= c - 62 * u && y <= c - 42 * u && x >= c - 90 * u && x <= c + 70 * u) return WHITE;
    if (x >= c + 30 * u && x <= c + 100 * u && Math.abs(y - (c - 52 * u)) <= (c + 100 * u - x)) return WHITE;
    if (y >= c + 42 * u && y <= c + 62 * u && x >= c - 70 * u && x <= c + 90 * u) return WHITE;
    if (x >= c - 100 * u && x <= c - 30 * u && Math.abs(y - (c + 52 * u)) <= (x - (c - 100 * u))) return WHITE;
    return BLUE;
  };
}

/** 生成 RGBA PNG Buffer */
function renderPng(size) {
  const pixel = makePixelFn(size);
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 把 PNG 包进 ICO 容器(单帧;ICO 的宽高字段是 1 字节,256 表示为 0,故最大 256) */
function wrapIco(png, size) {
  if (size > 256) throw new Error('ICO 内嵌 PNG 最大 256×256');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count: 1
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size; // width(0 表示 256)
  entry[1] = size === 256 ? 0 : size; // height
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(png.length, 8);  // data size
  entry.writeUInt32LE(22, 12);         // data offset(6 + 16)
  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const png512 = renderPng(512);
fs.writeFileSync(path.join(outDir, 'icon.png'), png512);
console.log(`已生成 build/icon.png(${png512.length} 字节)`);

const png256 = renderPng(256);
const ico = wrapIco(png256, 256);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`已生成 build/icon.ico(${ico.length} 字节,内嵌 256×256 PNG)`);
