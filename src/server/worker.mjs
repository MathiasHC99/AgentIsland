/** Sites supplies the authenticated visitor header on a private island. */
export function createIslandWorker(handleAgentRequest, assets) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith('/api/')) {
        if (!request.headers.get('oai-authenticated-user-id')) {
          return Response.json({ error: 'Sign in to use the island team.' }, {
            status: 401, headers: { 'Cache-Control': 'no-store' },
          });
        }
        return handleAgentRequest(request, env);
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      const asset = assets.get(pathname === '/' ? '/index.html' : pathname);
      if (!asset) return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : asset.body, {
        headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
      });
    },
  };
}
