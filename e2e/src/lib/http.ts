/**
 * A minimal API client that behaves like the browser app: it keeps the `jsid` cookie,
 * and sends `X-Journal: 1` plus the configured Origin on every non-GET request (SPEC §5).
 */

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or undefined for empty / non-JSON bodies. */
  body: T;
  /** Raw body bytes (for blob downloads). */
  bytes: Uint8Array;
}

export interface RequestOptions {
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
  /** Omit the X-Journal / Origin headers (to test the CSRF check). */
  noCsrfHeaders?: boolean;
}

export class ApiClient {
  private cookies = new Map<string, string>();

  constructor(
    readonly baseUrl: string,
    readonly origin: string,
    readonly label: string,
  ) {}

  get hasSession(): boolean {
    return this.cookies.has('jsid');
  }

  clearCookies() {
    this.cookies.clear();
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (method !== 'GET' && method !== 'HEAD' && !opts.noCsrfHeaders) {
      headers['X-Journal'] = '1';
      headers['Origin'] = this.origin;
    }
    if (this.cookies.size) {
      headers['Cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body) {
      headers['Content-Type'] ??= 'application/octet-stream';
      body = new Uint8Array(opts.body);
    }

    const res = await fetch(this.baseUrl + path, { method, headers, body, redirect: 'manual' });
    this.storeCookies(res.headers);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let parsed: unknown;
    if ((res.headers.get('Content-Type') ?? '').includes('application/json') && bytes.length) {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    }
    return { status: res.status, headers: res.headers, body: parsed as T, bytes };
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T = any>(path: string, json: unknown = {}) {
    return this.request<T>('POST', path, { json });
  }
  put<T = any>(path: string, json: unknown) {
    return this.request<T>('PUT', path, { json });
  }
  delete<T = any>(path: string) {
    return this.request<T>('DELETE', path);
  }

  private storeCookies(h: Headers) {
    for (const line of h.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v] = a.trim().split('=');
        return (k.toLowerCase() === 'max-age' && Number(v) <= 0) || (k.toLowerCase() === 'expires' && Date.parse(v) < Date.now());
      });
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}
