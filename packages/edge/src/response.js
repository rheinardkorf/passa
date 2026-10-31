// The viewer-response handler: runs as a second CloudFront Function on every
// response the sites distribution serves from storage, and in the local proxy.
// Search engines may index a named site's pages, but nothing else (M2 R42):
// a response on an ID host carries noindex, and one on a name host doesn't.
// A name host only serves a named site (anything else redirects first), and
// crawlers have no site cookie, so all they can get there is public pages.
//
// Same runtime rules as handler.js. build.ts adds the CloudFront wrapper.

// Site IDs (shared/ids.ts, SITE_ID_PATTERN), as in handler.js.
const SITE_ID = /^[a-z]{3,6}-[a-z]{3,6}-[b-df-hj-km-np-tv-z2-9]{6}$/;

// options: { sites (the site domain) }
function robots(event, options) {
  const response = event.response;
  const host = event.request.headers.host ? event.request.headers.host.value.toLowerCase() : '';
  const suffix = '.' + options.sites;
  const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  if (!label || SITE_ID.test(label)) response.headers['x-robots-tag'] = { value: 'noindex' };
  return response;
}
