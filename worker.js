/**
 * Foosto order proxy — optional, but the only way in-app ordering can work.
 *
 * WHY THIS EXISTS
 * admin.foosto.com has no HTTPS (port 443 refuses connections). GitHub Pages
 * serves over HTTPS. Browsers block HTTPS -> HTTP requests as mixed content
 * before CORS is even considered, so the page cannot POST to Foosto directly.
 * This Worker gives the browser an HTTPS endpoint to talk to and makes the
 * plain-HTTP hop itself, server-side, where mixed-content rules don't apply.
 *
 * DEPLOY
 *   npm create cloudflare@latest foosto-order -- --type=hello-world
 *   (replace src/index.js with this file)
 *   npx wrangler deploy
 * Then set ORDER.endpoint in index.html to the deployed URL.
 *
 * PRIVACY NOTE, PLEASE READ
 * Every order's name, phone, WhatsApp number, email and home address passes
 * through this Worker. Don't add logging of request bodies. If you're handling
 * other people's delivery addresses, that's a real responsibility.
 */

const FOOSTO_FORM = 'http://admin.foosto.com/order/create/';

// Lock this down to your Pages origin once you know it. '*' is fine while
// testing but means any site on the internet can post orders through you.
const ALLOWED_ORIGINS = [
  'https://YOUR-USERNAME.github.io',
  'http://localhost:8000',
];

const cors = (origin) => ({
  'access-control-allow-origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
});

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') || '';
    const headers = cors(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') {
      return Response.json({ error: 'POST only' }, { status: 405, headers });
    }

    try {
      const incoming = new URLSearchParams(await request.text());

      /* -----------------------------------------------------------------
         Django CSRF handshake.

         The URL shape (/order/create/, trailing slash) and the admin theme
         both say Django, which by default rejects a POST without a matching
         csrfmiddlewaretoken field AND csrftoken cookie. So: GET the form,
         scrape the hidden token, replay it with the cookie.

         If it turns out the view is @csrf_exempt, this whole block is
         harmless overhead and you can delete it.
         ----------------------------------------------------------------- */
      const formPage = await fetch(FOOSTO_FORM, {
        headers: { 'user-agent': 'Mozilla/5.0', 'accept': 'text/html' },
      });
      const html = await formPage.text();
      const setCookie = formPage.headers.get('set-cookie') || '';

      const token = html.match(
        /name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i
      )?.[1];
      const csrfCookie = setCookie.match(/csrftoken=([^;]+)/)?.[1];

      if (token) incoming.set('csrfmiddlewaretoken', token);

      const outHeaders = {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0',
        // Django also checks Referer on HTTPS; harmless to send on HTTP.
        'referer': FOOSTO_FORM,
      };
      if (csrfCookie) outHeaders.cookie = `csrftoken=${csrfCookie}`;

      const res = await fetch(FOOSTO_FORM, {
        method: 'POST',
        headers: outHeaders,
        body: incoming.toString(),
        redirect: 'manual',
      });

      // A Django form view typically 302s on success and re-renders 200 with
      // errors on failure, which is the opposite of what you'd guess.
      const ok = res.status >= 300 && res.status < 400;
      const text = ok ? '' : (await res.text()).slice(0, 2000);

      return Response.json(
        { ok, status: res.status, ...(ok ? {} : { detail: extractErrors(text) }) },
        { status: ok ? 200 : 422, headers }
      );
    } catch (err) {
      return Response.json({ error: 'Could not reach Foosto: ' + err.message },
        { status: 502, headers });
    }
  },
};

/** Pull visible validation messages out of a re-rendered Django form. */
function extractErrors(html) {
  const found = [...html.matchAll(/<(?:li|p|span)[^>]*class="[^"]*(?:error|invalid-feedback)[^"]*"[^>]*>([\s\S]*?)<\//gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return found.length ? found.slice(0, 5).join(' ') : 'Foosto rejected the order but gave no reason.';
}
