import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

/**
 * MODE:
 *  - "local"  -> FREE: use your existing /api/corp/ingest plan (no OpenAI calls)
 *  - "openai" -> PAID: call OpenAI model and (soon) AgentKit tools
 */
const MODE = (process.env.AGENT_MODE || 'local').toLowerCase();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { message, context } = (req.body ?? {}) as any;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing message' });
  }

  try {
    if (MODE === 'openai') {
      // --- REAL AGENT PATH (disabled by default)
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });

      const client = new OpenAI({ apiKey });

      // Minimal: ask model to summarize what it will do, then (soon) use tools.
      const completion = await client.chat.completions.create({
        model: process.env.AGENT_MODEL || 'gpt-5-mini',
        messages: [
          { role: 'system', content: 'You are the Master Spine. Classify user intent into SALES→OPS→FIN steps and respond concisely.' },
          { role: 'user', content: `Utterance: ${message}\nContext: ${JSON.stringify(context || {})}` }
        ]
      });

      const reply = completion.choices?.[0]?.message?.content || 'No reply';
      return res.status(200).json({ ok: true, mode: 'openai', reply, raw: completion });
    }

    // --- LOCAL PATH (default, $0): reuse your existing spine
    const origin = new URL(req.url!, `https://${req.headers.host}`).origin;
    const spinePayload = {
      user_id: 'visitor-agent',
      session_id: 'sess_agent_' + Date.now(),
      utterance: message,
      channels: ['chat'],
      context: context || { company: { name: 'Acme', domain: 'acme.com', hq_country: 'US' } },
      constraints: { sensitivity: 'NONE' }
    };

    const resp = await fetch(`${origin}/api/corp/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spinePayload)
    });
    const data = await resp.json();
    let reply = 'I processed your request.';
    if (data?.summary) reply = `Done: ${data.summary.replace(/, /g, ' • ')}`;
    return res.status(200).json({ ok: true, mode: 'local', reply, raw: data });

  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
