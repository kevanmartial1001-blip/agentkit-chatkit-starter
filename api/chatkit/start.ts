import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Creates a ChatKit session for the published Agent Builder workflow
 * and returns a short-lived client secret for the browser.
 *
 * NOTE: The exact REST path for session creation comes from the ChatKit docs.
 * If your SDK exposes it, swap the fetch() below with the official client call.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const workflow_id = process.env.CHATKIT_WORKFLOW_ID!;
    const version = process.env.CHATKIT_WORKFLOW_VERSION || undefined;

    // Create a ChatKit session with your workflow ID
    // See: “Authentication → Generate tokens on your server”
    // https://openai.github.io/chatkit-js/guides/authentication
    const resp = await fetch('https://api.openai.com/v1/chatkit/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        version ? { workflow_id, version } : { workflow_id }
      ),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `session create failed`, detail: text });
    }

    const data = await resp.json(); // { client_secret, expires_at, ... }
    return res.status(200).json({ client_secret: data.client_secret });
  } catch (err: any) {
    return res.status(500).json({ error: 'unhandled', detail: err?.message || String(err) });
  }
}
