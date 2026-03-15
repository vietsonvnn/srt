// =============================================================================
// SRT Fixer — Cloudflare Worker Entry Point
// Serves frontend HTML + handles API routes
// =============================================================================

import { handleFix, CORS_HEADERS } from './worker.js';
import HTML from './frontend.html';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // API routes
    if (url.pathname === '/api/fix' && request.method === 'POST') {
      return handleFix(request, env);
    }

    // Serve frontend for all other GET requests
    if (request.method === 'GET') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  },
};
