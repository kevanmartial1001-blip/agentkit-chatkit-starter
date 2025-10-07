import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

const MODE = (process.env.AGENT_MODE || 'local').toLowerCase();

type DeptTicket = {
  id: string;
  dept: 'SALES' | 'OPS' | 'FIN';
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { message, context } = (req.body ?? {}) as any;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing message' });
  }

  // ---- FREE LOCAL PATH (no OpenAI) -----------------------------------------
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spinePayload)
    });
    const data = await resp.json();
    const reply = data?.summary ? `Done: ${data.summary.replace(/, /g, ' • ')}` : 'Processed locally.';
    return res.status(200).json({ ok: true, mode: 'local', reply, raw: data });
  }

  // ---- OPENAI AGENT PATH (with tools) --------------------------------------
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });
    const client = new OpenAI({ apiKey });
    const origin = new URL(req.url!, `https://${req.headers.host}`).origin;

    // Tool definitions the model can call
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
          description: 'Mock SALES handler. Returns a status and summary for a DepartmentTicket.',
          parameters: { type: 'object', properties: { ticket: { type: 'object' } }, required: ['ticket'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'ops_handle',
          description: 'Mock OPS handler. Returns a status and summary for a DepartmentTicket.',
          parameters: { type: 'object', properties: { ticket: { type: 'object' } }, required: ['ticket'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'fin_handle',
          description: 'Mock FIN handler. Returns a status and summary for a DepartmentTicket.',
          parameters: { type: 'object', properties: { ticket: { type: 'object' } }, required: ['ticket'] }
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

    // Initial messages
    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are the Master Spine. When the user asks for CRM/meeting/quote work, plan SALES→OPS→FIN and call the tools in order: schema_guard → build_tickets → dept handlers. When a website is provided, call research_build_kb.'
      },
      { role: 'user', content: `Utterance: ${message}\nContext: ${JSON.stringify(context || {})}` }
    ];

    // Small executor that actually runs the tools on our server
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
          const plan = Array.isArray(args.plan) && args.plan.length ? args.plan : ['SALES','OPS','FIN'];
          const session_id = args.session_id || ('sess_' + Date.now());
          const tenant_id = args.tenant_id || ('tenant_local_' + Date.now().toString(36));
          const caps = mkCapabilities();
          const tickets: Record<string, DeptTicket> = {};
          plan.forEach((dept: 'SALES'|'OPS'|'FIN', i: number) => {
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
          const t = args.ticket as DeptTicket;
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

    // Simple loop: let the model call tools up to 6 times
    let finalText = '';
    for (let i = 0; i < 6; i++) {
      const completion = await client.chat.completions.create({
        model: process.env.AGENT_MODEL || 'gpt-5-mini',
        messages: msgs,
        tools
      });

      const choice = completion.choices[0];
      const msg = choice.message;

      // If tool calls, execute them sequentially
      if (msg.tool_calls && msg.tool_calls.length) {
        msgs.push({ role: 'assistant', tool_calls: msg.tool_calls } as any);
        for (const tc of msg.tool_calls) {
          const toolResult = await runToolCall(tc);
          msgs.push({
            role: 'tool',
            name: tc.function!.name,
            content: JSON.stringify(toolResult),
            tool_call_id: tc.id
          } as any);
        }
        continue;
      }

      // No tool calls → final assistant message
      finalText = msg.content || 'Done.';
      break;
    }

    return res.status(200).json({ ok: true, mode: 'openai', reply: finalText });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
