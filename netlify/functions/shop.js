// ─────────────────────────────────────────────────────
//  Public shop API — native Netlify Function
//  Ported verbatim from game.js (shop section). Logic unchanged;
//  only the handler interface is native (event in, response out).
//  Routes (via netlify.toml redirects → ?action=):
//    shop-products | shop-config | shop-quote | shop-payment-init | shop-order
// ─────────────────────────────────────────────────────
const crypto = require('crypto');
const { getSupabase, json, preflight, parseEvent } = require('./_shop-lib');

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
async function handleShopProducts(ctx, supabase) {
  if (ctx.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const slug   = ctx.query.slug   || '';
  const series = ctx.query.series || '';

  if (slug) {
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .eq('slug', slug)
      .eq('active', true)
      .single();
    if (error) return json(error.code === 'PGRST116' ? 404 : 500, { error: error.message });
    const [tagged] = await applyProductTags([data], supabase);
    return json(200, tagged || data);
  }

  if (series) {
    const { data, error } = await supabase
      .from('shop_products')
      .select('*')
      .eq('series_slug', series)
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, data || []);
  }

  const { data, error } = await supabase
    .from('shop_products')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) return json(500, { error: error.message });

  const tagged = await applyProductTags(data || [], supabase);
  return json(200, tagged);
}

// Compute "new" (added in last 14 days) and "bestseller" (top 3 by total
// quantity ordered) tags, returned alongside each product.
async function applyProductTags(products, supabase) {
  if (!products.length) return products;

  const counts = {};
  try {
    const { data: orders } = await supabase
      .from('shop_orders')
      .select('items')
      .limit(5000);
    (orders || []).forEach(o => {
      const items = Array.isArray(o.items) ? o.items : [];
      items.forEach(it => {
        const id = it && it.id;
        const qty = Number(it && it.qty) || 0;
        if (id) counts[id] = (counts[id] || 0) + qty;
      });
    });
  } catch (e) {
    // If orders can't be read, fall back to no bestseller tags.
  }

  const bestsellerIds = new Set(
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id)
  );

  const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return products.map(p => {
    const created = p.created_at ? new Date(p.created_at).getTime() : 0;
    const isNew = created > 0 && (now - created) <= NEW_WINDOW_MS;
    const isBestseller = bestsellerIds.has(p.id);
    return {
      ...p,
      is_new: isNew,
      is_bestseller: isBestseller,
      order_count: counts[p.id] || 0,
    };
  });
}

// ── CHECKOUT COMPUTATION (server-authoritative) ───────────────────────────────
// Server-authoritative delivery rates — MUST mirror DELIVERY_RATES in shop.html.
const SERVER_DELIVERY_RATES = {
  'pickup':   { small: { ngn: 0,    usd: 0  }, large: { ngn: 0,    usd: 0  } },
  'NG-other': { small: { ngn: 4500, usd: 0  }, large: { ngn: 6500, usd: 0  } },
  'WA':       { small: { ngn: 0,    usd: 22 }, large: { ngn: 0,    usd: 30 } },
  'EU':       { small: { ngn: 0,    usd: 35 }, large: { ngn: 0,    usd: 48 } },
  'NA':       { small: { ngn: 0,    usd: 42 }, large: { ngn: 0,    usd: 58 } },
  'AO':       { small: { ngn: 0,    usd: 50 }, large: { ngn: 0,    usd: 68 } },
  'ROW':      { small: { ngn: 0,    usd: 48 }, large: { ngn: 0,    usd: 62 } },
};
const SERVER_LARGE_PRINT_VARIANTS = ['12×16"', '12×18"', '18×24"', '24×36"'];
const NGN_PER_USD = 1600;

function serverVariantPrice(product, variantKey, variant, currency) {
  const prices = currency === 'usd' ? (product.prices_usd || {}) : (product.prices_ngn || {});
  if (variantKey && prices[variantKey] !== undefined) return Number(prices[variantKey]) || 0;
  if (variant && prices[variant] !== undefined) return Number(prices[variant]) || 0;
  const size = String(variantKey || variant || '').split('|').pop();
  if (size && prices[size] !== undefined) return Number(prices[size]) || 0;
  return 0;
}

