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

async function search(type, query, { sort = "recency", size = 30 } = {}) {
  const docs = await kakao(`/v2/search/${type}?query=${encodeURIComponent(query)}&sort=${sort}&size=${size}`);
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

  // 1) 검색어: 시작 단어 + 지난번 뜬 키워드 (데이터가 쌓일수록 자동으로 바뀜)
  const queries = [SEED, ...(prev.trends || []).map((t) => t.keyword).slice(0, cfg.expandQueries)];
  console.log(`🔎 이번 검색어: ${queries.join(", ")}`);
  for (const q of queries) {
    for (const type of ["blog", "cafe"]) {
      await tryDo(async () => {
        for (const r of await search(type, q)) {
          if (!byLink.has(r.link)) byLink.set(r.link, { ...r, type, query: q, collectedAt: now() });
        }
      });
    }
  }

  // 2) 최근 글 중 아직 크롤링 안 한 것부터 원문 보강
  const cutoff = Date.now() - cfg.keepDays * 86400e3;
  const recent = [...byLink.values()].filter((it) => new Date(it.date).getTime() >= cutoff);
  const toCrawl = recent.filter((it) => !it.crawled)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.crawl.maxPagesPerRun).map((it) => it.link);
  for (const [link, page] of await crawler.crawlMany(toCrawl)) {
    const it = byLink.get(link);
    it.crawled = true;
    if (!page) continue;
    it.body = page.text.slice(0, 3000);
    if (!it.thumb && page.image) it.thumb = page.image;
    if ((!it.desc || it.desc.length < 40) && page.description) it.desc = page.description;
  }
  const textOf = (it) => `${it.title} ${it.desc} ${it.body || ""}`;

  // 3-1) 핵심 디저트 글: 본문까지 봐서 "디저트"라는 말이 실제로 들어간 글
  const core = recent.filter((it) => textOf(it).includes(SEED));

  // 4) 뜨는 키워드: 핵심 글 제목에서 자동 추출
  // 제외: 흔한 단어 + 지금까지 가게 주소에서 알게 된 지역 이름(성수, 연남 등)
  const stop = new Set([...cfg.trend.stopwords, SEED, ...Object.keys(prev.regionIndex || {}),
                        ...Object.values(prev.regionIndex || {}).flatMap((l) => l.split(" "))]);
  const tokenize = makeTokenizer(stop);
  const stat = new Map(); // 단어 → { posts, sources }
  for (const it of core) {
    for (const tok of tokenize(it.title)) {
      const s = stat.get(tok) || { posts: 0, sources: new Set() };
      s.posts++; s.sources.add(it.source);
      stat.set(tok, s);
    }
  }
  const prevCount = Object.fromEntries((prev.trends || []).map((t) => [t.keyword, t.count]));
  const trends = [...stat]
    .filter(([, s]) => s.posts >= cfg.trend.minPosts && s.sources.size >= cfg.trend.minSources &&
                       s.posts <= Math.max(cfg.trend.minPosts, core.length * cfg.trend.maxShare))
    // 디저트 순도: 이 단어가 제목에 들어간 전체 글 중 "디저트 글"의 비율.
    // 장소·브랜드 이름(예: 백화점 이름)은 디저트와 무관한 글에도 많이 나와서 순도가 낮아져 자동으로 빠져요.
    .filter(([keyword]) => {
      const all = recent.filter((it) => it.title.includes(keyword)).length;
      const dessert = core.filter((it) => it.title.includes(keyword)).length;
      return all > 0 && dessert / all >= cfg.trend.minPurity;
    })
    .map(([keyword, s]) => ({ keyword, count: s.posts, diff: prev.trends?.length ? s.posts - (prevCount[keyword] ?? 0) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, cfg.trend.top);
  const trendWords = trends.map((t) => t.keyword);

  // 3-2) 디저트 글 = 핵심 글 + 뜬 키워드로 검색해서 그 키워드가 제목에 들어간 글
  const items = recent
    .filter((it) => core.includes(it) || trendWords.some((k) => it.title.includes(k)))
    .map((it) => ({
      ...it,
      keywords: trendWords.filter((k) => it.title.includes(k) || it.desc.includes(k)),
      popup: /팝업/.test(`${it.title} ${it.desc}`),
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.maxItems);

  // 5) 가게: 뜨는 키워드로 장소 검색 → 카카오 분류상 카페·간식만 → 대표 후기 1개
  const stores = [];
  for (const keyword of trendWords.slice(0, cfg.stores.topKeywords)) {
    await tryDo(async () => {
      for (const p of await places(keyword, cfg.stores.perKeyword)) {
        if (!isDessertPlace(p) || stores.some((s) => s.name === p.name)) continue;
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
    regions, regionIndex, trends, stores, sources, items,
  }, null, 2));
  console.log(`✅ 디저트 글 ${items.length}건 (후보 ${recent.length}건) · 키워드 ${trends.length}개 · 가게 ${stores.length}곳 · 지역 ${regions.length}곳`);
  console.log(`🕷️ 크롤링: 성공 ${crawler.stats.fetched} · robots.txt로 건너뜀 ${crawler.stats.blockedByRobots} · 실패 ${crawler.stats.failed}`);
  if (errors.length) console.log(`⚠ 오류 ${errors.length}건`);
}

main();
