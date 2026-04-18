export interface HttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface HttpCookie {
  name: string;
  value: string;
}

export async function httpRequest(
  method: string,
  url: string,
  opts: {
    body?: unknown;
    cookies?: HttpCookie[];
    token?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };

  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }

  if (opts.cookies?.length) {
    headers["Cookie"] = opts.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  }

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let body: unknown;
  const ct = res.headers.get("content-type") ?? "";
  try {
    body = ct.includes("json") ? await res.json() : await res.text();
  } catch {
    body = null;
  }

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });

  return { status: res.status, body, headers: respHeaders };
}
