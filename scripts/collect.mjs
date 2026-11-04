// 서울 디저트 레이더 수집기
//  1) 검색: "서울 디저트" + 내가 정한 동네(홍대·더현대·성수)의 디저트/디저트 팝업 + 지난번 뜬 키워드
//  2) 원문 크롤링(robots.txt 준수)으로 본문·대표이미지 보강
//  3) 디저트 단어장 자동 학습(카카오 장소 분류로 검증) → 디저트 글 1차 판별
//  4) 발견한 디저트 이름(예: 찹쌀모찌)으로 한 번 더 검색
//  5) 서울 글만: 서울 주소에서 배운 동네 이름으로 위치 판별
//  6) AI(Claude) 2차 확인: 정말 서울의 디저트 정보인지
//  7) 뜨는 키워드·가게·지역·작성자 집계
// 실행: KAKAO_REST_API_KEY=... [ANTHROPIC_API_KEY=...] node scripts/collect.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCrawler } from "./crawl.mjs";
import { aiReview } from "./ai.mjs";

const ROOT = new URL("..", import.meta.url);
const cfg = JSON.parse(await readFile(new URL("config/sources.json", ROOT), "utf8"));
const OUT = new URL("public/data/feed.json", ROOT);
const KEY = process.env.KAKAO_REST_API_KEY;
const SEED = cfg.seed;     // "디저트"
const CITY = cfg.city;     // "서울"
const AREAS = cfg.areas;   // ["홍대", "더현대", "성수"]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const stripTags = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();

// ---------- 카카오 API ----------
async function kakao(path) {
  const res = await fetch(`https://dapi.kakao.com${path}`, { headers: { Authorization: `KakaoAK ${KEY}` } });
  if (!res.ok) throw new Error(`${path.split("?")[0]} → HTTP ${res.status}: ${await res.text()}`);
  await sleep(120);
  return (await res.json()).documents ?? [];
}

async function search(type, query, { sort = "recency", size = 50, page = 1 } = {}) {
  const docs = await kakao(`/v2/search/${type}?query=${encodeURIComponent(query)}&sort=${sort}&size=${size}&page=${page}`);
  return docs.map((d) => ({
    title: stripTags(d.title), desc: stripTags(d.contents), link: d.url,
    source: d.blogname || d.cafename || "웹", date: new Date(d.datetime).toISOString(), thumb: d.thumbnail || "",
  }));
}

async function places(query, n = 15) {
  const docs = await kakao(`/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=${Math.min(n, 15)}`);
  return docs.map((d) => ({
    name: d.place_name, address: d.road_address_name || d.address_name, jibun: d.address_name,
    category: d.category_name, group: d.category_group_code, link: d.place_url,
  }));
}

// 카카오 자체 분류로 디저트 가게 판단: 카페(CE7) 또는 "음식점 > 간식 ..." 업종
const isDessertPlace = (p) => p.group === "CE7" || /(^|>)\s*간식/.test(p.category || "");
const inCity = (p) => (p.jibun || p.address || "").startsWith(CITY);

// ---------- 주소 → 지역 ----------
// "서울 성동구 성수동2가 273" → 구 "성동구", 동네 이름 ["성동", "성수"]
function regionFromAddress(addr = "") {
  const parts = addr.split(/\s+/);
  if (parts[0] !== CITY || !/[구]$/.test(parts[1] || "")) return null;
  const names = new Set([parts[1].replace(/구$/, "")]);
  const dong = parts[2] || "";
  if (/[동가]$/.test(dong)) names.add(dong.replace(/\d*가$/, "").replace(/동$/, "").replace(/\d+$/, ""));
  return { gu: parts[1], names: [...names].filter((n) => n.length >= 2) };
}

