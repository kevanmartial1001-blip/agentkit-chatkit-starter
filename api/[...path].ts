import type { VercelRequest, VercelResponse } from '@vercel/node';

function json(res: VercelResponse, code: number, payload: unknown) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = (req.query.path || []) as string[];
  const method = req.method || 'GET';

  // GET /api/health
  if (method === 'GET' && path.length === 1 && path[0] === 'health') {
    return json(res, 200, { ok: true, service: 'agentkit-chatkit-starter' });
  }

  return json(res, 404, { ok: false, error: 'Not Found', route: `/api/${path.join('/')}` });
}
