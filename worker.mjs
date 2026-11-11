/* ASSETS */
const SECURITY = {
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'"
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const allowed = (request.method === 'GET' &&
        (/^\/api\/(metadata|rows)$/.test(url.pathname) || /^\/api\/exports\/[a-f0-9]{32}(\/file)?$/.test(url.pathname))) ||
        (request.method === 'POST' && url.pathname === '/api/exports');
      if (!allowed) return Response.json({error:'Solicitud no permitida.'},{status:405,headers:SECURITY});
      if (request.method === 'POST' && request.headers.get('Origin') !== url.origin)
        return Response.json({error:'Origen no autorizado.'},{status:403,headers:SECURITY});
      if (!env.BRIDGE_URL || !env.BRIDGE_TOKEN)
        return Response.json({error:'La pasarela todavía no está configurada.'},{status:503,headers:SECURITY});
      const upstream = new URL(url.pathname + url.search, env.BRIDGE_URL);
      try {
        const response = await fetch(upstream, {
          method:request.method,
          headers:{Authorization:`Bearer ${env.BRIDGE_TOKEN}`,'Content-Type':'application/json'},
          body:request.method==='POST'?'{}':undefined,
          redirect:'manual',
          ...(url.pathname.endsWith('/file') ? {} : {signal:AbortSignal.timeout(65000)})
        });
        if(response.status>=300 && response.status<400) throw new Error('Gateway redirect rejected');
        const type = response.headers.get('Content-Type') || '';
        if (!type.includes('application/json') && !type.includes('spreadsheetml')) throw new Error('Gateway HTTP '+response.status+' ('+type+')');
        const headers = new Headers(SECURITY);
        for(const name of ['Content-Type','Content-Disposition','Content-Length']) {
          const value=response.headers.get(name); if(value) headers.set(name,value);
        }
        return new Response(response.body,{status:response.status,headers});
      } catch (error) {
        return Response.json({error:'La pasarela está desconectada. Mantené encendido el equipo de conexión y volvé a actualizar.'},{status:503,headers:{...SECURITY,'X-Colun-Proxy-Error':encodeURIComponent(String(error.message)).slice(0,400)}});
      }
    }
    const asset = ASSETS[url.pathname];
    if (!asset || request.method !== 'GET') return new Response('No encontrado',{status:404,headers:SECURITY});
    return new Response(asset.body,{headers:{...SECURITY,'Content-Type':asset.type}});
  }
};
