import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';
import { initializeDatabase, db } from './db.mjs';
import { fail, json } from './security.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = resolve(here, '../public');
const port = Number(process.env.PORT || 3000);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('content-security-policy', [
    "default-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
    "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: https://images.unsplash.com",
    "connect-src 'self'", "frame-src 'none'"
  ].join('; '));
  if (process.env.NODE_ENV === 'production') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}
function insidePublicRoot(candidate) {
  if (candidate === publicRoot) return true;
  const rel = relative(publicRoot, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}
async function staticFile(req, res, pathname) {
  const origin = process.env.APP_ORIGIN || `${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://${req.headers.host || 'localhost:3000'}`;
  if (pathname === '/robots.txt') {
    const body = `User-agent: *\nAllow: /\nDisallow: /patient\nDisallow: /doctor\nDisallow: /admin\nDisallow: /login\nDisallow: /register\nDisallow: /forgot-password\nDisallow: /reset-password\nSitemap: ${new URL('/sitemap.xml', origin).href}\n`;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }
  if (pathname === '/sitemap.xml') {
    const urls = ['/', '/about', '/doctors', '/treatments', '/gallery', '/faq', '/contact'];
    const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(path => `<url><loc>${new URL(path, origin).href}</loc></url>`).join('')}</urlset>`;
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }
  let cleanPath;
  try { cleanPath = decodeURIComponent(pathname); }
  catch { throw fail(400, 'INVALID_PATH', 'The requested path is invalid.'); }
  let target = resolve(publicRoot, `.${cleanPath}`);
  if (!insidePublicRoot(target)) throw fail(403, 'PATH_REJECTED', 'That path is not available.');
  let info;
  try { info = await stat(target); } catch { info = null; }
  if (!info || !info.isFile()) {
    // Public content routes are client-rendered. Private route paths still return the shell,
    // where the client checks the authenticated role before showing a portal.
    if (extname(cleanPath)) throw fail(404, 'NOT_FOUND', 'The requested file was not found.');
    target = resolve(publicRoot, 'index.html');
    info = await stat(target);
  }
  let contents = await readFile(target);
  if (extname(target).toLowerCase() === '.html') {
    const page = cleanPath === '/' ? '/' : cleanPath;
    const metadata = {
      '/': ['SmileCare Dental Clinic | Thoughtful dental care','A calmer kind of dentistry. Explore thoughtful dental care, meet our team and request an appointment at SmileCare.'],
      '/about': ['Our Clinic | SmileCare Dental Clinic','Meet SmileCare Dental Clinic: a modern neighborhood clinic built around clear conversations and thoughtful care.'],
      '/doctors': ['Our Dentists | SmileCare Dental Clinic','Meet the SmileCare dentists, review their specializations and find a clinician for your next visit. Demo profiles are shown.'],
      '/treatments': ['Dental Treatments | SmileCare Dental Clinic','Explore dental checkups, cleaning, restorative, cosmetic and family dentistry services at SmileCare. Demo pricing is labeled.'],
      '/gallery': ['Clinic Gallery | SmileCare Dental Clinic','Preview demo images of SmileCare clinic spaces and facilities.'],
      '/faq': ['FAQs | SmileCare Dental Clinic','Helpful answers about dental appointments, visits and care at SmileCare Dental Clinic.'],
      '/contact': ['Contact Us | SmileCare Dental Clinic','Contact the SmileCare clinic team, view opening hours or send a general enquiry.'],
      '/book': ['Request an Appointment | SmileCare Dental Clinic','Request a dental appointment at SmileCare. Appointment requests are pending until confirmed by clinic staff.']
    };
    const privateRoutes = ['/patient','/doctor','/admin','/login','/register','/forgot-password','/reset-password'];
    const [title, description] = metadata[page] || (privateRoutes.includes(page) ? ['Care Portal | SmileCare','Private role-based SmileCare clinic portal.'] : ['SmileCare Dental Clinic | Account access','Manage your SmileCare patient account.']);
    let html = contents.toString('utf8');
    html = html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`)
      .replace(/<meta name="description" content="[^"]*"\s*\/?\s*>/i, `<meta name="description" content="${description}" />`)
      .replace(/<meta property="og:title" content="[^"]*"\s*\/?\s*>/i, `<meta property="og:title" content="${title}" />`)
      .replace(/<meta property="og:description" content="[^"]*"\s*\/?\s*>/i, `<meta property="og:description" content="${description}" />`);
    if (privateRoutes.includes(page)) html = html.replace('</head>', '<meta name="robots" content="noindex,nofollow" /></head>');
    else if (metadata[page]) html = html.replace('</head>', `<link rel="canonical" href="${new URL(page, origin).href}" /></head>`);
    contents = Buffer.from(html);
  }
  res.writeHead(200, {
    'content-type': mimeTypes[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': contents.length,
    'cache-control': process.env.NODE_ENV === 'production' && extname(target) !== '.html' ? 'public, max-age=300' : 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  res.end(contents);
}

await initializeDatabase();
const server = createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (!['GET','POST','PATCH','PUT','DELETE'].includes(req.method || '')) throw fail(405, 'METHOD_NOT_ALLOWED', 'That request method is not supported.');
      await handleApi(req, res, url);
      return;
    }
    if (!['GET','HEAD'].includes(req.method || '')) throw fail(405, 'METHOD_NOT_ALLOWED', 'That request method is not supported.');
    await staticFile(req, res, url.pathname);
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    const status = error.status || 500;
    if (status >= 500) console.error('request_failed', error.code || 'INTERNAL_ERROR', status);
    json(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'The clinic service could not complete that request.' : error.message } });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.listen(port, process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', () => {
  const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  console.log(`SmileCare is listening on http://${host}:${port}`);
  if (process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO_DATA !== 'false') console.log('Demo data is enabled. See README.md for sample account credentials.');
});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
