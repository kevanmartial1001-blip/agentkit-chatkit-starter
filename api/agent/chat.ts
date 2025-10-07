import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

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
    if (MODE !== 'openai') {
      // --- FREE local path
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spinePayload)
      });
      const data = await resp.json();
      const reply = data?.summary ? `Done: ${data.summary.replace(/, /g, ' • ')}` : 'Processed locally.';
      return res.status(200).json({ ok: true, mode: 'local', reply, raw: data });
    }

    // --- OpenAI agent path (with one tool) ---
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });
    const client = new OpenAI({ apiKey });
    const origin = new URL(req.url!, `https://${req.headers.host}`).origin;

    // Define a single tool the model can call
    const tools = [{
      type: 'function',
      function: {
        name: 'research_build_kb',
        description: 'Build a company profile and crawl plan for a given website URL.',
        parameters: {
          type: 'object',
          properties: {
            website: { type: 'string', description: 'Absolute company website URL like https://example.com' },
            tenant_id: { type: 'string', description: 'Tenant id if known' },
            company_name: { type: 'string', description: 'Company name if known' }
          },
          required: ['website']
        }
      }
    }];

    // Start the conversation
    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'You are the Master Spine agent. You can call tools when needed. If the user references a website, call research_build_kb with that URL.' },
      { role: 'user', content: `Utterance: ${message}\nContext: ${JSON.stringify(context || {})}` }
    ];

    let replyText = '';
    for (let i = 0; i < 3; i++) { // small safety loop (up to 3 tool calls)
      const completion = await client.chat.completions.create({
        model: process.env.AGENT_MODEL || 'gpt-5-mini',
        messages: msgs,
        tools
      });

      const choice = completion.choices[0];
      const msg = choice.message;

      // Tool call?
      const toolCall = msg.tool_calls?.[0];
      if (toolCall && toolCall.function?.name === 'research_build_kb') {
        // parse args
        let args: any = {};
        try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}
        const payload = {
          tenant_id: args.tenant_id || `tenant_web_${Date.now().toString(36)}`,
          company_name: args.company_name || '',
          website: args.website
        };

        const resp = await fetch(`${origin}/api/research/build-kb`, {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
        });
        const toolResult = await resp.json();

        // feed the tool result back to the model
        msgs.push({ role: 'assistant', tool_calls: [toolCall] } as any);
        msgs.push({ role: 'tool', name: 'research_build_kb', content: JSON.stringify(toolResult), tool_call_id: toolCall.id } as any);
        continue; // ask model again with tool result in context
      }

      // No tool call → final text
      replyText = msg.content || 'Done.';
      break;
    }

    return res.status(200).json({ ok: true, mode: 'openai', reply: replyText });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