function serverDeliveryFee(zone, hasLarge, currency) {
  const z = SERVER_DELIVERY_RATES[zone] || SERVER_DELIVERY_RATES['ROW'];
  const tier = hasLarge ? z.large : z.small;
  if (currency === 'usd') {
    if (tier.usd > 0) return tier.usd;
    return tier.ngn > 0 ? +(tier.ngn / NGN_PER_USD).toFixed(2) : 0;
  }
  if (tier.ngn > 0) return tier.ngn;
  return tier.usd > 0 ? Math.round(tier.usd * NGN_PER_USD) : 0;
}

async function computeShopCheckout(body, supabase) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    const err = new Error('No items in order');
    err.statusCode = 400;
    throw err;
  }

  const productCache = {};
  for (const item of items) {
    if (!item.id || productCache[item.id]) continue;
    const { data: product } = await supabase
      .from('shop_products')
      .select('*')
      .eq('id', item.id)
      .single();
    if (product) productCache[item.id] = product;
  }

  for (const item of items) {
    if (!item.id || !item.variant || !item.qty) continue;
    const vkey = item.variantKey || item.variant;
    const product = productCache[item.id];
    if (!product) continue;

    const stockByVariant = product.stock_by_variant || {};
    const sv = stockByVariant[vkey] !== undefined ? stockByVariant[vkey] : stockByVariant[item.variant];
    if (sv !== undefined && sv < item.qty) {
      const err = new Error(`Only ${sv} left in stock for ${product.name} · ${item.variant}`);
      err.statusCode = 409;
      err.product_id = item.id;
      err.variant = item.variant;
      throw err;
    }
    if (sv === undefined && product.stock !== null && product.stock !== undefined && product.stock < item.qty) {
      const err = new Error(`Only ${product.stock} left in stock for ${product.name}`);
      err.statusCode = 409;
      err.product_id = item.id;
      throw err;
    }
  }

  let subtotalNgn = 0, subtotalUsd = 0, hasLarge = false;
  const trustedItems = [];
  for (const item of items) {
    if (!item.id || !item.variant || !item.qty) continue;
    const product = productCache[item.id];
    if (!product) {
      const err = new Error(`Unknown product in order: ${item.id}`);
      err.statusCode = 400;
      throw err;
    }
    const vkey = item.variantKey || item.variant;
    const qty = Math.max(1, Number(item.qty) || 1);
    const priceNgn = serverVariantPrice(product, vkey, item.variant, 'ngn');
    const priceUsd = serverVariantPrice(product, vkey, item.variant, 'usd');
    subtotalNgn += priceNgn * qty;
    subtotalUsd += priceUsd * qty;
    if (product.category === 'prints' &&
        (product.is_large_print === true || SERVER_LARGE_PRINT_VARIANTS.includes(item.variant))) {
      hasLarge = true;
    }
    trustedItems.push({
      id: item.id,
      name: product.name,
      variant: item.variant,
      variantKey: vkey,
      qty,
      priceNgn,
      priceUsd,
    });
  }

  const zone = String(body.delivery_zone || 'pickup');
  const method = String(body.delivery_method || 'pickup');
  const deliveryNgn = method === 'ship' ? serverDeliveryFee(zone, hasLarge, 'ngn') : 0;
  const deliveryUsd = method === 'ship' ? serverDeliveryFee(zone, hasLarge, 'usd') : 0;
  const totalNgn = subtotalNgn + deliveryNgn;
  const totalUsd = +(subtotalUsd + deliveryUsd).toFixed(2);

  return {
    productCache,
    trustedItems,
    hasLarge,
    zone,
    method,
    subtotalNgn,
    subtotalUsd: +subtotalUsd.toFixed(2),
    deliveryNgn,
    deliveryUsd,
    totalNgn,
    totalUsd,
  };
}

// ── QUOTE SIGNING (HMAC) ──────────────────────────────────────────────────────
function shopQuoteSecret() {
  return process.env.SHOP_QUOTE_SECRET
      || process.env.ADMIN_SESSION_SECRET
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || 'dev-shop-quote-secret';
}

function signShopQuote(payload) {
  return crypto.createHmac('sha256', shopQuoteSecret()).update(JSON.stringify(payload)).digest('hex');
}

