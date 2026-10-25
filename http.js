/**
 * The one JSON response shape both Host routes use.
 * @module @local/dsh-balance/http
 */

/**
 * Build a JSON response with no-store caching.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 * @returns the response.
 */
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
