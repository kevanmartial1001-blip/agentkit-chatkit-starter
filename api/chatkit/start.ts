import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Issue a short-lived ChatKit client secret for your published workflow.
 * Accepts POST (recommended). GET is also allowed for quick manual testing.
 *
 * Env needed:
 * - OPENAI_API_KEY
 * - CHATKIT_WORKFLOW_ID          (e.g. "wf_68e5...")
 * - (optional) CHATKIT_WORKFLOW_VERSION  e.g. "2"
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const workflowId = process.env.CHATKIT_WORKFLOW_ID;
    if (!workflowId) {
      return res.status(500).json({ error: "CHATKIT_WORKFLOW_ID is not set" });
    }
    const version = process.env.CHATKIT_WORKFLOW_VERSION; // optional

    // NEW: ChatKit expects { workflow: { id, version? } }
    const body = {
      workflow: version ? { id: workflowId, version } : { id: workflowId },
    };

    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res
        .status(resp.status)
        .json({ error: "session create failed", detail: text });
    }

    const data = await resp.json(); // { client_secret, expires_at, ... }
    return res.status(200).json({ client_secret: data.client_secret });
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: "unhandled", detail: err?.message || String(err) });
  }
}
