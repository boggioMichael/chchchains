// Renders tools/art/art.html (served from the repository root) into docs/og.jpg and the app icons.
//   python3 -m http.server 4700 &   then   node tools/art/make.mjs http://127.0.0.1:4700 /path/to/playwright/index.mjs
import { writeFileSync } from 'node:fs';
const [base = 'http://127.0.0.1:4700', pw = 'playwright'] = process.argv.slice(2);
const { chromium } = await import(pw);
const root = new URL('../../', import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 1300 } });
page.on('pageerror', (e) => console.error('page error:', String(e)));
await page.goto(`${base}/tools/art/art.html${process.argv[4] ? `?${process.argv[4]}` : ''}`);
await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
const shot = async (id, type = 'png') => page.locator(`#${id}`).screenshot({ type, quality: type === 'jpeg' ? 84 : undefined });
writeFileSync(`${root}docs/og.jpg`, await shot('og', 'jpeg'));
const icon = await shot('icon');
writeFileSync(`${root}docs/icon-512.png`, icon);
for (const [name, size] of [['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  const data = await page.evaluate(async (s) => {
    const src = document.getElementById('icon');
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, s, s);
    return c.toDataURL('image/png');
  }, size);
  writeFileSync(`${root}docs/${name}`, Buffer.from(data.split(',')[1], 'base64'));
}
await browser.close();
console.log('wrote docs/og.jpg and the icons');
