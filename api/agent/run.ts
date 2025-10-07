import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5'; // adjust if needed

function json(res: VercelResponse, code: number, payload: unknown) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}
function bad(res: VercelResponse, msg: string, code = 400) {
  return json(res, code, { ok: false, error: msg });
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'research_build_kb',
      description:
        'Build a company profile and propose a crawl plan for a website. Returns a profile and prioritized crawl_plan.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          website: {
            type: 'string',
            description:
              'Absolute URL for the company (e.g., https://example.com). If user gave a bare domain, still pass it.',
          },
          tenant_id: {
            type: 'string',
            description: 'Optional tenant id used to tag artifacts/results',
          },
          company_name: {
            type: 'string',
            description: 'Optional human-readable company name',
          },
        },
        required: ['website'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_department',
      description:
        'Execute a department action (SALES, OPS, FIN, etc.). Builds a DepartmentTicket server-side and forwards to /api/dept/all.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          dept: {
            type: 'string',
            description: 'Department name',
            enum: [
              'SALES',
              'MARKETING',
              'ANALYTICS',
              'EXEC',
              'PRODUCT',
              'SECURITY',
              'FACILITIES',
              'PROCUREMENT',
              'LEGAL',
              'IT',
              'HR',
              'FIN',
              'OPS',
              'CS',
              'RESEARCH',
            ],
          },
          action: { type: 'string', description: 'Action verb, e.g., create_or_update_lead' },
          inputs: { type: 'object', description: 'Freeform input payload for the action' },
          tenant_id: { type: 'string', description: 'Optional tenant id' },
          id: { type: 'string', description: 'Optional ticket id (server will default if missing)' },
          idempotency_key: { type: 'string', description: 'Optional idempotency key' },
          sla_sec: { type: 'integer', description: 'Optional SLA seconds (default ~120)' },
          retries: { type: 'integer', description: 'Optional retry count (default 2)' },
        },
        required: ['dept', 'action'],
        additionalProperties: false,
      },
    },
  },
];

// Helper: call your own endpoints
async function postJSON<T = any>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`POST ${url} -> ${res.status}: ${txt}`);
  }
  return (await res.json()) as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 'Method Not Allowed', 405);
  }

  const { message, user = 'web_user', context = {} } = (req.body || {}) as {
    message: string;
    user?: string;
    context?: { tenant_id?: string; capabilities?: Record<string, unknown> };
  };

  if (!message || typeof message !== 'string') {
    return bad(res, 'Please provide { "message": "..." }');
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const system = [
    'You are the Master Spine for a digital enterprise.',
    'Job:',
    '1) Validate the request and produce/keep a tenant_id.',
    '2) Plan department steps for execution tasks.',
    '3) For each step, call execute_department with dept/action/inputs (+ tenant_id if available).',
    '4) If user mentions a website or asks for research/KB/crawl, call research_build_kb.',
    '5) Be concise, action-oriented; propose defaults when fields are missing.',
    'Default order for "create lead + schedule meeting + quote": SALES -> OPS -> FIN.',
    'Tools: research_build_kb; execute_department (the server will build the full ticket).',
  ].join('\n');

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: message,
    },
    // Pass tenant context via a hidden assistant message to encourage tool args
    ...(context?.tenant_id
      ? [
          {
            role: 'system' as const,
            content: `Tenant context: tenant_id=${context.tenant_id}`,
          },
        ]
      : []),
  ];

  const toolTrace: any[] = [];

  // tool loop
  for (let step = 0; step < 8; step++) {
    const cc = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
    });

    const msg = cc.choices[0]?.message;
    const calls = msg?.tool_calls || [];
    if (!calls.length) {
      // done
      return json(res, 200, {
        ok: true,
        final: msg?.content ?? '',
        tool_trace: toolTrace,
      });
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args: any = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        // ignore, will surface below
      }

      if (name === 'research_build_kb') {
        const payload = {
          website: args.website,
          tenant_id: args.tenant_id || context?.tenant_id,
          company_name: args.company_name,
        };
        const out = await postJSON(`${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers.host}/api/research/build-kb`, payload);
        toolTrace.push({ tool: name, args: payload, result: out });
        messages.push({
          role: 'tool',
          tool_call_id: call.id!,
          content: JSON.stringify(out),
        });
      } else if (name === 'execute_department') {
        // Construct a minimal "ticket-ish" body the server can enrich
        const nowId =
          args.id ||
          `sess:${Date.now()}:${args.dept}:${args.action}:0`;
        const idem =
          args.idempotency_key ||
          `${user}:${args.dept}:${args.action}:0`;

        const ticketBody = {
          id: nowId,
          dept: args.dept,
          action: args.action,
          inputs: args.inputs || {},
          context: {
            tenant_id: args.tenant_id || context?.tenant_id || 'tenant_manual_test',
            capabilities: context?.capabilities || {},
          },
          idempotency_key: idem,
          sla_sec: typeof args.sla_sec === 'number' ? args.sla_sec : 120,
          retries: typeof args.retries === 'number' ? args.retries : 2,
        };

        const out = await postJSON(`${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers.host}/api/dept/all`, {
          ticket: ticketBody,
        });
        toolTrace.push({ tool: name, args: ticketBody, result: out });
        messages.push({
          role: 'tool',
          tool_call_id: call.id!,
          content: JSON.stringify(out),
        });
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: call.id!,
          content: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }),
        });
      }
    }
  }

  return json(res, 200, {
    ok: true,
    final: '(Stopped after tool loop safeguard)',
    tool_trace: toolTrace,
  });
}
