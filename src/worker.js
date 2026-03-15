// =============================================================================
// SRT Fixer — Cloudflare Worker Backend
// Receives SRT entries + original text, calls Beeknoee AI to fix transcription
// errors, returns corrected entries.
// =============================================================================

const API_ENDPOINT = 'https://platform.beeknoee.com/api/v1/chat/completions';
const DEFAULT_API_KEY = 'sk-bee-837f622110f44d64a3ca729a77695314';
const CHUNK_SIZE = 5;        // small chunks — reasoning models are slow
const MAX_RETRIES = 3;       // retries for non-429 errors
const MAX_429_RETRIES = 10;  // separate budget for rate-limit retries (concurrent_limit)
const FETCH_TIMEOUT_MS = 90_000; // 90s per API call (reasoning models need time)
const CHUNK_DELAY_MS = 3_000; // 3s delay between batches

// ─── CORS ────────────────────────────────────────────────────────────────────

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── Key Parsing ────────────────────────────────────────────────────────────

function parseKeys(keysSource) {
  const keys = (keysSource || '')
    .split('\n')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keys.length === 0) throw new Error('No API keys configured');
  return keys;
}

// ─── AI Interaction ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Fix subtitle transcription errors by comparing against the original text. Output ONLY a JSON array of corrected strings. Keep correct entries as-is. Do not merge or split entries. No explanation.`;

function buildUserPrompt(originalText, entries) {
  const numbered = entries
    .map((e, i) => `${i + 1}: ${e.text}`)
    .join('\n');

  return `Original content:
---
${originalText}
---

Subtitle entries to fix:
${numbered}

Return ONLY the JSON array of corrected texts, in the same order. No explanation.`;
}

/**
 * Extract a JSON array from the AI response text, handling markdown fences
 * and other wrappers the model might add.
 */
function parseAIResponse(raw) {
  let cleaned = raw.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Attempt direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    throw new Error('Parsed value is not an array');
  } catch {
    // Try to find the first [...] block in the text
    const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    }
    throw new Error('Failed to parse AI response as JSON array');
  }
}

/**
 * Call the Beeknoee API for a single chunk with a specific key + retries.
 */
