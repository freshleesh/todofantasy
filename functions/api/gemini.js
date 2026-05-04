// Cloudflare Pages Function — /api/gemini
// 프론트가 보낸 Gemini 호출 본문을 그대로 forward. 키는 서버 환경변수에서.
// - Origin 검사: 같은 도메인에서 온 요청만 허용
// - IP 기반 단순 rate limit (isolate 메모리 — 완벽하진 않지만 자유 사용용으로는 충분)

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 20;            // IP당 분당 20회
const buckets = new Map();        // ip -> { start, count }

function checkRate(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  b.count += 1;
  // 메모리 보호: 너무 커지면 비움
  if (buckets.size > 5000) buckets.clear();
  return b.count <= RATE_LIMIT;
}

function isAllowedOrigin(request, url) {
  // 같은 호스트에서 온 요청만 (Pages 도메인 + 커스텀 도메인 모두)
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!isAllowedOrigin(request, url)) {
    return new Response(JSON.stringify({ error: 'forbidden origin' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRate(ip)) {
    return new Response(JSON.stringify({ error: 'rate limit exceeded — 잠시 후 다시 시도하세요' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'server misconfigured: GEMINI_API_KEY missing' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await request.text(),
    },
  );

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