function makeShopQuote(checkout, extra = {}) {
  const now = Date.now();
  const payload = {
    v: 1,
    iat: now,
    exp: now + 15 * 60 * 1000,
    items: checkout.trustedItems.map(i => ({ id: i.id, variantKey: i.variantKey, qty: i.qty })),
    delivery_method: checkout.method,
    delivery_zone: checkout.zone,
    subtotal_ngn: checkout.subtotalNgn,
    subtotal_usd: checkout.subtotalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    delivery_fee_usd: checkout.deliveryUsd,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    ...extra,
  };
  return { ...payload, sig: signShopQuote(payload) };
}

function verifyShopQuote(quote, checkout, expected = {}) {
  if (!quote || typeof quote !== 'object') return false;
  const { sig, ...payload } = quote;
  if (!sig || Date.now() > Number(payload.exp || 0)) return false;
  const expectedSig = signShopQuote(payload);
  const sigBuf = Buffer.from(String(sig), 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  if (Number(payload.total_ngn) !== checkout.totalNgn) return false;
  if (Number(payload.total_usd) !== checkout.totalUsd) return false;
  if (String(payload.delivery_method) !== checkout.method) return false;
  if (String(payload.delivery_zone) !== checkout.zone) return false;
  const quoteItems = JSON.stringify(payload.items || []);
  const trustedItems = JSON.stringify(checkout.trustedItems.map(i => ({ id: i.id, variantKey: i.variantKey, qty: i.qty })));
  if (quoteItems !== trustedItems) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && String(payload[key] || '') !== String(value)) return false;
  }
  return true;
}

function jsonError(e) {
  return json(e.statusCode || 500, {
    error: e.message || 'Server error',
    product_id: e.product_id,
    variant: e.variant,
  });
}

async function fetchServerCryptoPrice(asset) {
  const symbol = asset === 'xtz' ? 'XTZUSDT' : 'ETHUSDT';
  const coingeckoId = asset === 'xtz' ? 'tezos' : 'ethereum';
  const coinbasePair = asset === 'xtz' ? 'XTZ-USD' : 'ETH-USD';
  const TIMEOUT_MS = 7000; // raised from 3500 — Netlify cold starts + slow upstreams
  const errors = [];

  async function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  }
  async function binance() {
    const r = await withTimeout(fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`), TIMEOUT_MS);
    if (!r.ok) throw new Error(`binance ${r.status}`);
    const d = await r.json();
    const price = Number(d.price);
    if (!price || price <= 0) throw new Error('bad binance rate');
    return price;
  }
  async function coingecko() {
    const r = await withTimeout(fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`), TIMEOUT_MS);
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const d = await r.json();
    const price = Number(d?.[coingeckoId]?.usd);
    if (!price || price <= 0) throw new Error('bad coingecko rate');
    return price;
  }
  async function coinbase() {
    const r = await withTimeout(fetch(`https://api.coinbase.com/v2/prices/${coinbasePair}/spot`), TIMEOUT_MS);
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    const d = await r.json();
    const price = Number(d?.data?.amount);
    if (!price || price <= 0) throw new Error('bad coinbase rate');
    return price;
  }

  // Try each source; collect errors so a total failure is diagnosable in logs.
  const sources = [['binance', binance], ['coingecko', coingecko], ['coinbase', coinbase]];
  const settled = await Promise.allSettled(sources.map(([, fn]) => fn()));
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled' && settled[i].value > 0) return settled[i].value;
    errors.push(`${sources[i][0]}: ${settled[i].reason?.message || settled[i].reason}`);
  }
  console.error(`[shop-quote] all crypto price sources failed for ${asset}:`, errors.join(' | '));
  return null;
}

async function handleShopQuote(ctx, supabase) {
  if (ctx.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const body = ctx.body || {};
    const checkout = await computeShopCheckout(body, supabase);
    const method = String(body.payment_method || '').slice(0, 40);
    const payerAddress = String(body.payer_address || '').slice(0, 120);
    const paymentRef = String(body.payment_ref || '').slice(0, 200);
    const extra = { payment_method: method };
    if (payerAddress) extra.payer_address = payerAddress;
    if (paymentRef) extra.payment_ref = paymentRef;
    if (method === 'eth' || method === 'tezos') {
      const asset = method === 'tezos' ? 'xtz' : 'eth';
      const price = await fetchServerCryptoPrice(asset);
      if (!price) return json(503, { error: `${asset.toUpperCase()} rate unavailable (price sources unreachable from server)` });
      extra.crypto_asset = asset;
      extra.crypto_usd_price = price;
      extra.crypto_amount = asset === 'eth'
        ? +(checkout.totalUsd / price).toFixed(6)
        : +(checkout.totalUsd / price).toFixed(4);
    } else if (method === 'usdc' || method === 'usdt') {
      extra.crypto_asset = method;
      extra.crypto_amount = +checkout.totalUsd.toFixed(2);
    }
    const quote = makeShopQuote(checkout, extra);
    return json(200, { ok: true, quote, checkout });
  } catch (e) {
    return jsonError(e);
  }
}