async function callAIWithKey(entries, originalText, key, model) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(originalText, entries) },
  ];

  let lastError = null;
  let errorRetries = 0;
  let rateLimitRetries = 0;

  while (errorRetries < MAX_RETRIES && rateLimitRetries < MAX_429_RETRIES) {
    let response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
          max_tokens: 8192,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? 'API request timed out'
        : `Network error: ${err.message}`;
      lastError = new Error(msg);
      errorRetries++;
      continue;
    }

    const responseText = await response.text();

    // Rate-limit / concurrent-limit — wait and retry (separate budget)
    if (response.status === 429) {
      rateLimitRetries++;
      const isConcurrent = responseText.includes('concurrent');
      // Concurrent: another request is processing, wait longer (10-30s)
      // Rate-limit: wait based on retry-after header
      const baseWait = isConcurrent
        ? Math.min(10_000 + rateLimitRetries * 5_000, 30_000)
        : Math.min(parseInt(response.headers.get('retry-after') || '5', 10) * 1000, 15_000);
      await new Promise(r => setTimeout(r, baseWait));
      lastError = new Error(`429 (${isConcurrent ? 'concurrent' : 'rate-limit'}), retry ${rateLimitRetries}/${MAX_429_RETRIES}`);
      continue;
    }

    // Other error
    if (!response.ok) {
      lastError = new Error(`API error (HTTP ${response.status}): ${responseText.slice(0, 300)}`);
      errorRetries++;
      continue;
    }

    // Parse the successful response
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      lastError = new Error('API returned non-JSON response');
      errorRetries++;
      continue;
    }

    const msg = parsed?.choices?.[0]?.message;
    const content = msg?.content;
    if (!content && !msg?.reasoning_content) {
      lastError = new Error('API response missing content');
      errorRetries++;
      continue;
    }
    if (!content) {
      lastError = new Error('Model used all tokens for reasoning, no output produced');
      errorRetries++;
      continue;
    }

    try {
      return parseAIResponse(content);
    } catch (err) {
      lastError = new Error(`AI response parse error: ${err.message}`);
      errorRetries++;
      continue;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

// ─── Chunking ────────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─── Main Fix Logic ──────────────────────────────────────────────────────────

export async function handleFix(request, env) {
  // ── Parse & validate request body ──
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { srtEntries, originalText, apiKeys, model: requestModel } = body || {};

  if (!Array.isArray(srtEntries) || srtEntries.length === 0) {
    return corsResponse(
      { success: false, error: 'srtEntries must be a non-empty array' },
      400,
    );
  }

  if (typeof originalText !== 'string' || originalText.trim().length === 0) {
    return corsResponse(
      { success: false, error: 'originalText must be a non-empty string' },
      400,
    );
  }

  // Validate each entry has required fields
  for (let i = 0; i < srtEntries.length; i++) {
    const e = srtEntries[i];
    if (
      e == null ||
      typeof e.index === 'undefined' ||
      typeof e.timeCode !== 'string' ||
      typeof e.text !== 'string'
    ) {
      return corsResponse(
        {
          success: false,
          error: `Invalid entry at position ${i}: must have index, timeCode, and text`,
        },
        400,
      );
    }
  }

  // ── Setup ──
  // Priority: client keys > env var > hardcoded default
  const keysSource = (typeof apiKeys === 'string' && apiKeys.trim())
    ? apiKeys
    : (env.API_KEYS || DEFAULT_API_KEY);
  let keys;
  try {
    keys = parseKeys(keysSource);
  } catch (err) {
    return corsResponse({ success: false, error: err.message }, 400);
  }
  const model = (typeof requestModel === 'string' && requestModel.trim())
    ? requestModel
    : (env.MODEL || 'glm-4.7-flash');

  // ── Chunk & process (parallel batches) ──
  // Each batch runs up to N chunks in parallel (one per key).
  // e.g. 3 keys, 7 chunks → batch1: [c1,c2,c3], batch2: [c4,c5,c6], batch3: [c7]
  const chunks = chunkArray(srtEntries, CHUNK_SIZE);
  const batches = chunkArray(chunks, keys.length);
  const allCorrected = new Array(chunks.length);

  try {
    let chunkOffset = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      if (bi > 0) {
        await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
      }

      const batch = batches[bi];
      const results = await Promise.all(
        batch.map((chunk, i) =>
          callAIWithKey(chunk, originalText, keys[i % keys.length], model)
        )
      );

      for (let i = 0; i < results.length; i++) {
        if (results[i].length !== batch[i].length) {
          return corsResponse(
            {
              success: false,
              error: `AI returned ${results[i].length} entries but expected ${batch[i].length}`,
            },
            502,
          );
        }
        allCorrected[chunkOffset + i] = results[i];
      }
      chunkOffset += batch.length;
    }
  } catch (err) {
    const status = err.message.includes('exhausted') || err.message.includes('rate-limited') ? 503 : 502;
    return corsResponse({ success: false, error: `Processing failed: ${err.message}` }, status);
  }

  // Flatten chunk results into a single array
  const flatCorrected = allCorrected.flat();

  // ── Build response ──
  let fixedCount = 0;

  const fixed = srtEntries.map((entry, i) => {
    const correctedText = String(flatCorrected[i]);
    const changed = correctedText !== entry.text;
    if (changed) fixedCount++;

    return {
      index: entry.index,
      timeCode: entry.timeCode,
      text: correctedText,
      original: entry.text,
      changed,
    };
  });

  return corsResponse({
    success: true,
    fixed,
    stats: {
      total: srtEntries.length,
      errors: fixedCount,
      fixed: fixedCount,
    },
  });
}

// Exports: handleFix, corsResponse, CORS_HEADERS
