import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExtensionAsset } from './extensions.mjs';
import { extensionModule } from './extension-modules.mjs';
import { galleryFile } from './story-gallery.mjs';
import { openExtensionMedia } from './extension-media.mjs';

// A distinct origin permits synchronous author APIs between nested documents without
// granting imported code access to the application document, storage or API settings.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self' https: data: blob:; script-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https:; worker-src 'self'; img-src 'self' https: data: blob:; frame-src 'self' https: data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'");
    if (/^\/user\/(images|files)\//.test(url.pathname)) {
        try {
            const asset = await openExtensionMedia(url.pathname);
            res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.size, 'Cache-Control': 'no-cache' });
            if (req.method === 'HEAD') res.end(); else fs.createReadStream(asset.file).on('error', () => res.destroy()).pipe(res);
        } catch { res.writeHead(404); res.end(); }
        return;
    }
    const module = extensionModule(pathname);
    const gallery = /^\/local-gallery\/([\w~-]+)\/(.+)$/.exec(pathname);
    if (gallery) {
        try {
            const file = galleryFile(gallery[1], gallery[2]);
            const stat = await fs.promises.stat(file);
            if (!stat.isFile()) throw new Error('Not a file');
            res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? ({ '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp' }[path.extname(file)] || 'application/octet-stream'), 'Access-Control-Allow-Origin': '*', 'Cache-Control': gallery[2] === 'manifest.json' ? 'no-store' : 'public, max-age=31536000, immutable', 'Content-Length': stat.size });
            if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
        } catch { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); }
        return;
    }
    if (module !== undefined) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : module); return;
    }
    const extensionAsset = /^\/scripts\/extensions\/third-party\/([^/]+)\/(.+)$/.exec(pathname);
    if (extensionAsset) {
        try {
            const asset = await readExtensionAsset(extensionAsset[1], extensionAsset[2]);
            res.writeHead(200, { 'Content-Type': types[asset.extension] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end(req.method === 'HEAD' ? undefined : asset.data);
        } catch { res.writeHead(404); res.end(); }
        return;
    }
    if (pathname !== '/compat.html' && !pathname.startsWith('/assets/')) { res.writeHead(404); res.end(); return; }
    const file = path.resolve(dist, `.${pathname}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Only the author asset origin and HTTPS are reachable; application gateway access stays in RPC.
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
});
server.listen(Number(process.env.TIPSY_COMPAT_PORT ?? 5181), '127.0.0.1', () => console.log('TipsyIsle compatibility host: http://127.0.0.1:5181/compat.html'));