async function handleShopPaymentInit(ctx, supabase) {
  if (ctx.method !== 'POST') return json(405, { error: 'Method not allowed' });
  try {
    const body = ctx.body || {};
    const provider = String(body.provider || '').toLowerCase();
    if (!['paystack','flutterwave'].includes(provider)) {
      return json(400, { error: 'Unsupported payment provider' });
    }
    const checkout = await computeShopCheckout(body, supabase);
    const reference = `${provider === 'paystack' ? 'KW' : 'KW-FW'}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const quote = makeShopQuote(checkout, { payment_method: provider, payment_ref: reference });
    const email = String(body.email || '').slice(0, 320);
    const name = String(body.name || '').slice(0, 200);
    const phone = String(body.phone || '').slice(0, 60);
    const callbackUrl = String(body.callback_url || '').slice(0, 500);

    if (provider === 'paystack') {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) return json(500, { error: 'Paystack secret key not configured' });
      const r = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          email,
          amount: checkout.totalNgn * 100,
          currency: 'NGN',
          reference,
          callback_url: callbackUrl || undefined,
          metadata: { name, phone, quote },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.status === false) throw new Error(data.message || 'Paystack initialization failed');
      return json(200, { ok: true, provider, reference, quote, checkout, ...data.data });
    }

    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) return json(500, { error: 'Flutterwave secret key not configured' });
    const r = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        tx_ref: reference,
        amount: checkout.totalNgn,
        currency: 'NGN',
        redirect_url: callbackUrl || undefined,
        customer: { email, name, phonenumber: phone },
        customizations: { title: "Kay's Works", description: 'Shop order' },
        meta: { quote },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.status === 'error') throw new Error(data.message || 'Flutterwave initialization failed');
    return json(200, { ok: true, provider, reference, quote, checkout, link: data.data?.link });
  } catch (e) {
    return jsonError(e);
  }
}

// ── ON-CHAIN PAYMENT VERIFICATION ─────────────────────────────────────────────
const ERC20_CONTRACTS = {
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
};
const ERC20_DECIMALS = { usdc: 6, usdt: 6 };
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function normEvmAddress(addr) {
  return String(addr || '').trim().toLowerCase();
}

function evmTopicAddress(topic) {
  const t = String(topic || '').toLowerCase();
  return t.startsWith('0x') && t.length === 66 ? '0x' + t.slice(26) : '';
}

function decimalToUnits(value, decimals) {
  const [whole, frac = ''] = String(value || '0').split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(padded || '0');
}

async function ethRpc(method, params = []) {
  const rpcUrl = process.env.ETH_RPC_URL || process.env.EVM_RPC_URL;
  if (!rpcUrl) {
    const err = new Error('ETH_RPC_URL is required for on-chain crypto verification');
    err.statusCode = 503;
    throw err;
  }
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error?.message || `Ethereum RPC ${method} failed`);
  return data.result;
}

async function getShopPaymentAddresses(supabase) {
  const { data } = await supabase
    .from('shop_config')
    .select('eth_address, tezos_address')
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  return {
    eth: process.env.SHOP_ETH_ADDRESS || data?.eth_address || '',
    tezos: process.env.SHOP_TEZOS_ADDRESS || data?.tezos_address || '',
  };
}

async function verifyEvmPayment({ method, txHash, payerAddress, quote, payeeAddress }) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('Invalid Ethereum transaction hash');
  const tx = await ethRpc('eth_getTransactionByHash', [txHash]);
  const receipt = await ethRpc('eth_getTransactionReceipt', [txHash]);
  if (!tx || !receipt) {
    const err = new Error('Transaction is not confirmed yet');
    err.statusCode = 409;
    throw err;
  }
  if (String(receipt.status).toLowerCase() !== '0x1') throw new Error('Transaction failed on-chain');
  const latestBlockHex = await ethRpc('eth_blockNumber', []);
  const confirmations = Number(BigInt(latestBlockHex) - BigInt(receipt.blockNumber) + 1n);
  const minConfirmations = Number(process.env.CRYPTO_MIN_CONFIRMATIONS || 1);
  if (confirmations < minConfirmations) {
    const err = new Error(`Waiting for ${minConfirmations} confirmation(s)`);
    err.statusCode = 409;
    throw err;
  }

  const claimedFrom = normEvmAddress(payerAddress);
  const expectedTo = normEvmAddress(payeeAddress);
  if (!expectedTo) throw new Error('Shop ETH address is not configured');

  if (method === 'eth') {
    if (normEvmAddress(tx.from) !== claimedFrom) throw new Error('Transaction sender does not match claimed wallet');
    if (normEvmAddress(tx.to) !== expectedTo) throw new Error('Transaction was not sent to the shop wallet');
    const paidWei = BigInt(tx.value || '0x0');
    const requiredWei = decimalToUnits(quote.crypto_amount, 18);
    if (paidWei < requiredWei) throw new Error('Transaction amount is below the quoted ETH amount');
    return { confirmations, received_amount: Number(paidWei) / 1e18 };
  }

  const contract = normEvmAddress(ERC20_CONTRACTS[method]);
  const decimals = ERC20_DECIMALS[method];
  const required = decimalToUnits(quote.crypto_amount, decimals);
  const matchingLog = (receipt.logs || []).find(log =>
    normEvmAddress(log.address) === contract &&
    String(log.topics?.[0] || '').toLowerCase() === ERC20_TRANSFER_TOPIC &&
    evmTopicAddress(log.topics?.[1]) === claimedFrom &&
    evmTopicAddress(log.topics?.[2]) === expectedTo &&
    BigInt(log.data || '0x0') >= required
  );
  if (!matchingLog) throw new Error(`${method.toUpperCase()} transfer to the shop wallet was not found for the quoted amount`);
  return { confirmations, received_amount: Number(BigInt(matchingLog.data || '0x0')) / (10 ** decimals) };
}

async function verifyTezosPayment({ opHash, payerAddress, quote, payeeAddress }) {
  if (!/^o[1-9A-HJ-NP-Za-km-z]{50}$/.test(opHash)) throw new Error('Invalid Tezos operation hash');
  if (!payeeAddress) throw new Error('Shop Tezos address is not configured');
  const api = (process.env.TZKT_API_URL || 'https://api.tzkt.io').replace(/\/$/, '');
  const r = await fetch(`${api}/v1/operations/transactions?hash=${encodeURIComponent(opHash)}`, {
    headers: { Accept: 'application/json' },
  });
  const rows = await r.json().catch(() => []);
  if (!r.ok) throw new Error('Tezos verification API failed');
  const requiredMutez = decimalToUnits(quote.crypto_amount, 6);
  const match = (Array.isArray(rows) ? rows : []).find(tx =>
    String(tx.status || '').toLowerCase() === 'applied' &&
    String(tx.sender?.address || tx.sender?.alias || '').toLowerCase() === String(payerAddress).toLowerCase() &&
    String(tx.target?.address || tx.target?.alias || '').toLowerCase() === String(payeeAddress).toLowerCase() &&
    BigInt(tx.amount || 0) >= requiredMutez
  );
  if (!match) throw new Error('Tezos transaction to the shop wallet was not found for the quoted amount');
  return { confirmations: match.confirmations || null, received_amount: Number(match.amount || 0) / 1e6 };
}

async function verifyCryptoPaymentOnChain({ paymentMethod, paymentRef, payerAddress, quote, supabase }) {
  const addresses = await getShopPaymentAddresses(supabase);
  if (paymentMethod === 'tezos') {
    return verifyTezosPayment({
      opHash: paymentRef,
      payerAddress,
      quote,
      payeeAddress: addresses.tezos,
    });
  }
  return verifyEvmPayment({
    method: paymentMethod,
    txHash: paymentRef,
    payerAddress,
    quote,
    payeeAddress: addresses.eth,
  });
}

async function verifyCardPayment({ provider, reference, expectedTotalNgn }) {
  if (!reference) {
    const e = new Error('Payment reference is required');
    e.statusCode = 400;
    throw e;
  }

  async function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Payment verification timed out')), ms)),
    ]);
  }

  if (provider === 'paystack') {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) { const e = new Error('Paystack secret key not configured'); e.statusCode = 500; throw e; }
    let data;
    try {
      const r = await withTimeout(fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${secret}` } }
      ), 8000);
      data = await r.json().catch(() => ({}));
    } catch (err) {
      const e = new Error(`Could not reach Paystack to verify payment: ${err.message}`);
      e.statusCode = 502; throw e;
    }
    const tx = data && data.data;
    if (!data || data.status !== true || !tx || tx.status !== 'success') {
      const e = new Error('Paystack reports this payment was not completed');
      e.statusCode = 402; throw e;
    }
    const paidNgn = Number(tx.amount || 0) / 100;
    if (String(tx.currency || 'NGN') !== 'NGN' || paidNgn + 0.5 < expectedTotalNgn) {
      const e = new Error('Paystack payment amount does not match the order total');
      e.statusCode = 402; throw e;
    }
    return { provider, reference, paid_ngn: paidNgn, gateway_status: tx.status };
  }

  if (provider === 'flutterwave') {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) { const e = new Error('Flutterwave secret key not configured'); e.statusCode = 500; throw e; }
    let data;
    try {
      const r = await withTimeout(fetch(
        `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${secret}` } }
      ), 8000);
      data = await r.json().catch(() => ({}));
    } catch (err) {
      const e = new Error(`Could not reach Flutterwave to verify payment: ${err.message}`);
      e.statusCode = 502; throw e;
    }
    const tx = data && data.data;
    if (!data || data.status !== 'success' || !tx || tx.status !== 'successful') {
      const e = new Error('Flutterwave reports this payment was not completed');
      e.statusCode = 402; throw e;
    }
    const paidNgn = Number(tx.amount || 0);
    if (String(tx.currency || 'NGN') !== 'NGN' || paidNgn + 0.5 < expectedTotalNgn) {
      const e = new Error('Flutterwave payment amount does not match the order total');
      e.statusCode = 402; throw e;
    }
    return { provider, reference, paid_ngn: paidNgn, gateway_status: tx.status };
  }

  const e = new Error('Unsupported card provider for verification');
  e.statusCode = 400;
  throw e;
}

