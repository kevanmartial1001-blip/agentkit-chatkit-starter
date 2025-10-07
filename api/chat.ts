import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const body = (req.body ?? {}) as any;
  const message: string = body.message || '';
  const context = body.context || {};

  if (!message.trim()) {
    return res.status(400).json({ ok: false, error: 'Missing message' });
  }

  // Reuse your existing master-spine logic via the /api/corp/ingest endpoint
  const spinePayload = {
    user_id: 'visitor-chat',
    session_id: 'sess_chat_' + Date.now(),
    utterance: message,
    channels: ['chat'],
    context,
    constraints: { sensitivity: 'NONE' }
  };

  try {
    const resp = await fetch(`${new URL(req.url!, `https://${req.headers.host}`).origin}/api/corp/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spinePayload)
    });

    const data = await resp.json();

    // Make a concise natural-language reply for the UI (keep it simple)
    let reply = 'I processed your request.';
    if (data?.summary) reply = `Done: ${data.summary.replace(/, /g, ' • ')}`;
    return res.status(200).json({ ok: true, reply, raw: data });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
