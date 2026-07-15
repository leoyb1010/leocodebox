import { IS_PLATFORM } from "../constants/config";

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      localStorage.setItem('auth-token', refreshedToken);
    }
    return response;
  });
};

export class ApiError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function apiRequest(url, options = {}) {
  const response = await authenticatedFetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '');
  if (!response.ok) {
    // globalErrorHandler sends `error` as an object ({code,message,details}) for
    // AppError paths; unwrap it to its string message so callers never surface
    // "[object Object]". Plain-string error fields still pass through unchanged.
    const errField = payload && typeof payload === 'object' ? payload.error : null;
    const serverMessage = (errField && typeof errField === 'object' ? errField.message : errField)
      || (payload && typeof payload === 'object' ? payload.message || payload.details : payload);
    throw new ApiError(serverMessage || `Request failed (${response.status}).`, {
      status: response.status,
      payload,
    });
  }
  return payload;
}
