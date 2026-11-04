// 디저트 레이더 수집기 — 시작 단어("디저트") 하나에서 출발해 모든 내용이 데이터로 자동 결정돼요.
//  1) 검색어: "디저트" + 지난 업데이트에서 뜬 키워드들 (매번 바뀜)
//  2) 원문 크롤링(robots.txt 준수)으로 본문·대표이미지 보강
//  3) 디저트 글 판별: "디저트"가 들어간 글 + 디저트 글에서 뽑힌 키워드가 들어간 글
//  4) 뜨는 키워드: 제목에서 자동 추출
//  5) 가게: 뜨는 키워드로 카카오 장소 검색 (카카오 분류 '카페'·'간식')
//  6) 지역: 가게 주소에서 자동으로 지역 목록을 만들고 글에 붙임
// 실행: KAKAO_REST_API_KEY=... node scripts/collect.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCrawler } from "./crawl.mjs";

const ROOT = new URL("..", import.meta.url);
const cfg = JSON.parse(await readFile(new URL("config/sources.json", ROOT), "utf8"));
const OUT = new URL("public/data/feed.json", ROOT);
const KEY = process.env.KAKAO_REST_API_KEY;
const SEED = cfg.seed;
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

async function search(type, query, { sort = "recency", size = 30, page = 1 } = {}) {
  const docs = await kakao(`/v2/search/${type}?query=${encodeURIComponent(query)}&sort=${sort}&size=${size}&page=${page}`);
  return docs.map((d) => ({
    title: stripTags(d.title), desc: stripTags(d.contents), link: d.url,
    source: d.blogname || d.cafename || "웹", date: new Date(d.datetime).toISOString(), thumb: d.thumbnail || "",
  }));
}

async function places(query, n) {
  const docs = await kakao(`/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=${Math.min(n, 15)}`);
  return docs.map((d) => ({
    name: d.place_name, address: d.road_address_name || d.address_name, jibun: d.address_name,
    category: d.category_name, group: d.category_group_code, link: d.place_url,
  }));
}

// 카카오 자체 분류로 디저트 가게 판단: 카페(CE7) 또는 "음식점 > 간식 ..." 업종
const isDessertPlace = (p) => p.group === "CE7" || /(^|>)\s*간식/.test(p.category || "");

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

// ---------- 지역: 주소에서 자동 생성 ----------
// "서울 성동구 성수동2가 273" → 지역 "서울 성동구", 동네 이름 "성수"
function regionFromAddress(addr = "") {
  const parts = addr.split(/\s+/);
  if (parts.length < 2) return null;
  const label = /[구군시]$/.test(parts[1]) ? `${parts[0]} ${parts[1]}` : parts[0];
  const names = new Set([parts[1].replace(/[구군시]$/, "")]);
  const dong = parts[2] || "";
  if (/[동읍면가]$|\d가$/.test(dong)) names.add(dong.replace(/\d*가$/, "").replace(/[동읍면]$/, ""));
  return { label, names: [...names].filter((n) => n.length >= 2) };
}