// ── STOCK CLAIM / RELEASE ─────────────────────────────────────────────────────
async function claimVariantStock(supabase, item) {
  const vkey = item.variantKey || item.variant;
  const { data, error } = await supabase.rpc('decrement_variant_stock', {
    p_id: item.id,
    p_variant_key: vkey,
    p_qty: item.qty,
  });
  if (error) {
    const e = new Error(`Stock claim failed for ${item.name || item.id}: ${error.message}`);
    e.statusCode = 500;
    throw e;
  }
  return { ok: data === true };
}

async function releaseVariantStock(supabase, item) {
  const vkey = item.variantKey || item.variant;
  try {
    const { error } = await supabase.rpc('decrement_variant_stock', {
      p_id: item.id,
      p_variant_key: vkey,
      p_qty: -item.qty,
    });
    if (error) console.error('[shop-order] stock release failed:', item.id, vkey, error.message);
  } catch (e) {
    console.error('[shop-order] stock release threw:', item.id, vkey, e.message);
  }
}

// ── ORDER ─────────────────────────────────────────────────────────────────────
async function handleShopOrder(ctx, supabase) {
  if (ctx.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = ctx.body || {};
  let checkout;
  try {
    checkout = await computeShopCheckout(body, supabase);
  } catch (e) {
    return jsonError(e);
  }

  const paymentMethod = String(body.payment_method || '').slice(0, 40);
  const paymentRef = String(body.payment_ref || '').slice(0, 200);
  const payerAddress = String(body.payer_address || '').slice(0, 120);
  const quoteRequired = ['paystack','flutterwave','eth','tezos','usdc','usdt'].includes(paymentMethod);
  if (quoteRequired && !verifyShopQuote(body.checkout_quote, checkout, {
    payment_method: paymentMethod,
    ...(paymentMethod === 'paystack' || paymentMethod === 'flutterwave' ? { payment_ref: paymentRef } : {}),
    ...(payerAddress ? { payer_address: payerAddress } : {}),
  })) {
    return json(400, { error: 'Invalid or expired server checkout quote' });
  }
  const isCryptoPayment = ['eth','tezos','usdc','usdt'].includes(paymentMethod);
  if (isCryptoPayment) {
    if (!paymentRef) return json(400, { error: 'Crypto transaction hash is required' });
    if (!payerAddress) return json(400, { error: 'Sending wallet address is required' });
    const { data: existingOrder, error: existingError } = await supabase
      .from('shop_orders')
      .select('id')
      .eq('payment_ref', paymentRef)
      .maybeSingle();
    if (existingError && existingError.code !== 'PGRST116') return json(500, { error: existingError.message });
    if (existingOrder) return json(409, { error: 'This crypto transaction has already been submitted for an order' });
  }
  let chainVerification = null;
  if (isCryptoPayment) {
    try {
      chainVerification = await verifyCryptoPaymentOnChain({
        paymentMethod,
        paymentRef,
        payerAddress,
        quote: body.checkout_quote,
        supabase,
      });
    } catch (e) {
      return jsonError(e);
    }
  }

  const isCardPayment = ['paystack', 'flutterwave'].includes(paymentMethod);
  let cardVerification = null;
  if (isCardPayment) {
    try {
      cardVerification = await verifyCardPayment({
        provider: paymentMethod,
        reference: paymentRef,
        expectedTotalNgn: checkout.totalNgn,
      });
    } catch (e) {
      return jsonError(e);
    }
    const { data: dupe, error: dupeErr } = await supabase
      .from('shop_orders')
      .select('id')
      .eq('payment_ref', paymentRef)
      .maybeSingle();
    if (dupeErr && dupeErr.code !== 'PGRST116') return json(500, { error: dupeErr.message });
    if (dupe) return json(409, { error: 'This payment has already been recorded for an order' });
  }

  const paymentConfirmed = isCryptoPayment || isCardPayment;

  const claimed = [];
  for (const item of checkout.trustedItems) {
    let result;
    try {
      result = await claimVariantStock(supabase, item);
    } catch (e) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return jsonError(e);
    }
    if (!result.ok) {
      for (const c of claimed) await releaseVariantStock(supabase, c);
      return json(409, {
        error: `Sold out: ${item.name} · ${item.variant} is no longer available`,
        product_id: item.id,
        variant: item.variant,
        sold_out: true,
      });
    }
    claimed.push(item);
  }

  const { data: order, error: orderError } = await supabase
    .from('shop_orders')
    .insert({
      customer_name:   String(body.name    || '').slice(0, 200),
      email:           String(body.email   || '').slice(0, 320),
      phone:           String(body.phone   || '').slice(0, 60),
      address:         String(body.address || '').slice(0, 500),
      items:           checkout.trustedItems,
      total_ngn:       checkout.totalNgn,
      total_usd:       checkout.totalUsd,
      delivery_fee_ngn: checkout.deliveryNgn,
      delivery_method:  checkout.method.slice(0, 40),
      delivery_zone:    checkout.zone.slice(0, 40),
      payment_method:  paymentMethod,
      payment_ref:     paymentRef,
      status: paymentConfirmed ? 'paid' : 'pending',
    })
    .select('id')
    .single();
  if (orderError) {
    for (const c of claimed) await releaseVariantStock(supabase, c);
    return json(500, { error: orderError.message });
  }

  return json(200, {
    ok: true,
    order_id: order.id,
    total_ngn: checkout.totalNgn,
    total_usd: checkout.totalUsd,
    delivery_fee_ngn: checkout.deliveryNgn,
    chain_verification: chainVerification,
    card_verification: cardVerification,
  });
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
async function handleShopConfig(ctx, supabase) {
  if (ctx.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const { data, error } = await supabase
    .from('shop_config')
    .select('*')
    .order('id', { ascending: true })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') return json(500, { error: error.message });
  return json(200, data || {});
}

// ── Netlify entry point ───────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  const ctx = parseEvent(event);
  const action = (ctx.query.action || '').toString();
  const supabase = getSupabase();

  try {
    switch (action) {
      case 'shop-products':     return await handleShopProducts(ctx, supabase);
      case 'shop-config':       return await handleShopConfig(ctx, supabase);
      case 'shop-quote':        return await handleShopQuote(ctx, supabase);
      case 'shop-payment-init': return await handleShopPaymentInit(ctx, supabase);
      case 'shop-order':        return await handleShopOrder(ctx, supabase);
      default:
        return json(404, { error: `Unknown shop action: ${action}` });
    }
  } catch (e) {
    return jsonError(e);
  }
};
