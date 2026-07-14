export function isWildcardHost(host: string | null | undefined): boolean {
  return host === '0.0.0.0' || host === '::';
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

// Use localhost for connectable loopback and wildcard addresses in browser-facing URLs.
export function getConnectableHost(host: string | null | undefined): string {
  if (!host) {
    return 'localhost';
  }
  return isWildcardHost(host) || isLoopbackHost(host) ? 'localhost' : host;
}
