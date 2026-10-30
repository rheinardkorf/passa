// The edge handler: runs as a CloudFront Function (JavaScript runtime 2.0) on
// every request to <site-id>.<site domain>, and unchanged in the local proxy and
// tests. It maps the host to a site, checks the site cookie against the
// site's edge record, and rewrites the request to the current version's files.
//
// The runtime is ES5.1 plus a few later features: no destructuring, spread,
// optional chaining, classes, default parameters or async closures. Keep it
// that way; a test checks. build.ts adds the CloudFront wrapper.

const COOKIE = '__Host-passa';
// The site ID alphabet (shared/ids.ts): a–z without l and o, and 2–9.
const SITE_ID = /^[a-km-np-z2-9]{12}$/;
// Same characters as publishable paths. Anything else (including %-escapes,
// "..", dotfiles and empty segments) can't match a published file.
const PATH = /^(\/[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*)*\/?$/;
const HANDOFF = '/_passa/session';

function respond(status, description, headers, extra) {
  const response = { statusCode: status, statusDescription: description, headers: {} };
  headers['cache-control'] = 'no-store';
  headers['referrer-policy'] = 'no-referrer';
  headers['x-content-type-options'] = 'nosniff';
  Object.keys(headers).forEach((name) => { response.headers[name] = { value: headers[name] }; });
  if (extra && extra.cookies) response.cookies = extra.cookies;
  if (extra && extra.body) response.body = { encoding: 'text', data: extra.body };
  return response;
}

function notFound() {
  return respond(404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' }, { body: 'Not found' });
}

// A site's record reaches the edge a few seconds after it's published. A valid
// handoff proves auth. allowed the visit, so the page waits for the record
// rather than failing; the token stays valid for long enough.
function notReady() {
  return respond(503, 'Service Unavailable', { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2' }, {
    body: '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta http-equiv="refresh" content="2">'
      + '<title>One moment</title><style>body{font:14px system-ui,sans-serif;opacity:.6;display:grid;place-items:center;height:90vh}</style>'
      + '<p>Opening the page…</p>',
  });
}

// Constant-time comparison of two hex strings.
function sameHex(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sign(crypto, key, purpose, fields) {
  return crypto.createHmac('sha256', key).update(purpose + '.' + fields.join('.')).digest('hex');
}

// Parses "<kid>.<site-id>.<access-version>.<expiry>.<signature>".
function parseSigned(value) {
  const parts = typeof value === 'string' ? value.split('.') : [];
  if (parts.length !== 5 || !/^[A-Za-z0-9_-]{1,32}$/.test(parts[0]) || !/^\d{1,12}$/.test(parts[2]) || !/^\d{1,12}$/.test(parts[3])) return null;
  return { kid: parts[0], site: parts[1], v: Number(parts[2]), exp: Number(parts[3]), sig: parts[4] };
}

async function readJson(kvs, key) {
  try {
    const raw = await kvs.get(key); // CloudFront doesn't allow await in arguments
    return JSON.parse(raw);
  } catch (e) {
    return null; // missing (get throws) or unreadable: treated as absent
  }
}

async function readKey(kvs, kid) {
  try {
    return await kvs.get('k:' + kid);
  } catch (e) {
    return null;
  }
}

// Safe paths contain no "%", so decoding is the same whether or not the value
// arrived decoded. Malformed escapes give an invalid path.
function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return '';
  }
}

function indexPath(path) {
  if (path.endsWith('/')) return path + 'index.html';
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.indexOf('.') === -1 ? path + '/index.html' : path;
}

// options: { kvs, crypto, now (ms), sites (the site domain), auth (auth. origin) }
async function handle(event, options) {
  const request = event.request;
  const host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  const suffix = '.' + options.sites;
  const siteId = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  const path = request.uri;
  if (!SITE_ID.test(siteId) || !PATH.test(path)) return notFound();

  const now = Math.floor(options.now / 1000);
  const record = await readJson(options.kvs, 's:' + siteId);

  // Sign-in hands the visitor back here with a short-lived token, since auth.
  // can't set a cookie for this host. The token becomes the site cookie.
  if (path === HANDOFF) {
    const q = request.querystring;
    const token = parseSigned(q.t ? q.t.value : null);
    const to = q.p ? decodePath(q.p.value) : '/';
    // The cookie lifetime (seconds) is set by auth. and covered by the signature.
    const life = q.l && /^\d{1,5}$/.test(q.l.value) ? Number(q.l.value) : 0;
    const key = token ? await readKey(options.kvs, token.kid) : null;
    const signed = token && key && token.site === siteId && token.exp > now
      && life > 0 && life <= 86400 && to.charAt(0) === '/' && PATH.test(to)
      && sameHex(token.sig, sign(options.crypto, key, 'handoff', [token.kid, token.site, token.v, token.exp, life, to]));
    if (!signed) return notFound();
    if (!record || token.v > record.v) return notReady();
    if (token.v !== record.v) return notFound();
    const fields = [token.kid, siteId, record.v, now + life];
    const cookies = {};
    cookies[COOKIE] = {
      value: fields.join('.') + '.' + sign(options.crypto, key, 'cookie', fields),
      attributes: 'Path=/; Max-Age=' + life + '; Secure; HttpOnly; SameSite=Lax',
    };
    return respond(302, 'Found', { location: to }, { cookies: cookies });
  }

  // Reserved for Passa; never served from storage (R14).
  if (path === '/_passa' || path.indexOf('/_passa/') === 0) return notFound();

  const cookie = parseSigned(request.cookies[COOKIE] ? request.cookies[COOKIE].value : null);
  const key = cookie ? await readKey(options.kvs, cookie.kid) : null;
  const allowed = cookie && key && record && cookie.site === siteId && cookie.v === record.v && cookie.exp > now
    && sameHex(cookie.sig, sign(options.crypto, key, 'cookie', [cookie.kid, cookie.site, cookie.v, cookie.exp]));

  // A missing site looks exactly like a private one, so the redirect reveals nothing (R12).
  if (!allowed) {
    const signin = options.auth + '/site/signin?site=' + siteId + '&path=' + encodeURIComponent(path);
    return respond(302, 'Found', { location: signin });
  }

  request.uri = '/' + siteId + '/' + record.cur + indexPath(path);
  request.querystring = {};
  request.cookies = {};
  return request;
}
