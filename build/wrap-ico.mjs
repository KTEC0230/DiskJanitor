// 把 PNG 序列封装为 .ico(Vista+ 支持 PNG 直存条目;256 用 0 表示尺寸)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngDir = path.join(buildDir, 'build', 'png');
const sizes = [256, 48, 32, 16];
const pngs = [];
for (const s of sizes) {
  pngs.push({ size: s, data: await fs.readFile(path.join(pngDir, `icon-${s}.png`)) });
}

// ICONDIR(6B) + N * ICONDIRENTRY(16B) + 数据
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: icon
header.writeUInt16LE(count, 4);  // count

const entries = [];
let offset = 6 + 16 * count;
for (const { size, data } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2);            // palette
  e.writeUInt8(0, 3);            // reserved
  e.writeUInt16LE(1, 4);         // planes
  e.writeUInt16LE(32, 6);        // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
const out = path.join(buildDir, 'build', 'icon.ico');
await fs.writeFile(out, ico);
console.log(`build/icon.ico 写入完成(${ico.length} 字节, ${count} 个尺寸)`);
