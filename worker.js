// stock-dashboard Worker — serves the static site (env.ASSETS) and adds a tiny
// same-origin proxy at /api/ics so the lobby can read a Google Calendar
// "secret iCal" feed from the browser without CORS problems.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ics') {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      };
      if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

      let target = url.searchParams.get('url') || '';
      target = target.replace(/^webcal:\/\//i, 'https://'); // calendars often hand out webcal://
      if (!/^https?:\/\//i.test(target)) {
        return new Response('bad or missing url', { status: 400, headers: cors });
      }
      try {
        const r = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/calendar, text/plain, */*' },
          cf: { cacheTtl: 60, cacheEverything: true },
        });
        const body = await r.text();
        return new Response(body, {
          status: r.ok ? 200 : r.status,
          headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8' },
        });
      } catch (e) {
        return new Response('upstream error: ' + (e && e.message ? e.message : 'fetch failed'), { status: 502, headers: cors });
      }
    }

    // everything else → the static assets (index.html lobby, dashboard.html, …)
    return env.ASSETS.fetch(request);
  },
};
