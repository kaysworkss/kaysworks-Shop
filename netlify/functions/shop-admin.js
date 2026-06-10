// ─────────────────────────────────────────────────────
//  Admin shop API — native Netlify Function
//  Ported verbatim from admin.js (auth + shop section). Logic unchanged;
//  only the handler interface is native (event in, response out).
//  Routes (via netlify.toml redirects → ?action=):
//    login | shop-products | shop-config | shop-orders | shop-order
// ─────────────────────────────────────────────────────
const crypto = require('crypto');
const { getSupabase, json, preflight, parseEvent } = require('./_shop-lib');

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Signed token: HMAC-SHA256(randomId, ADMIN_TOKEN). Stateless.
function generateToken() {
  const id     = crypto.randomBytes(16).toString('hex');
  const secret = process.env.ADMIN_TOKEN || 'fallback-secret-change-me';
  const sig    = crypto.createHmac('sha256', secret).update(id).digest('hex');
  return `${id}.${sig}`;
}

function checkToken(ctx) {
  const token = ctx.headers['x-admin-token'];
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [id, sig] = parts;
  const secret   = process.env.ADMIN_TOKEN || 'fallback-secret-change-me';
  const expected = crypto.createHmac('sha256', secret).update(id).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig,      'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch { return false; }
}

async function handleLogin(ctx) {
  if (ctx.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const { password } = ctx.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: 'Incorrect password' });
  }
  return json(200, { token: generateToken() });
}