// ---------- 제목 → 단어 (간단한 한국어 토큰화) ----------
const PARTICLES = ["에서는", "으로는", "에서", "으로", "까지", "부터", "처럼", "보다", "에게", "하고", "이랑", "은", "는", "을", "를", "의", "도", "에", "로", "와", "과"];
function makeTokenizer(stop) {
  return (title = "") => {
    const out = new Set();
    for (let w of title.replace(/[^\p{Script=Hangul}#\s]/gu, " ").split(/\s+/)) {
      w = w.replace(/^#+/, "");
      for (const p of PARTICLES) {
        if (w.endsWith(p) && w.length - p.length >= 2) { w = w.slice(0, -p.length); break; }
      }
      if (w.length < 2 || w.length > 10 || stop.has(w)) continue;
      if (/[동역구시점길]$/.test(w) && stop.has(w.slice(0, -1))) continue; // "연남동", "성수역" 같은 지명
      if (w.length >= 3 && /(동|역|구)$/.test(w)) continue;                    // 처음 보는 지명도 대부분 걸러냄
      out.add(w);
    }
    return [...out];
  };
}

// ---------- 메인 ----------
async function main() {
  if (!KEY) {
    console.error("KAKAO_REST_API_KEY 가 없어요. GitHub Secrets에 등록했는지 확인하세요.");
    process.exit(1);
  }
  const crawler = createCrawler(cfg.crawl);
  const prev = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : {};
  // 지난번 데이터 중 '디저트 아님'·'서울 아님'으로 판정된 글도 다시 수집되지 않게 기억해 둠
  const byLink = new Map([...(prev.items || []), ...(prev.rejected || [])].map((it) => [it.link, it]));
  const errors = [];
  const tryDo = async (fn) => { try { return await fn(); } catch (e) { errors.push(e.message); console.warn("⚠", e.message); } };
  const cutoff = Date.now() - cfg.keepDays * 86400e3;
  const isRecent = (it) => new Date(it.date).getTime() >= cutoff;

  // --- 서울 동네 이름 사전: 지난번까지 배운 것 + 내가 정한 동네의 실제 주소 ---
  const regionIndex = { ...(prev.regionIndex || {}) };   // 동네 이름 → 구
  const areaGu = { ...(prev.areaGu || {}) };              // 홍대 → 마포구
  const learnAddress = (addr) => {
    const r = regionFromAddress(addr);
    if (r) for (const n of r.names) regionIndex[n] = r.gu;
    return r;
  };
  for (const area of AREAS) {
    if (areaGu[area]) continue;
    await tryDo(async () => {
      const ps = (await places(area)).filter(inCity);
      const count = {};
      for (const p of ps) { const r = learnAddress(p.jibun || p.address); if (r) count[r.gu] = (count[r.gu] || 0) + 1; }
      const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
      if (best) areaGu[area] = best[0];
    });
  }

  const searched = new Set();
  const collect = async (q, pages) => {
    if (searched.has(q)) return;
    searched.add(q);
    for (const type of ["blog", "cafe"]) {
      for (let page = 1; page <= pages; page++) {
        await tryDo(async () => {
          for (const r of await search(type, q, { page })) {
            if (!byLink.has(r.link)) byLink.set(r.link, { ...r, type, query: q, collectedAt: now() });
          }
        });
      }
    }
  };
  const crawlNew = async (budget) => {
    const todo = [...byLink.values()].filter((it) => !it.crawled && !it.rejected && isRecent(it))
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.max(0, budget)).map((it) => it.link);
    for (const [link, page] of await crawler.crawlMany(todo)) {
      const it = byLink.get(link);
      it.crawled = true;
      if (!page) continue;
      it.body = page.text.slice(0, 3000);
      if (!it.thumb && page.image) it.thumb = page.image;
      if ((!it.desc || it.desc.length < 40) && page.description) it.desc = page.description;
    }
  };
  const crawlLeft = () => cfg.crawl.maxPagesPerRun - crawler.stats.fetched - crawler.stats.failed - crawler.stats.blockedByRobots;

  const textOf = (it) => `${it.title} ${it.desc} ${it.body || ""}`;
  const stopWords = () => new Set([...cfg.trend.stopwords, SEED, CITY, ...AREAS, ...Object.keys(regionIndex),
                                   ...Object.values(regionIndex), ...Object.values(regionIndex).map((g) => g.replace(/구$/, ""))]);

  // 단어 검증: 그 단어로 장소 검색했을 때 디저트 가게(카페·간식) 비율
  const placeCheck = { ...(prev.placeCheck || {}) };
  async function dessertRatio(word) {
    const c = placeCheck[word];
    if (c && Date.now() - new Date(c.at).getTime() < cfg.vocab.recheckDays * 86400e3) return c.ratio;
    const ps = (await tryDo(() => places(word))) || [];
    const ratio = ps.length ? ps.filter(isDessertPlace).length / ps.length : 0;
    placeCheck[word] = { ratio: +ratio.toFixed(2), at: now() };
    return ratio;
  }

  // 1차 판별: 디저트 단어장 학습 → 디저트 글 → 뜨는 키워드
  async function analyze() {
    const tokenize = makeTokenizer(stopWords());
    const pool = [...byLink.values()].filter((it) => isRecent(it) && !it.rejected);
    for (const it of pool) it._tokens = tokenize(it.title);
    const core = new Set(pool.filter((it) => textOf(it).includes(SEED)));   // 본문까지 "디저트"가 들어간 글

    const freq = new Map();
    for (const it of core) for (const t of it._tokens) freq.set(t, (freq.get(t) || 0) + 1);
    const candidates = [...new Set([
      ...[...freq].filter(([, n]) => n >= cfg.vocab.minPosts).sort((x, y) => y[1] - x[1]).slice(0, cfg.vocab.checkTop).map(([t]) => t),
      ...(prev.vocab || []),
    ])];
    const vocab = new Set();
    for (const t of candidates) if (await dessertRatio(t) >= cfg.vocab.minDessertPlaces) vocab.add(t);

    const items = pool.filter((it) => core.has(it) || it._tokens.some((t) => vocab.has(t)));
    return { pool, core, vocab, items };
  }

  // ===== 1차 검색 =====
  await collect(`${CITY} ${SEED}`, cfg.seedPages);
  for (const area of AREAS) {
    await collect(`${area} ${SEED}`, cfg.areaPages);
    await collect(`${area} ${SEED} 팝업`, 1);
  }
  for (const t of (prev.trends || []).slice(0, cfg.expandQueries)) await collect(`${CITY} ${t.keyword}`, 1);
  await crawlNew(Math.floor(cfg.crawl.maxPagesPerRun / 2));
  let result = await analyze();

  // ===== 2차 검색: 발견한 디저트 이름(예: 찹쌀모찌)으로 다시 검색 =====
  const prevVocab = new Set(prev.vocab || []);
  const mentions = (w) => result.pool.filter((it) => it._tokens.includes(w)).length;
  const round2 = [...result.vocab]
    .filter((w) => !searched.has(`${CITY} ${w}`))
    .sort((a, b) => (prevVocab.has(a) - prevVocab.has(b)) || mentions(b) - mentions(a))
    .slice(0, cfg.discoverQueries);
  console.log(`🍡 발견한 디저트로 추가 검색: ${round2.join(", ") || "없음"}`);
  for (const w of round2) await collect(`${CITY} ${w}`, 1);
  await crawlNew(crawlLeft());
  result = await analyze();

  // ===== 서울 판별 (규칙): "서울" 또는 서울 동네 이름·내가 정한 동네가 글에 나오는지 =====
  const placeNames = [...new Set([...AREAS, ...Object.keys(regionIndex)])].sort((a, b) => b.length - a.length);
  const locate = (it) => {
    const text = textOf(it);
    const area = AREAS.find((a) => text.includes(a)) || "";
    const hit = placeNames.find((n) => text.includes(n));
    const gu = area ? areaGu[area] || "" : hit ? regionIndex[hit] || "" : "";
    return { area, gu, seoul: !!(area || hit || text.includes(CITY)) };
  };
  for (const it of result.items) Object.assign(it, locate(it));

  // ===== AI 2차 확인 =====
  // 서울로 보이는 글 → 최신 글 순으로 먼저 확인
  const aiQueue = [...result.items].sort((x, y) => (y.seoul - x.seoul) || y.date.localeCompare(x.date));
  const ai = await aiReview(aiQueue, { apiKey: process.env.ANTHROPIC_API_KEY, ...cfg.ai });
  const rejected = [];
  const kept = result.items.filter((it) => {
    let ok;
    if (it.ai) ok = it.ai.dessert && it.ai.seoul !== "no" && (it.ai.seoul === "yes" || it.seoul);
    else ok = !ai.enabled && it.seoul; // AI를 쓰는데 아직 확인 못 한 글은 다음 업데이트에서 확인 후 표시
    if (!ok && it.ai) { it.rejected = true; rejected.push(it); }
    return ok;
  });

  // ===== 뜨는 키워드 (최종 남은 글 기준) =====
  const cnt = new Map();
  for (const it of kept) for (const t of it._tokens) if (result.vocab.has(t)) {
    const c = cnt.get(t) || { posts: 0, sources: new Set() };
    c.posts++; c.sources.add(it.source); cnt.set(t, c);
  }
  const prevCount = Object.fromEntries((prev.trends || []).map((t) => [t.keyword, t.count]));
  const trends = [...cnt]
    .filter(([, c]) => c.posts >= cfg.trend.minPosts && c.sources.size >= cfg.trend.minSources)
    .sort((x, y) => y[1].posts - x[1].posts).slice(0, cfg.trend.top)
    .map(([keyword, c]) => ({ keyword, count: c.posts, diff: prev.trends?.length ? c.posts - (prevCount[keyword] ?? 0) : 0 }));
  const trendWords = trends.map((t) => t.keyword);

  const items = kept
    .map(({ _tokens, ...it }) => ({ ...it, keywords: trendWords.filter((k) => _tokens.includes(k)), popup: /팝업/.test(`${it.title} ${it.desc}`) }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.maxItems);
  for (const it of byLink.values()) delete it._tokens;

  // ===== 가게: 뜨는 키워드 + 서울 → 카카오 분류상 카페·간식, 서울 주소만 =====
  const stores = [];
  for (const keyword of trendWords.slice(0, cfg.stores.topKeywords)) {
    await tryDo(async () => {
      const found = (await places(`${CITY} ${keyword}`)).filter((p) => isDessertPlace(p) && inCity(p));
      for (const p of found.slice(0, cfg.stores.perKeyword)) {
        if (stores.some((s) => s.name === p.name)) continue;
        const r = learnAddress(p.jibun || p.address);
        const reviews = await search("blog", p.name, { sort: "accuracy", size: 5 });
        stores.push({
          name: p.name, address: p.address, category: p.category, keyword,
          gu: r?.gu || "", area: AREAS.find((a) => `${p.name} ${p.address}`.includes(a) || areaGu[a] === r?.gu) || "",
          image: reviews.find((x) => x.thumb)?.thumb || "", reviewUrl: reviews[0]?.link || "", mapUrl: p.link,
        });
      }
    });
  }

  // ===== 지역 칩: 내가 정한 동네 먼저, 그다음 구(많은 순) =====
  const guCount = {};
  for (const x of [...items, ...stores]) if (x.gu) guCount[x.gu] = (guCount[x.gu] || 0) + 1;
  const regions = [
    ...AREAS.filter((a) => [...items, ...stores].some((x) => x.area === a)).map((a) => ({ label: a, type: "area", gu: areaGu[a] || "" })),
    ...Object.entries(guCount).sort((a, b) => b[1] - a[1]).map(([g]) => ({ label: g, type: "gu" })),
  ];

  const bySource = {};
  for (const it of items) bySource[it.source] = (bySource[it.source] || 0) + 1;
  const sources = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));

  const discovered = [...result.vocab].filter((w) => !prevVocab.has(w))
    .map((word) => ({ word, posts: items.filter((it) => it.title.includes(word)).length }))
    .filter((d) => d.posts > 0).sort((a, b) => b.posts - a.posts);

  // 탈락한 글은 링크·판정만 기억 (다음번에 다시 AI에 묻지 않도록)
  const rejectedSlim = [...new Map([...(prev.rejected || []), ...rejected].map((it) => [it.link, it])).values()]
    .filter(isRecent).map(({ link, title, date, ai: a }) => ({ link, title, date, ai: a, rejected: true, crawled: true }));

  await mkdir(new URL("public/data/", ROOT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    updatedAt: now(), city: CITY, areas: AREAS, queries: [...searched],
    stats: { ...crawler.stats, candidates: result.pool.length, ruleKept: result.items.length, kept: items.length, ai: ai.enabled ? ai.stats : null },
    crawlReport: crawler.report(), errors,
    regions, regionIndex, areaGu, trends, discovered, stores, sources,
    vocab: [...result.vocab].slice(0, 500), placeCheck, items, rejected: rejectedSlim,
  }, null, 2));

  console.log(`🔎 이번 검색어: ${[...searched].join(", ")}`);
  console.log(`✅ 후보 ${result.pool.length}건 → 규칙 판별 ${result.items.length}건 → 최종(서울·디저트) ${items.length}건 · 키워드 ${trends.length}개 · 가게 ${stores.length}곳`);
  console.log(`🕷️ 크롤링: 성공 ${crawler.stats.fetched} · robots.txt로 건너뜀 ${crawler.stats.blockedByRobots} · 실패 ${crawler.stats.failed}`);
  console.log("🕷️ 사이트별 크롤링 결과 (시도 / 성공 / 본문 비어있음 / 사진 / robots 차단 / 기타 실패)");
  for (const d of crawler.report().slice(0, 15)) {
    const other = [...Object.entries(d.http).map(([c, n]) => `HTTP${c}×${n}`), ...Object.entries(d.error).map(([c, n]) => `${c}×${n}`), d.notHtml ? `HTML아님×${d.notHtml}` : ""].filter(Boolean).join(" ");
    console.log(`   ${d.host.padEnd(24)} ${d.tried} / ${d.ok} / ${d.emptyText} / ${d.withImage} / ${d.robots} / ${other || "-"}  (평균 본문 ${d.avgText}자)`);
    if (d.example) console.log(`      예) ${d.example}`);
  }
  if (errors.length) console.log(`⚠ 오류 ${errors.length}건`);
}

main();
