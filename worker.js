function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': 'https://limenbridge.cc',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }, extra || {});
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ── /register ──
// Looks up the email in KV.
// - If a record already exists, returns it as-is (status: 'existing') —
//   the client restores local state from it instead of starting a fresh trial.
// - If not, creates a new minimal record, registers the email with
//   MailerLite, stores the record in KV, and returns it (status: 'new').
async function handleRegister(body, env) {
  const email = normalizeEmail(body.email);
  if (!email) return jsonResponse({ error: 'email required' }, 400);

  const key = 'user:' + email;
  const existingRaw = await env.LIMENBRIDGE_KV.get(key);
  if (existingRaw) {
    return jsonResponse({ status: 'existing', user: JSON.parse(existingRaw) });
  }

  // Best-effort MailerLite signup — failure here shouldn't block registration.
  try {
    await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.MAILERLITE_API_KEY
      },
      body: JSON.stringify({
        email,
        fields: { name: body.name || '' },
        groups: body.groupId ? [body.groupId] : []
      })
    });
  } catch (e) {}

  const record = {
    email,
    name: body.name || '',
    registeredAt: new Date().toISOString(),
    onboardingComplete: false,
    plan: 'free',
    firstTrack: null,
    morningTime: null,
    eveningTime: null
  };
  await env.LIMENBRIDGE_KV.put(key, JSON.stringify(record));
  return jsonResponse({ status: 'new', user: record });
}

// ── /sync ──
// Merges `updates` into the stored record for `email`. Used after
// onboarding completes and after a successful Stripe checkout, so the
// server-side record reflects onboarding status and plan.
async function handleSync(body, env) {
  const email = normalizeEmail(body.email);
  if (!email) return jsonResponse({ error: 'email required' }, 400);

  const key = 'user:' + email;
  const existingRaw = await env.LIMENBRIDGE_KV.get(key);
  const existing = existingRaw
    ? JSON.parse(existingRaw)
    : { email, registeredAt: new Date().toISOString(), onboardingComplete: false, plan: 'free' };

  const updated = Object.assign({}, existing, body.updates || {});
  await env.LIMENBRIDGE_KV.put(key, JSON.stringify(updated));
  return jsonResponse({ status: 'ok', user: updated });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'invalid JSON' }, 400);
    }

    if (url.pathname === '/register') return handleRegister(body, env);
    if (url.pathname === '/sync') return handleSync(body, env);

    return jsonResponse({ error: 'not found' }, 404);
  }
};
