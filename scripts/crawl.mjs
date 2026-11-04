// 공개 웹페이지 크롤러 — robots.txt를 지키고, 천천히, 본문 텍스트와 대표 이미지만 가져와요.
// 외부 라이브러리 없이 Node 20 내장 fetch만 사용.

const robotsCache = new Map(); // origin → { groups } | null(없음=허용)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- robots.txt ----------
export function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  return groups;
}

const ruleToRegex = (p) =>
  new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));

export function isAllowed(groups, userAgent, path) {
  if (!groups) return true;
  const ua = userAgent.toLowerCase();
  // 내 봇 이름에 맞는 그룹이 있으면 그걸, 없으면 * 그룹 사용
  let group = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (!group) group = groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (r.path === "") { if (!r.allow) continue; }   // "Disallow:" 빈 값 = 모두 허용
    if (ruleToRegex(r.path).test(path) && (!best || r.path.length > best.path.length ||
        (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

function robotsFor(origin, opts) {
  if (!robotsCache.has(origin)) robotsCache.set(origin, loadRobots(origin, opts)); // 동시 요청 시 한 번만 받기
  return robotsCache.get(origin);
}

async function loadRobots(origin, opts) {
  let groups = null;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": opts.userAgent }, signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.ok) groups = parseRobots(await res.text());
    else if (res.status >= 500) groups = [{ agents: ["*"], rules: [{ allow: false, path: "/" }] }]; // 서버 오류면 보수적으로 차단
  } catch {
    groups = [{ agents: ["*"], rules: [{ allow: false, path: "/" }] }];
  }
  return groups;
}

// ---------- URL 보정 ----------
// 네이버 블로그 PC 주소는 본문이 iframe 안에 있어서 모바일 주소로 바꿔요.
export function normalizeUrl(url) {
  const m = url.match(/^https?:\/\/blog\.naver\.com\/([^/?#]+)\/(\d+)/);
  if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`;
  return url;
}

// ---------- HTML → 정보 추출 ----------
const decode = (s = "") =>
  s.replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || "") : "";
}

export function extract(html, baseUrl) {
  const image = meta(html, "og:image");
  const description = meta(html, "og:description") || meta(html, "description");
  // 본문 후보: 네이버 블로그 / 티스토리 / 일반 article / body
  const sliceFrom = (marker, ends) => {
    let i = html.search(marker);
    if (i < 0) return null;
    i = html.lastIndexOf("<", i);                 // 태그 시작부터
    const rest = html.slice(i);
    const j = Math.min(...ends.map((e) => { const k = rest.search(e); return k < 0 ? Infinity : rest.lastIndexOf("<", k); }));
    return rest.slice(0, Number.isFinite(j) && j > 0 ? j : 300000);
  };
  const pick =
    sliceFrom(/class="[^"]*se-main-container/i, [/se-viewer-footer|post_footer|class="[^"]*comment/i]) ||
    sliceFrom(/class="[^"]*(?:tt_article_useless_p_margin|entry-content|article-view|post-content)/i, [/class="[^"]*(?:another_category|comment|revenue_unit|container_postbtn)/i, /<\/article>/i]) ||
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/<body[\s\S]*<\/body>/i)?.[0] || html;
  const text = decode(
    pick.replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 15000);
  let img = image;
  try { if (img) img = new URL(img, baseUrl).href; } catch { img = ""; }
  return { text, image: img, description };
}

// ---------- 크롤러 ----------
export function createCrawler(opts) {
  let used = 0;
  const lastHit = new Map(); // host → 마지막 요청 시각 (같은 사이트에 연속 요청 방지)
  const stats = { fetched: 0, blockedByRobots: 0, failed: 0, skippedBudget: 0 };
  // 사이트별 진단: 어디서 왜 실패하는지 보기 위함
  const sites = new Map();
  const site = (host) => {
    if (!sites.has(host)) sites.set(host, { host, tried: 0, ok: 0, emptyText: 0, withImage: 0, robots: 0, http: {}, notHtml: 0, error: {}, textLen: 0, example: "" });
    return sites.get(host);
  };
  const fail = (d, url, why) => { stats.failed++; if (!d.example) d.example = `${why} ← ${url}`; return null; };

  async function crawl(url) {
    if (!opts.enabled) return null;
    if (used >= opts.maxPagesPerRun) { stats.skippedBudget++; return null; }
    let u;
    try { u = new URL(normalizeUrl(url)); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const d = site(u.host);
    d.tried++;

    const groups = await robotsFor(u.origin, opts);
    if (!isAllowed(groups, opts.userAgent, u.pathname + u.search)) {
      stats.blockedByRobots++; d.robots++;
      if (!d.example) d.example = `robots.txt 차단 ← ${u.href}`;
      return null;
    }

    const wait = (lastHit.get(u.host) || 0) + opts.delayMs - Date.now();
    lastHit.set(u.host, Math.max(Date.now(), (lastHit.get(u.host) || 0) + opts.delayMs));
    if (wait > 0) await sleep(wait);
    used++;

    try {
      const res = await fetch(u.href, {
        headers: { "User-Agent": opts.userAgent, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "ko-KR,ko;q=0.9" },
        redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const type = res.headers.get("content-type") || "";
      if (!res.ok) { d.http[res.status] = (d.http[res.status] || 0) + 1; return fail(d, u.href, `HTTP ${res.status}`); }
      if (!type.includes("html")) { d.notHtml++; return fail(d, u.href, `HTML 아님(${type})`); }
      const page = extract(await res.text(), res.url || u.href);
      stats.fetched++; d.ok++;
      d.textLen += page.text.length;
      if (page.image) d.withImage++;
      if (page.text.length < 100) { d.emptyText++; if (!d.example) d.example = `본문 거의 없음(${page.text.length}자) ← ${u.href}`; }
      return page;
    } catch (e) {
      const why = e.name === "TimeoutError" ? "시간 초과" : (e.cause?.code || e.message || "오류");
      d.error[why] = (d.error[why] || 0) + 1;
      return fail(d, u.href, why);
    }
  }

  // 사이트별 결과 표 (많이 시도한 순)
  function report() {
    return [...sites.values()].sort((a, b) => b.tried - a.tried).map((d) => ({
      ...d, avgText: d.ok ? Math.round(d.textLen / d.ok) : 0, textLen: undefined,
    }));
  }

  // 동시에 n개씩 처리
  async function crawlMany(urls) {
    const out = new Map();
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const url = urls[i++];
        out.set(url, await crawl(url));
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
    return out;
  }

  return { crawl, crawlMany, stats, report };
}
