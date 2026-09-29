import { routePartykitRequest } from 'partyserver';
import { BOARD_NAME_RE } from '@class-board/shared/constants';
import { Board } from './board';
import type { Env } from './env';
import { corsHeaders, parseOrigins } from './files';

export { Board };

const PARTY_RE = /^\/parties\/board\/([^/]+)\/?$/;
const HTTP_RE = /^\/boards\/([^/]+)\/(?:files|shots)(?:\/[^/]*)?$/;

function notFound(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowed = parseOrigins(env.ALLOWED_ORIGINS);

    const party = PARTY_RE.exec(url.pathname);
    if (party) {
      if (!BOARD_NAME_RE.test(party[1]!)) return notFound();
      const response = await routePartykitRequest(request, env, {
        onBeforeConnect: (req) => {
          const origin = req.headers.get('Origin');
          if (!origin || !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
        },
        // The realtime route only takes WebSocket upgrades.
        onBeforeRequest: () => notFound(),
      });
      return response ?? notFound();
    }

    const http = HTTP_RE.exec(url.pathname);
    if (http) {
      const cors = corsHeaders(request.headers.get('Origin'), allowed);
      if (!BOARD_NAME_RE.test(http[1]!)) return notFound(cors);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      // One Durable Object call: Server reads its name from ctx.id.name. getServerByName would add a setName RPC.
      const stub = env.Board.get(env.Board.idFromName(http[1]!));
      return withHeaders(await stub.fetch(request), cors);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
