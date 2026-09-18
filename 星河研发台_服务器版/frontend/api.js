let csrfToken = '';
export function setCsrf(value) { csrfToken = value || ''; }
export class ApiError extends Error {
  constructor(message, status, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let response;
  try { response = await fetch('/api' + path, { method, headers, credentials: 'same-origin', signal: options.signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new ApiError('无法连接服务器，请检查网络后重试。', 0, 'NETWORK'); }
  let data;
  try { data = await response.json(); }
  catch (_) { throw new ApiError('服务器返回了无法识别的内容。', response.status, 'INVALID_RESPONSE'); }
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message || '操作未完成，请重试。';
    throw new ApiError(message, response.status, data.code || data.error?.code, data.details);
  }
  if (data.csrfToken) setCsrf(data.csrfToken);
  return data;
}
export function rows(value, key) { return Array.isArray(value) ? value : value?.[key] || value?.items || []; }
