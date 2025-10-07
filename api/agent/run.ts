// api/agent/run.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const MODEL = process.env.MODEL || 'gpt-5';

if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY is not set');
}

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] };

function baseUrlFromReq(req: VercelRequest) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const host = (req.headers['x-forwarded-host'] || req.headers['host'] || '').toString();
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
  return `${proto}://${host}`;
}

/** OpenAI function schemas (must match names we handle below). */
const tools = [
  {
    type: 'function',
    function: {
      name: 'research_build_kb',
      description:
        'Build a company profile and crawl plan for a given website URL. Returns a JSON plan and profile.',
      parameters: {
        type: 'object',
        properties: {
          website: { type: 'string', description: 'Absolute URL, e.g., https://example.com' },
          tenant_id: {
            type: 'string',
            description:
              'Optional tenant id to tag artifacts. When missing, backend may generate one.',
          },
          company_name: {
            type: 'string',
            description: 'Optional human-friendly company name for profile label.',
          },
        },
        required: ['website'],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_department',
      description:
        'Execute one DepartmentTicket by POSTing it to the enterprise backend. Use for SALES, OPS, FIN, etc.',
      parameters: {
        type: 'object',
        properties: {
          ticket: {
            type: 'object',
            description:
              'A single DepartmentTicket object with id, dept, action, inputs, context, idempotency_key, sla_sec, retries.',
          },
        },
        required: ['ticket'],
        additionalProperties: false,
      },
      strict: true,
    },
  },
] as const;

/** Minimal wrapper for OpenAI Chat Completions with tools enabled. */
async function chatWithOpenAI(messages: ChatMessage[]) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const msg = choice?.message;
  return msg as ChatMessage & { tool_calls?: ToolCall[] };
}

/** Call your existing backend endpoints for each tool. */
async function handleToolCall(
  req: VercelRequest,
  call: ToolCall
): Promise<{ tool_call_id: string; content: string }> {
  const baseUrl = baseUrlFromReq(req);
  const args = JSON.parse(call.function.arguments || '{}');

  switch (call.function.name) {
    case 'research_build_kb': {
      const url = `${baseUrl}/api/research/build-kb`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          website: args.website,
          tenant_id: args.tenant_id,
          company_name: args.company_name,
        }),
      });
      const out = await r.json();
      return { tool_call_id: call.id, content: JSON.stringify(out) };
    }

    case 'execute_department': {
      const url = `${baseUrl}/api/dept/all`;
      const body = args.ticket && typeof args.ticket === 'object' ? { ticket: args.ticket } : args;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      return { tool_call_id: call.id, content: JSON.stringify(out) };
    }

    default:
      return {
        tool_call_id: call.id,
        content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.function.name}` }),
      };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { message, user, context } = (req.body || {}) as {
      message: string;
      user?: string;
      context?: Record<string, unknown>;
    };

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ ok: false, error: 'message is required (string)' });
    }

    // You can keep this system prompt in sync with your Master Spine instructions.
    const systemPrompt = `
You are the Master Spine for a digital enterprise.

Your job:
1) Validate the request and produce/track a tenant_id.
2) Plan department steps (e.g., SALES → OPS → FIN) for execution tasks.
3) Use the available tools to execute each step:
   - research_build_kb(website, tenant_id?, company_name?)
   - execute_department({ ticket })
4) For execution, build DepartmentTickets with sensible defaults when fields are missing.
5) Be concise and action-oriented. Ask only when strictly required.
6) Policy in tickets: pii=mask, phi=drop, after_hours_outreach=false.

Default execution order for "create lead + schedule meeting + quote":
SALES → OPS → FIN.

When needed, call tools in any order and as many times as necessary.
    `.trim();

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(user ? [{ role: 'system', content: `user_id=${user}` } as ChatMessage] : []),
      ...(context ? [{ role: 'system', content: `context=${JSON.stringify(context)}` } as ChatMessage] : []),
      { role: 'user', content: message },
    ];

    // Tool-execution loop
    const MAX_TURNS = 8;
    let lastAssistant: ChatMessage | null = null;

    for (let i = 0; i < MAX_TURNS; i++) {
      lastAssistant = await chatWithOpenAI(messages);
      messages.push(lastAssistant);

      const toolCalls = (lastAssistant as any).tool_calls as ToolCall[] | undefined;
      if (!toolCalls || toolCalls.length === 0) break;

      // Handle each tool call and append tool results
      for (const call of toolCalls) {
        const toolMsg = await handleToolCall(req, call);
        messages.push({
          role: 'tool',
          tool_call_id: toolMsg.tool_call_id,
          content: toolMsg.content,
        });
      }
    }

    const finalText = (lastAssistant?.content ?? '').toString();
    return res.status(200).json({
      ok: true,
      model: MODEL,
      messages: messages.slice(-10), // return tail for debugging
      reply: finalText,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err?.message || 'Server error' });
  }
}
