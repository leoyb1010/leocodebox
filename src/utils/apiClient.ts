import { ApiError, apiRequest, authenticatedFetch } from './api';

type QueryValue = string | number | boolean | null | undefined;

function withQuery(path: string, query?: Record<string, QueryValue>) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

async function rawRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await authenticatedFetch(path, options);
  if (response.ok) return response;

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '');
  // Unwrap object-shaped `error` ({code,message,details}) to its message string;
  // plain-string error fields pass through unchanged (avoids "[object Object]").
  const errField = payload && typeof payload === 'object'
    ? (payload as { error?: unknown }).error
    : null;
  const serverMessage = (errField && typeof errField === 'object'
    ? (errField as { message?: string }).message
    : errField)
    || (payload && typeof payload === 'object'
      ? (payload as { message?: string; details?: string }).message || (payload as { details?: string }).details
      : payload);
  throw new ApiError(serverMessage || `Request failed (${response.status}).`, {
    status: response.status,
    payload,
  });
}

async function streamConversationSearch(
  query: string,
  handlers: Record<string, ((data: string) => void) | undefined> = {},
  limit = 50,
  signal?: AbortSignal,
): Promise<void> {
  const response = await rawRequest(withQuery('/api/providers/search/sessions', { q: query, limit }), {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.body) throw new Error('Conversation search stream is unavailable.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      handlers[event]?.(data.join('\n'));
    }
    if (done) break;
  }
}

export const apiClient = {
  streamConversationSearch,
  raw(path: string, options?: RequestInit): Promise<Response> {
    return rawRequest(path, options);
  },
  get<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> {
    return apiRequest(withQuery(path, query), { method: 'GET', signal }) as Promise<T>;
  },
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  put<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  patch<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  delete<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return apiRequest(path, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body), signal }) as Promise<T>;
  },
  deleteQuery<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> {
    return apiRequest(withQuery(path, query), { method: 'DELETE', signal }) as Promise<T>;
  },
};
