import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Refreshes an expiring client secret.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { currentClientSecret } =
      (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {};

    if (!currentClientSecret) {
      return res.status(400).json({ error: 'currentClientSecret is required' });
    }

    const resp = await fetch('https://api.openai.com/v1/chatkit/sessions/refresh', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_secret: currentClientSecret }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `session refresh failed`, detail: text });
    }

    const data = await resp.json(); // { client_secret, expires_at, ... }
    return res.status(200).json({ client_secret: data.client_secret });
  } catch (err: any) {
    return res.status(500).json({ error: 'unhandled', detail: err?.message || String(err) });
  }
}
