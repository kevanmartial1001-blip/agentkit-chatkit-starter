import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Refresh an expiring ChatKit client secret.
 * Accepts POST with JSON body { currentClientSecret }.
 * GET is also allowed for quick manual testing: /api/chatkit/refresh?currentClientSecret=...
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const currentClientSecret =
      body.currentClientSecret ||
      (typeof req.query.currentClientSecret === "string"
        ? req.query.currentClientSecret
        : undefined);

    if (!currentClientSecret) {
      return res.status(400).json({ error: "currentClientSecret is required" });
    }

    const resp = await fetch(
      "https://api.openai.com/v1/chatkit/sessions/refresh",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          // REQUIRED header for ChatKit beta endpoints:
          "OpenAI-Beta": "chatkit_beta=v1",
        },
        body: JSON.stringify({ client_secret: currentClientSecret }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      return res
        .status(resp.status)
        .json({ error: "session refresh failed", detail: text });
    }

    const data = await resp.json(); // { client_secret, expires_at, ... }
    return res.status(200).json({ client_secret: data.client_secret });
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: "unhandled", detail: err?.message || String(err) });
  }
}
