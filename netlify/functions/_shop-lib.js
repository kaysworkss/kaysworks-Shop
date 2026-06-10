// ─────────────────────────────────────────────────────
//  Shared helpers for the Netlify shop functions (native)
//  Àpótí Ọlọ́wẹ̀ · Kaysworks 2026
// ─────────────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');

// Supabase client — created once, reused across warm invocations
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Cache-Control': 'no-store',
};

// Build a Netlify Function HTTP response with CORS + JSON body.
function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

// Preflight helper
function preflight() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}

// Parse a Netlify event into { method, query, headers, body }
function parseEvent(event) {
  const method = event.httpMethod;
  const query = event.queryStringParameters || {};
  // Netlify lower-cases header names already.
  const headers = event.headers || {};

  let body = {};
  if (event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    const ctype = (headers['content-type'] || '').toLowerCase();
    if (ctype.includes('application/json')) {
      try { body = JSON.parse(raw); } catch { body = {}; }
    } else {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
  }
  return { method, query, headers, body };
}

module.exports = { getSupabase, json, preflight, parseEvent };
