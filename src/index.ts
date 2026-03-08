export interface Env {
  /**
   * 多个 URL：支持 JSON 数组、逗号分隔、或按行分隔
   * 例如：
   * - ["https://a.com","https://b.com"]
   * - https://a.com,https://b.com
   * - https://a.com\nhttps://b.com
   */
  URLS?: string;
  TIMEOUT_MS?: string;
  CONCURRENCY?: string;
  TOKEN?: string;
}

type KeepaliveResult = {
  url: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
};

type KeepaliveSummary = {
  reason: "scheduled" | "manual";
  startedAt: string;
  finishedAt: string;
  timeoutMs: number;
  concurrency: number;
  total: number;
  ok: number;
  failed: number;
  results: KeepaliveResult[];
};

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseUrls(raw: string | undefined): string[] {
  const v = (raw ?? "").trim();
  if (!v) return [];

  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) {
        return arr.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch {
      // 继续按文本解析
    }
  }

  return v
    .split(/[\s,;]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function timingSafeEqual(a: string, b: string): boolean {
  // 简易定长比较，避免明显的早退；不依赖 Node crypto
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const max = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < max; i++) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function readBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ? m[1].trim() : null;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "cache-control": "no-cache",
        pragma: "no-cache"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(safeLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function runKeepalive(env: Env, reason: KeepaliveSummary["reason"]): Promise<KeepaliveSummary> {
  const timeoutMs = parseIntOr(env.TIMEOUT_MS, 8000);
  const concurrency = parseIntOr(env.CONCURRENCY, 3);
  const urls = parseUrls(env.URLS);

  const startedAt = new Date().toISOString();
  const results = await mapWithConcurrency(urls, concurrency, async (url) => {
    const start = Date.now();
    try {
      // 基本校验：确保是合法 URL（避免 fetch 抛奇怪错误信息）
      new URL(url);
      const resp = await fetchWithTimeout(url, timeoutMs);
      const durationMs = Date.now() - start;
      return { url, ok: resp.ok, status: resp.status, durationMs } satisfies KeepaliveResult;
    } catch (e) {
      const durationMs = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      return { url, ok: false, durationMs, error: msg } satisfies KeepaliveResult;
    }
  });

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const finishedAt = new Date().toISOString();

  return {
    reason,
    startedAt,
    finishedAt,
    timeoutMs,
    concurrency,
    total: results.length,
    ok,
    failed,
    results
  };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/do") {
      const expected = (env.TOKEN ?? "").trim();
      const provided = (url.searchParams.get("token") ?? readBearerToken(request) ?? "").trim();

      if (!expected) {
        return json({ ok: false, error: "未配置 TOKEN，已禁用手动触发" }, { status: 503 });
      }
      if (!provided || !timingSafeEqual(provided, expected)) {
        return json({ ok: false, error: "token 无效" }, { status: 401 });
      }

      const summary = await runKeepalive(env, "manual");
      return json({ ok: true, ...summary });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        name: "keepalive-worker",
        now: new Date().toISOString()
      });
    }

    return json({ ok: false, error: "Not Found" }, { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const summary = await runKeepalive(env, "scheduled");
        console.log(
          JSON.stringify(
            {
              reason: summary.reason,
              startedAt: summary.startedAt,
              finishedAt: summary.finishedAt,
              timeoutMs: summary.timeoutMs,
              concurrency: summary.concurrency,
              total: summary.total,
              ok: summary.ok,
              failed: summary.failed
            },
            null,
            2
          )
        );
        for (const r of summary.results) {
          if (r.ok) {
            console.log(`[OK] ${r.status} ${r.durationMs}ms ${r.url}`);
          } else {
            console.log(`[FAIL] ${r.durationMs}ms ${r.url} :: ${r.error ?? "unknown error"}`);
          }
        }
      })()
    );
  }
};