// ---------- 메인 ----------
async function main() {
  if (!KEY) {
    console.error("KAKAO_REST_API_KEY 가 없어요. GitHub Secrets에 등록했는지 확인하세요.");
    process.exit(1);
  }
  const crawler = createCrawler(cfg.crawl);
  const prev = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : {};
  const byLink = new Map((prev.items || []).map((it) => [it.link, it]));
  const errors = [];
  const tryDo = async (fn) => { try { return await fn(); } catch (e) { errors.push(e.message); console.warn("⚠", e.message); } };

  const cutoff = Date.now() - cfg.keepDays * 86400e3;
  const searched = new Set();
  const collect = async (q, pages) => {
    searched.add(q);
    for (const type of ["blog", "cafe"]) {
      for (let page = 1; page <= pages; page++) {
        await tryDo(async () => {
          for (const r of await search(type, q, { size: 50, page })) {
            if (!byLink.has(r.link)) byLink.set(r.link, { ...r, type, query: q, collectedAt: now() });
          }
        });
      }
    }
  };
  const crawlNew = async (budget) => {
    const todo = [...byLink.values()]
      .filter((it) => !it.crawled && new Date(it.date).getTime() >= cutoff)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, budget).map((it) => it.link);
    for (const [link, page] of await crawler.crawlMany(todo)) {
      const it = byLink.get(link);
      it.crawled = true;
      if (!page) continue;
      it.body = page.text.slice(0, 3000);
      if (!it.thumb && page.image) it.thumb = page.image;
      if ((!it.desc || it.desc.length < 40) && page.description) it.desc = page.description;
    }
  };

  // 제외: 흔한 단어 + 지금까지 가게 주소에서 알게 된 지역 이름(성수, 연남 등)
  const stop = new Set([...cfg.trend.stopwords, SEED, ...Object.keys(prev.regionIndex || {}),
                        ...Object.values(prev.regionIndex || {}).flatMap((l) => l.split(" "))]);
  const tokenize = makeTokenizer(stop);
  const textOf = (it) => `${it.title} ${it.desc} ${it.body || ""}`;

  // 단어 검증: 그 단어로 카카오 장소 검색을 했을 때 디저트 가게(카페·간식)가 얼마나 나오는지.
  // 버터떡·말차 → 대부분 카페/제과점, 백화점·지역·패션 같은 단어 → 디저트 가게 비율이 낮음
  const placeCheck = { ...(prev.placeCheck || {}) };
  const placeCache = new Map(); // 이번 실행에서 받은 장소 결과 (가게 목록에 재사용)
  async function dessertRatio(word) {
    const c = placeCheck[word];
    if (c && Date.now() - new Date(c.at).getTime() < cfg.vocab.recheckDays * 86400e3) return c.ratio;
    const ps = (await tryDo(() => places(word, 15))) || [];
    placeCache.set(word, ps);
    const ratio = ps.length ? ps.filter(isDessertPlace).length / ps.length : 0;
    placeCheck[word] = { ratio: +ratio.toFixed(2), at: now() };
    return ratio;
  }

  // 분석: 디저트 글 판별 → 디저트 단어장 학습 → 뜨는 키워드
  async function analyze() {
    const pool = [...byLink.values()].filter((it) => new Date(it.date).getTime() >= cutoff);
    for (const it of pool) it._tokens ||= tokenize(it.title);

    // (a) 핵심 디저트 글: 본문까지 봐서 "디저트"라는 말이 들어간 글
    const core = new Set(pool.filter((it) => textOf(it).includes(SEED)));

    // (b) 디저트 단어장: 핵심 글 제목에 자주 나오고, 장소 검색으로 검증된 단어
    //     (지난 업데이트까지 배운 단어도 이어서 사용 → 업데이트할수록 단어장이 커져요)
    const freq = new Map();
    for (const it of core) for (const t of it._tokens) freq.set(t, (freq.get(t) || 0) + 1);
    const candidates = [...new Set([
      ...[...freq].filter(([, n]) => n >= cfg.vocab.minPosts).sort((x, y) => y[1] - x[1]).slice(0, cfg.vocab.checkTop).map(([t]) => t),
      ...(prev.vocab || []),
    ])];
    const vocab = new Set();
    for (const t of candidates) if (await dessertRatio(t) >= cfg.vocab.minDessertPlaces) vocab.add(t);

    // (c) 디저트 글 = 핵심 글 + 제목에 단어장 단어가 있는 글
    const items = pool.filter((it) => core.has(it) || it._tokens.some((t) => vocab.has(t)));

    // (d) 뜨는 키워드 = 디저트 글 제목에서 많이 나온 단어장 단어 (여러 작성자가 쓴 것만)
    const cnt = new Map();
    for (const it of items) for (const t of it._tokens) if (vocab.has(t)) {
      const c = cnt.get(t) || { posts: 0, sources: new Set() };
      c.posts++; c.sources.add(it.source); cnt.set(t, c);
    }
    const trends = [...cnt]
      .filter(([, c]) => c.posts >= cfg.trend.minPosts && c.sources.size >= cfg.trend.minSources)
      .sort((x, y) => y[1].posts - x[1].posts)
      .slice(0, cfg.trend.top)
      .map(([keyword, c]) => ({ keyword, count: c.posts }));
    return { pool, core, vocab, items, trends };
  }

  // 1차: 시작 단어(여러 페이지) + 지난번 뜬 키워드
  const round1 = [SEED, ...(prev.trends || []).map((t) => t.keyword).slice(0, cfg.expandQueries)];
  await collect(SEED, cfg.seedPages);
  for (const q of round1.slice(1)) await collect(q, 1);
  await crawlNew(Math.floor(cfg.crawl.maxPagesPerRun / 2));
  let result = await analyze();

  // 2차: "디저트" 검색 결과에서 발견한 디저트 이름(예: 찹쌀모찌, 모찌떡)을 하나씩 다시 검색
  //      처음 발견한 단어를 먼저, 그다음 자주 나온 단어 순으로
  const prevVocab = new Set(prev.vocab || []);
  const mentions = (w) => result.pool.filter((it) => it._tokens.includes(w)).length;
  const discoveredNow = [...result.vocab].filter((w) => !prevVocab.has(w));
  const round2 = [...result.vocab]
    .filter((w) => !searched.has(w))
    .sort((a, b) => (prevVocab.has(a) - prevVocab.has(b)) || mentions(b) - mentions(a))
    .slice(0, cfg.discoverQueries);
  console.log(`🍡 발견한 디저트로 추가 검색: ${round2.join(", ") || "없음"}`);
  for (const q of round2) await collect(q, 1);
  await crawlNew(cfg.crawl.maxPagesPerRun - crawler.stats.fetched - crawler.stats.failed - crawler.stats.blockedByRobots);
  result = await analyze();
  const queries = [...searched];
  console.log(`🔎 이번 검색어: ${queries.join(", ")}`);

  const prevCount = Object.fromEntries((prev.trends || []).map((t) => [t.keyword, t.count]));
  const trends = result.trends.map((t) => ({ ...t, diff: prev.trends?.length ? t.count - (prevCount[t.keyword] ?? 0) : 0 }));
  const trendWords = trends.map((t) => t.keyword);
  const recent = result.pool;
  const items = result.items
    .map(({ _tokens, ...it }) => ({
      ...it,
      keywords: trendWords.filter((k) => _tokens.includes(k)),
      popup: /팝업/.test(`${it.title} ${it.desc}`),
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.maxItems);
  for (const it of byLink.values()) delete it._tokens;

  // 5) 가게: 뜨는 키워드로 장소 검색 → 카카오 분류상 카페·간식만 → 대표 후기 1개
  const stores = [];
  for (const keyword of trendWords.slice(0, cfg.stores.topKeywords)) {
    await tryDo(async () => {
      const found = placeCache.get(keyword) || await places(keyword, 15);
      for (const p of found.filter(isDessertPlace).slice(0, cfg.stores.perKeyword)) {
        if (stores.some((s) => s.name === p.name)) continue;
        const reviews = await search("blog", p.name, { sort: "accuracy", size: 5 });
        stores.push({
          name: p.name, address: p.address, category: p.category, keyword,
          region: regionFromAddress(p.jibun || p.address)?.label || "",
          image: reviews.find((r) => r.thumb)?.thumb || "",
          reviewUrl: reviews[0]?.link || "",
          mapUrl: p.link,
          _jibun: p.jibun,
        });
      }
    });
  }

  // 6) 지역 목록: 지금까지 모은 가게 주소에서 자동 생성 (업데이트마다 누적)
  const regionIndex = { ...(prev.regionIndex || {}) }; // 동네 이름 → 지역 라벨
  for (const s of stores) {
    const r = regionFromAddress(s._jibun || s.address);
    if (r) for (const n of r.names) regionIndex[n] = r.label;
    delete s._jibun;
  }
  const names = Object.keys(regionIndex).sort((a, b) => b.length - a.length); // 긴 이름 먼저
  for (const it of items) {
    const text = `${it.title} ${it.desc}`;
    const hit = names.find((n) => text.includes(n));
    it.region = hit ? regionIndex[hit] : "";
  }
  const regionCount = {};
  for (const x of [...items, ...stores]) if (x.region) regionCount[x.region] = (regionCount[x.region] || 0) + 1;
  const regions = Object.entries(regionCount).sort((a, b) => b[1] - a[1]).map(([r]) => r);

  // 7) 많이 올린 작성자 (고정 소스 목록 대신)
  const bySource = {};
  for (const it of items) bySource[it.source] = (bySource[it.source] || 0) + 1;
  const sources = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));

  await mkdir(new URL("public/data/", ROOT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    updatedAt: now(), queries, stats: { ...crawler.stats, candidates: recent.length, kept: items.length }, errors,
    regions, regionIndex, trends, stores, sources, vocab: [...result.vocab].slice(0, 500), placeCheck,
    discovered: [...new Set([...discoveredNow, ...[...result.vocab].filter((w) => !prevVocab.has(w))])]
      .map((word) => ({ word, posts: items.filter((it) => it.title.includes(word)).length }))
      .filter((d) => d.posts > 0).sort((a, b) => b.posts - a.posts),
    items,
  }, null, 2));
  console.log(`✅ 디저트 글 ${items.length}건 (후보 ${recent.length}건) · 배운 디저트 단어 ${result.vocab.size}개 · 키워드 ${trends.length}개 · 가게 ${stores.length}곳 · 지역 ${regions.length}곳`);
  console.log(`🕷️ 크롤링: 성공 ${crawler.stats.fetched} · robots.txt로 건너뜀 ${crawler.stats.blockedByRobots} · 실패 ${crawler.stats.failed}`);
  if (errors.length) console.log(`⚠ 오류 ${errors.length}건`);
}

main();
