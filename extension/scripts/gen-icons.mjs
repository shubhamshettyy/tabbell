import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const sizes = [16, 32, 48, 96, 128];
await mkdir('public/icon', { recursive: true });
for (const size of sizes) {
  await sharp('assets/icon.svg').resize(size, size).png().toFile(`public/icon/${size}.png`);
  console.log(`icon/${size}.png`);
}
