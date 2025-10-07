import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

const MODE = (process.env.AGENT_MODE || 'local').toLowerCase();

type Dept = 'SALES' | 'OPS' | 'FIN';
type DeptTicket = {
  id: string;
  dept: Dept;
  action: string;
  inputs: Record<string, unknown>;
  context: { tenant_id: string; capabilities: any };
  idempotency_key: string;
  sla_sec: number;
  retries: number;
};

function mkCapabilities() {
  return {
    crm: { provider: 'none' },
    support_desk: { provider: 'none' },
    calendar: { provider: 'google_calendar' },
    payments: { provider: 'stripe' },
    messaging: { chat: 'slack', sms: 'twilio', email: 'sendgrid' },
    fallbacks: { generic_ticketing: 'google_sheets', manual_review_channel: 'slack:#ops-review' },
    policies: { after_hours_outreach: false, pii: 'mask', phi: 'drop' }
  };
}

// Build a safe ticket if the model forgets to pass one
function synthTicket(funcName: string, args: any): DeptTicket {
  const caps = mkCapabilities();
  const dept: Dept =
    (args?.ticket?.dept ||
      args?.dept ||
      (funcName.startsWith('sales') ? 'SALES' : funcName.startsWith('ops') ? 'OPS' : 'FIN')) as Dept;

  const action =
    dept === 'SALES' ? 'create_or_update_lead' :
    dept === 'OPS'   ? 'schedule_meeting'     :
                       'draft_quote';

  const tenant_id =
    args?.ticket?.context?.tenant_id ||
    args?.tenant_id ||
    `tenant_local_${Date.now().toString(36)}`;

  const session_id = args?.session_id || `sess_${Date.now()}`;

  const base: DeptTicket = {
    id: `sess_${Date.now()}:${dept}:${action}:0`,
    dept,
    action,
    inputs: args?.ticket?.inputs || { notes: 'N/A' },
    context: { tenant_id, capabilities: caps },
    idempotency_key: `${session_id}:${dept}:${action}:0`,
    sla_sec: 120,
    retries: 2
  };
  return { ...base, ...(args?.ticket || {}) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { message, context } = (req.body ?? {}) as any;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing message' });
  }

  // ---------- FREE LOCAL PATH (no OpenAI spend) ----------
  if (MODE !== 'openai') {
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
    const reply = data?.summary ? `Done: ${data.summary.replace(/, /g, ' • ')}` : 'Processed locally.';
    return res.status(200).json({ ok: true, mode: 'local', reply, raw: data });
  }

  // ---------- OPENAI AGENT PATH (with tools) ----------
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });
    const client = new OpenAI({ apiKey });
    const origin = new URL(req.url!, `https://${req.headers.host}`).origin;

    // Tools exposed to the model
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'schema_guard',
          description: 'Validate minimal shape and produce a tenant_id.',
          parameters: {
            type: 'object',
            properties: {
              utterance: { type: 'string' },
              context: { type: 'object' }
            },
            required: ['utterance']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'build_tickets',
          description: 'Create DepartmentTickets for an ordered plan like SALES→OPS→FIN.',
          parameters: {
            type: 'object',
            properties: {
              plan: { type: 'array', items: { type: 'string', enum: ['SALES','OPS','FIN'] } },
              session_id: { type: 'string' },
              tenant_id: { type: 'string' }
            },
            required: ['plan','session_id','tenant_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'sales_handle',
          description: 'Mock SALES handler. Returns status and summary for a DepartmentTicket.',
          parameters: { type: 'object', properties: { ticket: { type: 'object' } }, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'ops_handle',
          description: 'Mock OPS handler. Returns status and summary for a DepartmentTicket.',
          parameters: { type: 'object', properties: { ticket: { type: 'object' } }, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'fin_handle',
          description: 'Mock FIN handler. Returns status and summary for a DepartmentTicket.',
          parameters: { type: 'object', properties: { ticket: { type: 'object' } }, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'research_build_kb',
          description: 'Build a company profile and crawl plan for a given website URL.',
          parameters: {
            type: 'object',
            properties: {
              website: { type: 'string' },
              tenant_id: { type: 'string' },
              company_name: { type: 'string' }
            },
            required: ['website']
          }
        }
      }
    ];

    // Messages
    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are the Master Spine. For CRM/meeting/quote tasks, plan SALES→OPS→FIN and call tools in order: schema_guard → build_tickets → dept handlers. If a website is provided, call research_build_kb with it and summarize the crawl plan.'
      },
      { role: 'user', content: `Utterance: ${message}\nContext: ${JSON.stringify(context || {})}` }
    ];

    // Tool executor
    async function runToolCall(call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) {
      const name = call.function?.name;
      let args: any = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
      switch (name) {
        case 'schema_guard': {
          const utter = String(args.utterance || '').trim();
          if (!utter) return { ok:false, error:'Missing utterance' };
          const domain =
            args?.context?.company?.domain ||
            (args?.context?.company?.name ? String(args.context.company.name).toLowerCase().replace(/\s+/g, '') + '.local' : '') ||
            'local.dev';
          const tenant_id = `tenant_${domain.replace(/\./g,'_')}_${Date.now().toString(36)}`;
          return { ok:true, tenant_id };
        }
        case 'build_tickets': {
          const plan: Dept[] = (Array.isArray(args.plan) && args.plan.length ? args.plan : ['SALES','OPS','FIN']) as Dept[];
          const session_id = args.session_id || ('sess_' + Date.now());
          const tenant_id = args.tenant_id || ('tenant_local_' + Date.now().toString(36));
          const caps = mkCapabilities();
          const tickets: Record<string, DeptTicket> = {};
          plan.forEach((dept: Dept, i: number) => {
            const action = dept === 'SALES' ? 'create_or_update_lead' : dept === 'OPS' ? 'schedule_meeting' : 'draft_quote';
            tickets[dept] = {
              id: `sess_${Date.now()}:${dept}:${action}:${i}`,
              dept, action,
              inputs: { notes: 'N/A' },
              context: { tenant_id, capabilities: caps },
              idempotency_key: `${session_id}:${dept}:${action}:0`,
              sla_sec: 120, retries: 2
            };
          });
          return { ok:true, tickets };
        }
        case 'sales_handle':
        case 'ops_handle':
        case 'fin_handle': {
          const t = synthTicket(call.function!.name, args);
          return {
            ok: true,
            dept: t.dept,
            status: 'ok',
            summary: `${t.dept} processed: ${t.action}`,
            ticket: t,
            diagnostics: { adapter: 'mock' }
          };
        }
        case 'research_build_kb': {
          const payload = {
            tenant_id: args.tenant_id || `tenant_web_${Date.now().toString(36)}`,
            company_name: args.company_name || '',
            website: args.website
          };
          const resp = await fetch(`${origin}/api/research/build-kb`, {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
          });
          return await resp.json();
        }
        default:
          return { ok:false, error:`Unknown tool: ${name}` };
      }
    }

    // Let the model call tools up to 6 times
    let finalText = '';
    for (let i = 0; i < 6; i++) {
      const completion = await client.chat.completions.create({
        model: process.env.AGENT_MODEL || 'gpt-5-mini',
        messages: msgs,
        tools
      });

      const msg = completion.choices[0].message;

      if (msg.tool_calls && msg.tool_calls.length) {
        msgs.push({ role: 'assistant', tool_calls: msg.tool_calls } as any);
        for (const tc of msg.tool_calls) {
          const toolResult = await runToolCall(tc);
          msgs.push({ role: 'tool', name: tc.function!.name, content: JSON.stringify(toolResult), tool_call_id: tc.id } as any);
        }
        continue;
      }

      finalText = msg.content || 'Done.';
      break;
    }

    return res.status(200).json({ ok: true, mode: 'openai', reply: finalText });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