// ── shop-products (GET/POST/PATCH/DELETE) ─────────────────────────────────────
async function handleShopProducts(ctx, supabase) {
  if (ctx.method === 'GET') {
    const id = ctx.query.id;
    if (id) {
      const { data, error } = await supabase
        .from('shop_products')
        .select('*')
        .eq('id', id)
        .single();
      if (error) return json(error.code === 'PGRST116' ? 404 : 500, { error: error.message });
      return json(200, data);
    }
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, data || []);
  }

  if (ctx.method === 'POST') {
    const body = ctx.body || {};
    const { data, error } = await supabase
      .from('shop_products')
      .insert({
        name:               String(body.name || '').slice(0, 200),
        category:           String(body.category || 'prints').slice(0, 40),
        print_type:         String(body.print_type || '').slice(0, 40),
        description:        String(body.description || body.desc || '').slice(0, 1000),
        emoji:              String(body.emoji || '✦').slice(0, 10),
        variants:           body.variants || [],
        available_variants: body.available_variants || [],
        prices_ngn:         body.prices_ngn || {},
        prices_usd:         body.prices_usd || {},
        badge:              String(body.badge || '').slice(0, 60),
        image_url:          String(body.image_url || '').slice(0, 500),
        images:             body.images || [],
        slug:               body.slug ? String(body.slug).slice(0, 200) : null,
        series_slug:        body.series_slug ? String(body.series_slug).slice(0, 200) : null,
        series_name:        String(body.series_name || '').slice(0, 200),
        series_desc:        String(body.series_desc || '').slice(0, 1000),
        series_year:        String(body.series_year || '').slice(0, 20),
        story:              String(body.story || ''),
        process:            String(body.process || ''),
        quote:              String(body.quote || '').slice(0, 500),
        year:               String(body.year || '').slice(0, 20),
        medium:             String(body.medium || '').slice(0, 200),
        signed:             Boolean(body.signed),
        is_large_print:     Boolean(body.is_large_print),
        clothing:           Boolean(body.clothing),
        clothing_type:      String(body.clothing_type || '').slice(0, 40),
        stock:              body.stock === undefined || body.stock === null || body.stock === '' ? null : Number(body.stock),
        stock_by_variant:   body.stock_by_variant || {},
        edition_totals:     body.edition_totals || {},
        sort_order:         Number(body.sort_order) || 0,
        active:             body.active !== false,
      })
      .select('id')
      .single();
    if (error) return json(500, { error: error.message });
    return json(201, { ok: true, id: data.id });
  }

  if (ctx.method === 'PATCH') {
    const id = ctx.query.id;
    if (!id) return json(400, { error: 'id required' });
    const body = ctx.body || {};
    const patch = {};
    if (body.name               !== undefined) patch.name               = String(body.name).slice(0, 200);
    if (body.category           !== undefined) patch.category           = String(body.category).slice(0, 40);
    if (body.print_type         !== undefined) patch.print_type         = String(body.print_type).slice(0, 40);
    if (body.desc               !== undefined) patch.description        = String(body.desc).slice(0, 1000);
    if (body.description        !== undefined) patch.description        = String(body.description).slice(0, 1000);
    if (body.emoji              !== undefined) patch.emoji              = String(body.emoji).slice(0, 10);
    if (body.variants           !== undefined) patch.variants           = body.variants;
    if (body.available_variants !== undefined) patch.available_variants = body.available_variants;
    if (body.prices_ngn         !== undefined) patch.prices_ngn         = body.prices_ngn;
    if (body.prices_usd         !== undefined) patch.prices_usd         = body.prices_usd;
    if (body.badge              !== undefined) patch.badge              = String(body.badge).slice(0, 60);
    if (body.image_url          !== undefined) patch.image_url          = String(body.image_url).slice(0, 500);
    if (body.clothing           !== undefined) patch.clothing           = Boolean(body.clothing);
    if (body.clothing_type      !== undefined) patch.clothing_type      = String(body.clothing_type).slice(0, 40);
    if (body.stock              !== undefined) patch.stock              = body.stock === null || body.stock === '' ? null : Number(body.stock);
    if (body.sort_order         !== undefined) patch.sort_order         = Number(body.sort_order);
    if (body.active             !== undefined) patch.active             = Boolean(body.active);
    if (body.stock_by_variant   !== undefined) patch.stock_by_variant   = body.stock_by_variant;
    if (body.edition_totals     !== undefined) patch.edition_totals      = body.edition_totals;
    if (body.slug               !== undefined) patch.slug               = String(body.slug).slice(0, 200);
    if (body.year               !== undefined) patch.year               = String(body.year).slice(0, 10);
    if (body.series_slug        !== undefined) patch.series_slug        = String(body.series_slug).slice(0, 200);
    if (body.series_name        !== undefined) patch.series_name        = String(body.series_name).slice(0, 200);
    if (body.series_desc        !== undefined) patch.series_desc        = String(body.series_desc).slice(0, 1000);
    if (body.medium             !== undefined) patch.medium             = String(body.medium).slice(0, 200);
    if (body.quote              !== undefined) patch.quote              = String(body.quote).slice(0, 500);
    if (body.story              !== undefined) patch.story              = body.story;
    if (body.process            !== undefined) patch.process            = body.process;
    if (body.signed             !== undefined) patch.signed             = Boolean(body.signed);
    if (body.is_large_print     !== undefined) patch.is_large_print     = Boolean(body.is_large_print);
    if (body.images             !== undefined) patch.images             = body.images;
    const { error } = await supabase.from('shop_products').update(patch).eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (ctx.method === 'DELETE') {
    const id = ctx.query.id;
    if (!id) return json(400, { error: 'id required' });
    const { error } = await supabase.from('shop_products').delete().eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}

// ── shop-config (GET/POST) ────────────────────────────────────────────────────
async function handleShopConfig(ctx, supabase) {
  if (ctx.method === 'GET') {
    const { data, error } = await supabase
      .from('shop_config')
      .select('*')
      .limit(1)
      .single();
    if (error && error.code !== 'PGRST116') return json(500, { error: error.message });
    return json(200, data || {});
  }

  if (ctx.method === 'POST') {
    const body = ctx.body || {};
    const patch = {
      eth_address:    String(body.eth_address   || '').slice(0, 100),
      tezos_address:  String(body.tezos_address || '').slice(0, 100),
      announcement:   String(body.announcement  || '').slice(0, 500),
      updated_at:     new Date().toISOString(),
    };
    const { error } = await supabase
      .from('shop_config')
      .upsert({ id: 1, ...patch }, { onConflict: 'id' });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}

// ── shop-orders (GET) ─────────────────────────────────────────────────────────
async function handleShopOrders(ctx, supabase) {
  if (ctx.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const status = ctx.query.status || 'all';
  let query = supabase
    .from('shop_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return json(500, { error: error.message });
  return json(200, data || []);
}

// ── shop-order (PATCH) ────────────────────────────────────────────────────────
async function handleShopOrderUpdate(ctx, supabase) {
  if (ctx.method !== 'PATCH') return json(405, { error: 'Method not allowed' });
  const id = ctx.query.id;
  if (!id) return json(400, { error: 'id required' });
  const body = ctx.body || {};
  const patch = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    if (!['pending', 'processing', 'shipped', 'fulfilled', 'cancelled'].includes(body.status))
      return json(422, { error: 'Invalid status' });
    patch.status = body.status;
    if (body.status === 'fulfilled') patch.fulfilled_at = new Date().toISOString();
  }
  if (body.tracking_number !== undefined) patch.tracking_number = String(body.tracking_number).slice(0, 200);
  if (body.tracking_carrier !== undefined) patch.tracking_carrier = String(body.tracking_carrier).slice(0, 100);
  if (body.admin_note !== undefined) patch.admin_note = String(body.admin_note).slice(0, 1000);

  const { error } = await supabase.from('shop_orders').update(patch).eq('id', id);
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true });
}

// ── Netlify entry point ───────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  const ctx = parseEvent(event);
  const action = (ctx.query.action || '').toString();

  // Login doesn't need a token
  if (action === 'login') return handleLogin(ctx);

  // All other routes require a valid signed token
  if (!checkToken(ctx)) return json(401, { error: 'Unauthorized' });

  const supabase = getSupabase();

  switch (action) {
    case 'shop-products': return handleShopProducts(ctx, supabase);
    case 'shop-config':   return handleShopConfig(ctx, supabase);
    case 'shop-orders':   return handleShopOrders(ctx, supabase);
    case 'shop-order':    return handleShopOrderUpdate(ctx, supabase);
    default:
      return json(404, { error: `Unknown admin action: ${action}` });
  }
};
