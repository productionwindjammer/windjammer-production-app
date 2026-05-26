// Generates PWA / favicon / sidebar logo assets from client/public/windjammer-logo.webp
// Re-run any time the source logo changes:  node scripts/make-icons.js

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'client', 'public', 'windjammer-logo.webp');
const OUT = path.join(__dirname, '..', 'client', 'public');

if (!fs.existsSync(SRC)) {
  console.error('Missing source logo:', SRC);
  process.exit(1);
}

// Brand colors (match client/index.html theme-color and manifest)
const BG_LIGHT = { r: 255, g: 255, b: 255, alpha: 1 }; // white card behind dark logo
const BG_BRAND = { r: 59, g: 130, b: 246, alpha: 1 }; // #3b82f6 for maskable

async function squarePadded(size, bg, padPct = 0.14) {
  const inner = Math.round(size * (1 - padPct * 2));
  const logo = await sharp(SRC)
    .resize({ width: inner, height: inner, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: bg },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png();
}

async function transparent(size) {
  return sharp(SRC)
    .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png();
}

(async () => {
  // PWA icons — white background looks best with this black logo, maskable safe-zone padding 14%
  await (await squarePadded(192, BG_LIGHT)).toFile(path.join(OUT, 'icon-192.png'));
  await (await squarePadded(512, BG_LIGHT)).toFile(path.join(OUT, 'icon-512.png'));
  // Maskable variant on brand color so Android adaptive icon never shows white edges
  await (await squarePadded(512, BG_BRAND, 0.18)).toFile(path.join(OUT, 'icon-maskable-512.png'));
  // iOS home screen icon
  await (await squarePadded(180, BG_LIGHT)).toFile(path.join(OUT, 'apple-touch-icon.png'));
  // Favicon (32px PNG; modern browsers accept PNG via rel="icon")
  await (await squarePadded(32, BG_LIGHT, 0.08)).toFile(path.join(OUT, 'favicon-32.png'));
  await (await squarePadded(16, BG_LIGHT, 0.08)).toFile(path.join(OUT, 'favicon-16.png'));
  // Sidebar / login hero logo — transparent PNG so it inherits the page background
  await (await transparent(512)).toFile(path.join(OUT, 'windjammer-logo.png'));

  console.log('✓ Generated icon-192, icon-512, icon-maskable-512, apple-touch-icon, favicon-16/32, windjammer-logo.png');
})().catch(err => { console.error(err); process.exit(1); });
