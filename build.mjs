// Builds the game into single self-contained HTML files (no dependencies, no bundler):
//   docs/index.html          full page for any static host (and served by server.mjs), plus its manifest
//   dist/page-content.html   the same page without <html>/<head>/<body>, for hosts that add their own skeleton
// Settings come from config.json or environment variables (CHAIN_SERVER, CHAIN_BRAND, CHAIN_PUBLISHER,
// CHAIN_JOIN_URL, CHAIN_SHARE_URL); see README.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { NAME } from './src/brand.js';

const ROOT = new URL('.', import.meta.url).pathname;
const MODULES = ['brand', 'sim', 'names', 'arena', 'streets', 'protocol', 'net', 'map', 'people', 'avatars', 'audio', 'story', 'client']; // dependency order

function bundle() {
  const parts = ['(() => {', "'use strict';", 'const __m = {};'];
  for (const name of MODULES) {
    let code = readFileSync(`${ROOT}src/${name}.js`, 'utf8');
    const exported = [];
    code = code.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/(\w+)\.js';\s*$/gm, (_, names, from) => {
      const list = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => n.replace(/\s+as\s+/, ': '));
      return `const { ${list.join(', ')} } = __m.${from};`;
    });
    code = code.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, id) => {
      exported.push(id);
      return `${kind} ${id}`;
    });
    if (/^\s*(import|export)\s/m.test(code)) throw new Error(`${name}.js: unsupported import/export form`);
    parts.push(`__m.${name} = (() => {\n${code}\nreturn { ${exported.join(', ')} };\n})();`);
  }
  parts.push('})();');
  return parts.join('\n');
}

function config() {
  const file = `${ROOT}config.json`;
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const env = process.env;
  return {
    server: env.CHAIN_SERVER ?? fromFile.server ?? '',
    brand: env.CHAIN_BRAND ?? fromFile.brand ?? 'המשחק של עמך ישראל',
    publisher: env.CHAIN_PUBLISHER ?? fromFile.publisher ?? '',
    joinUrl: env.CHAIN_JOIN_URL ?? fromFile.joinUrl ?? '',
    shareUrl: env.CHAIN_SHARE_URL ?? fromFile.shareUrl ?? '',
    // Several game servers (each map lives on one): CHAIN_SERVERS="wss://a/ws,wss://b/ws".
    servers: (env.CHAIN_SERVERS ? env.CHAIN_SERVERS.split(',') : fromFile.servers ?? []).map((s) => String(s).trim()).filter(Boolean),
    // A satellite picture provider's tiles, e.g. { "tiles": "https://…/{z}/{y}/{x}?token=…", "credit": "…" }.
    satellite: fromFile.satellite ?? null,
    // Licensed songs in docs/music, e.g. [{ "title": "…", "url": "song.mp3", "credit": "…" }].
    music: fromFile.music ?? [],
  };
}

const page = readFileSync(`${ROOT}src/page.html`, 'utf8');
const split = page.indexOf('<canvas');
const head = page.slice(0, split).trim();
const body = page.slice(split).trim();
const cfg = config();
// </script> can never appear inside the JSON: every '<' is escaped.
const cfgScript = `<script>window.CHAIN_CONFIG = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};</script>`;
const script = `<script>\n${bundle()}\n</script>`;

// The full page gets its own Content-Security-Policy: only this page's own inline code (by hash) runs, and it
// may talk only to its own site and the game server.
const sha = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const inline = (tag, html) => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => sha(m[1]));
let connect = "'self'";
for (const server of [cfg.server, ...cfg.servers]) {
  if (!/^wss?:\/\//.test(server || '')) continue;
  const u = new URL(server);
  connect += ` ${u.protocol}//${u.host} ${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}
const tiles = /^https:\/\/[a-z0-9.-]+/i.exec(cfg.satellite?.tiles || '')?.[0] ?? '';
const csp = [
  "default-src 'self'",
  `script-src ${inline('script', `${cfgScript}\n${script}`).join(' ')}`,
  `style-src ${inline('style', head).join(' ')}`,
  `img-src 'self' data: blob:${tiles ? ` ${tiles}` : ''}`,
  "media-src 'self' blob:",
  `connect-src ${connect}`,
  "manifest-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const title = cfg.brand ? `${NAME} – ${cfg.brand}` : NAME;
const description = 'משחק רשת בטלפון ברחובות האמיתיים של ערי ישראל ועל מפת כל הארץ: אוספים אנשים, נותנים יד ומתארכים, ובמצב הסיפור – מנצחים בבחירות. לבד אתה חזק – ביחד אנחנו שרשרת. בלי הרשמה.';
const meta = [
  `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="icon" type="image/png" href="icon-192.png">',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  `<meta name="apple-mobile-web-app-title" content="${esc(NAME)}">`,
  '<meta property="og:type" content="website">',
  `<meta property="og:title" content="${esc(title)}">`,
  `<meta property="og:description" content="${esc(description)}">`,
];
if (/^https:\/\//.test(cfg.shareUrl)) {
  const base = cfg.shareUrl.endsWith('/') ? cfg.shareUrl : `${cfg.shareUrl}/`;
  meta.push(
    `<meta property="og:url" content="${esc(base)}">`,
    `<meta property="og:image" content="${esc(base)}og.jpg">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
  );
}
const pageHead = head.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);

mkdirSync(`${ROOT}dist`, { recursive: true });
mkdirSync(`${ROOT}docs`, { recursive: true });
writeFileSync(`${ROOT}dist/page-content.html`, `${pageHead}\n${body}\n${cfgScript}\n${script}\n`);
writeFileSync(
  `${ROOT}docs/index.html`,
  `<!doctype html>\n<html lang="he" dir="rtl">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n` +
    `${meta.join('\n')}\n${pageHead}\n</head>\n<body>\n${body}\n${cfgScript}\n${script}\n</body>\n</html>\n`,
);
writeFileSync(
  `${ROOT}docs/manifest.webmanifest`,
  `${JSON.stringify(
    {
      name: title,
      short_name: NAME,
      description,
      lang: 'he',
      dir: 'rtl',
      start_url: './',
      scope: './',
      display: 'fullscreen',
      background_color: '#f3efe6',
      theme_color: '#f3efe6',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    null,
    2,
  )}\n`,
);
const kb = (readFileSync(`${ROOT}docs/index.html`).length / 1024).toFixed(0);
console.log(`built docs/index.html (${kb} KB) and dist/page-content.html; server: ${cfg.server || cfg.servers.join(', ') || '(none: offline only)'}`);
