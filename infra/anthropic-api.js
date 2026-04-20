// infra/anthropic-api.js — Anthropic Messages API wrapper
// DOMAIN-BLIND per §P4.14. Hardcoded URL is provider-specific, not plan-specific.
// No references to plan, repo, user identity, or any consumer details.
//
// Requires the `anthropic-dangerous-direct-browser-access` header for CORS.
// API key passed by caller per-call — never stored in this module.

(function () {
  'use strict';

  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';

  // Dispatch a single completion request.
  //
  // Args (named):
  //   apiKey        — Anthropic API key (never logged by this module)
  //   model         — model ID string
  //   maxTokens     — max_tokens for the response
  //   messages      — array of { role, content }
  //   signal        — AbortSignal for cancellation (optional)
  //   onHeartbeat   — function called every ~5s while request in flight,
  //                   receives { elapsed_s } (optional)
  //
  // Returns (on success): { content, usage, stopReason, rawBody }
  //   content     — concatenated text blocks from response
  //   usage       — { input_tokens, output_tokens, ... }
  //   stopReason  — 'end_turn' | 'max_tokens' | ...
  //   rawBody     — full response text (for debugging)
  //
  // Throws on HTTP error:
  //   err.httpStatus — HTTP status code
  //   err.body       — response body (may contain error JSON)
  async function dispatch({ apiKey, model, maxTokens, messages, signal, onHeartbeat }) {
    if (!apiKey) throw new Error('anthropic-api: apiKey required');
    if (!model) throw new Error('anthropic-api: model required');
    if (!maxTokens) throw new Error('anthropic-api: maxTokens required');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('anthropic-api: messages array required');
    }

    const startTime = Date.now();
    let heartbeatTimer = null;
    if (onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        onHeartbeat({ elapsed_s: Math.round((Date.now() - startTime) / 1000) });
      }, 5000);
    }

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
        signal,
      });

      const rawBody = await response.text();
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.httpStatus = response.status;
        err.body = rawBody;
        throw err;
      }

      const data = JSON.parse(rawBody);
      const content = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      return {
        content,
        usage: data.usage || {},
        stopReason: data.stop_reason || 'unknown',
        rawBody,
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  // Lightweight validation ping — 1-token request to verify key works.
  // Returns true on success, throws on failure (same error shape as dispatch).
  async function validateKey({ apiKey, model }) {
    // Uses 10 max_tokens (some API validation paths reject 1)
    // and a minimal prompt.
    await dispatch({
      apiKey,
      model,
      maxTokens: 10,
      messages: [{ role: 'user', content: 'ok' }],
    });
    return true;
  }

  window.anthropicApi = { dispatch, validateKey };
})();
