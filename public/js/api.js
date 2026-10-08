let csrfToken = '';
export function setCsrfToken(value = '') { csrfToken = value; }
export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (csrfToken && !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers,
    body: options.body === undefined || typeof options.body === 'string' ? options.body : JSON.stringify(options.body) });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'We could not complete that request. Try again.');
    error.status = response.status; error.code = data?.error?.code || 'REQUEST_FAILED'; throw error;
  }
  return data;
}
export function get(path) { return api(path); }
export function post(path, body = {}) { return api(path, { method: 'POST', body }); }
export function patch(path, body = {}) { return api(path, { method: 'PATCH', body }); }
export function put(path, body = {}) { return api(path, { method: 'PUT', body }); }
