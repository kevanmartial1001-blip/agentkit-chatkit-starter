import type { VercelRequest, VercelResponse } from '@vercel/node';

function json(res: VercelResponse, code: number, payload: unknown) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}
function bad(res: VercelResponse, msg: string, code = 400) {
  return json(res, code, { ok: false, error: msg });
}

function ensureAbsoluteUrl(rawIn: string | undefined) {
  const raw = (rawIn || '').trim();
  if (!raw) throw new Error('company_url is required');
  let u = raw.replace(/^"+|"+$/g, '').replace(/^\/\//, 'https://');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const url = new URL(u);
  const absolute = `${url.protocol}//${url.hostname}`;
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  return { absolute, host };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 'Method Not Allowed', 405);
  }

  const b: any = req.body || {};

  // Contact
  const contact = b.customer
    ? {
        email: b.customer.email,
        first_name: b.customer.first_name,
        last_name: b.customer.last_name,
        full_name: `${b.customer.first_name || ''} ${b.customer.last_name || ''}`.trim(),
      }
    : { email: b.email };

  // Company URL priority: note_attributes.company_url → line_items[].properties.website → email domain
  const fromNotes = Array.isArray(b.note_attributes)
    ? b.note_attributes.find((x: any) => x?.name === 'company_url')?.value
    : undefined;

  const fromLineItem = Array.isArray(b.line_items)
    ? b.line_items
        .flatMap((li: any) => Array.isArray(li?.properties) ? li.properties : [])
        .find((p: any) => p?.name === 'website')?.value
    : undefined;

  const fromEmail = contact?.email ? `https://${String(contact.email).split('@')[1]}` : '';

  let urlStr = fromNotes || fromLineItem || fromEmail;
  try {
    const { absolute, host } = ensureAbsoluteUrl(urlStr);
    const companyName =
      (Array.isArray(b.note_attributes)
        ? b.note_attributes.find((x: any) => x?.name === 'company_name')?.value
        : undefined) || host;

    const tenant_id = `tenant_${host.replace(/\./g, '_')}_${Date.now().toString(36)}`;

    return json(res, 200, {
      ok: true,
      mode: 'demo',                          // demo until real creds exist
      tenant_id,
      demo_link: `https://your-vercel-app.example/?t=${tenant_id}`,
      contact,
      company: { name: companyName, domain: host, url: absolute },
      external_ids: { shopify_customer_id: b.id ?? null },
    });
  } catch (e: any) {
    return bad(res, e?.message || 'Invalid input', 400);
  }
}
