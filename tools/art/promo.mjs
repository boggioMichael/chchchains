// Saves the social posts drawn by tools/art/promo.html (served from the repository root) as PNG files.
//   python3 -m http.server 4700 &   then
//   node tools/art/promo.mjs http://127.0.0.1:4700 /path/to/playwright/index.mjs out-folder ["פורסם על ידי: …"]
import { mkdirSync, writeFileSync } from 'node:fs';
const [base = 'http://127.0.0.1:4700', pw = 'playwright', out = 'promo', publisher = ''] = process.argv.slice(2);
const { chromium } = await import(pw);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
page.on('pageerror', (e) => console.error('page error:', String(e)));
await page.goto(`${base}/tools/art/promo.html${publisher ? `?publisher=${encodeURIComponent(publisher)}` : ''}`);
await page.waitForSelector('body[data-ready="1"]', { timeout: 60000 });
for (const [id, name] of [['feed', 'post-1080x1350.png'], ['square', 'post-1080x1080.png'], ['story', 'story-1080x1920.png']]) {
  const data = await page.evaluate((id) => document.getElementById(id).toDataURL('image/png'), id);
  writeFileSync(`${out}/${name}`, Buffer.from(data.split(',')[1], 'base64'));
}
await browser.close();
console.log(`wrote the posts to ${out}/`);
