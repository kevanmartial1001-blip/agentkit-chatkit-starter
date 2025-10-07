import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

// Toggle spending: "openai" uses the API; anything else stays local + free
const MODE = (process.env.AGENT_MODE || 'local').toLowerCase();

// ==== Types ==================================================================
type Dept =
  | 'SALES' | 'MARKETING' | 'ANALYTICS' | 'EXEC' | 'PRODUCT' | 'SECURITY'
  | 'FACILITIES' | 'PROCUREMENT' | 'LEGAL' | 'IT' | 'HR' | 'FIN' | 'OPS' | 'CS' | 'RESEARCH';

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

// ==== Helpers ================================================================
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
  // Guess dept from function name or args
  const dept: Dept =
    (args?.ticket?.dept ||
      args?.dept ||
      (funcName.includes('sales') ? 'SALES'
        : funcName.includes('marketing') ? 'MARKETING'
        : funcName.includes('analytics') ? 'ANALYTICS'
        : funcName.includes('exec') ? 'EXEC'
        : funcName.includes('product') ? 'PRODUCT'
        : funcName.includes('security') ? 'SECURITY'
        : funcName.includes('facilities') ? 'FACILITIES'
        : funcName.includes('procurement') ? 'PROCUREMENT'
        : funcName.includes('legal') ? 'LEGAL'
        : funcName.includes('it') ? 'IT'
        : funcName.includes('hr') ? 'HR'
        : funcName.includes('fin') ? 'FIN'
        : funcName.includes('ops') ? 'OPS'
        : funcName.includes('cs') ? 'CS'
        : 'RESEARCH')) as Dept;

  const action =
    args?.ticket?.action ||
    args?.action ||
    (dept === 'SALES' ? 'create_or_update_lead'
      : dept === 'OPS' ? 'schedule_meeting'
      : dept === 'FIN' ? 'draft_quote'
      : dept === 'MARKETING' ? 'create_campaign'
      : dept === 'ANALYTICS' ? 'run_report'
      : dept === 'EXEC' ? 'daily_digest'
      : dept === 'PRODUCT' ? 'create_ticket'
      : dept === 'SECURITY' ? 'incident_intake'
      : dept === 'FACILITIES' ? 'create_work_order'
      : dept === 'PROCUREMENT' ? 'create_po'
      : dept === 'LEGAL' ? 'review_contract'
      : dept === 'IT' ? 'create_ticket'
      : dept === 'HR' ? 'new_hire'
      : dept === 'CS' ? 'create_ticket'
      : 'build_kb');

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

// ==== Handler ================================================================
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spinePayload)
    });
    const data = await resp.json();
    const reply = data?.summary ? `Done: ${data.summary.replace(/, /g, ' • ')}` : 'Processed locally.';
    return res.status(200).json({ ok: true, mode: 'local', reply, raw: data });
  }

  // ---------- OPENAI AGENT PATH ----------
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });
    const client = new OpenAI({ apiKey });
    const origin = new URL(req.url!, `https://${req.headers.host}`).origin;

    // Tools the model can call
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'schema_guard',
          description: 'Validate minimal shape and produce a tenant_id.',
          parameters: {
            type: 'object',
            properties: { utterance: { type: 'string' }, context: { type: 'object' } },
            required: ['utterance']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'build_tickets',
          description: 'Create DepartmentTickets for an ordered plan (e.g., SALES→OPS→FIN).',
          parameters: {
            type: 'object',
            properties: {
              plan: { type: 'array', items: { type: 'string' } }, // any of the Dept values
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
          name: 'execute_department',
          description:
            'Execute a DepartmentTicket by POSTing to /api/dept/all. Use this for any department (SALES, MARKETING, ANALYTICS, EXEC, PRODUCT, SECURITY, FACILITIES, PROCUREMENT, LEGAL, IT, HR, FIN, OPS, CS, RESEARCH).',
          parameters: {
            type: 'object',
            properties: { ticket: { type: 'object' } },
            required: ['ticket']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'research_build_kb',
          description: 'Build a company profile and crawl plan for a given website URL.',
          parameters: {
            type: 'object',
            properties: { website: { type:'string' }, tenant_id: { type:'string' }, company_name: { type:'string' } },
            required: ['website']
          }
        }
      }
    ];

    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are the Master Spine. For business operations, plan department steps and call: schema_guard → build_tickets → execute_department (for each ticket) in order. When a website is provided, call research_build_kb and summarize crawl plan. Keep responses concise and action-focused.'
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
          const plan: string[] = Array.isArray(args.plan) && args.plan.length ? args.plan : ['SALES','OPS','FIN'];
          const session_id = args.session_id || ('sess_' + Date.now());
          const tenant_id = args.tenant_id || ('tenant_local_' + Date.now().toString(36));
          const caps = mkCapabilities();

          const tickets: Record<string, DeptTicket> = {};
          plan.forEach((raw, i) => {
            // cast/paranoia around casing
            const dept = String(raw).toUpperCase() as Dept;
            // default actions by dept (can be overridden later)
            const action =
              dept === 'SALES' ? 'create_or_update_lead'
              : dept === 'OPS' ? 'schedule_meeting'
              : dept === 'FIN' ? 'draft_quote'
              : dept === 'MARKETING' ? 'create_campaign'
              : dept === 'ANALYTICS' ? 'run_report'
              : dept === 'EXEC' ? 'daily_digest'
              : dept === 'PRODUCT' ? 'create_ticket'
              : dept === 'SECURITY' ? 'incident_intake'
              : dept === 'FACILITIES' ? 'create_work_order'
              : dept === 'PROCUREMENT' ? 'create_po'
              : dept === 'LEGAL' ? 'review_contract'
              : dept === 'IT' ? 'create_ticket'
              : dept === 'HR' ? 'new_hire'
              : dept === 'CS' ? 'create_ticket'
              : 'build_kb';

            tickets[dept] = {
              id: `sess_${Date.now()}:${dept}:${action}:${i}`,
              dept: dept as Dept,
              action,
              inputs: { notes: 'N/A' },
              context: { tenant_id, capabilities: caps },
              idempotency_key: `${session_id}:${dept}:${action}:0`,
              sla_sec: 120,
              retries: 2
            };
          });
          return { ok:true, tickets, plan };
        }

        case 'execute_department': {
          // tolerate missing/partial ticket from model
          const t = synthTicket('execute_department', args);
          const r = await fetch(`${new URL(req.url!, `https://${req.headers.host}`).origin}/api/dept/all`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ticket: t })
          });
          return await r.json();
        }

        case 'research_build_kb': {
          const payload = {
            tenant_id: args.tenant_id || `tenant_web_${Date.now().toString(36)}`,
            company_name: args.company_name || '',
            website: args.website
          };
          const resp = await fetch(`${new URL(req.url!, `https://${req.headers.host}`).origin}/api/research/build-kb`, {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
          });
          return await resp.json();
        }

        default:
          return { ok:false, error:`Unknown tool: ${name}` };
      }
    }

    // Let the model plan + call tools up to 8 steps
    let finalText = '';
    for (let i = 0; i < 8; i++) {
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
          msgs.push({
            role: 'tool',
            name: tc.function!.name,
            content: JSON.stringify(toolResult),
            tool_call_id: tc.id
          } as any);
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
