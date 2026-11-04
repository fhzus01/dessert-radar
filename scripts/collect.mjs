// 디저트 소식 + 핫한 디저트 가게 정보를 모아 public/data/feed.json 생성
//  1) 검색 API(카카오 또는 네이버)로 후보 글 수집
//  2) 원문 페이지를 크롤링(robots.txt 준수)해 본문·대표이미지 보강
//  3) 디저트와 관련 없는 글은 점수로 제외
// 실행: KAKAO_REST_API_KEY=... node scripts/collect.mjs
//   또는 NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=... node scripts/collect.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCrawler } from "./crawl.mjs";

const ROOT = new URL("..", import.meta.url);
const cfg = JSON.parse(await readFile(new URL("config/sources.json", ROOT), "utf8"));
const OUT = new URL("public/data/feed.json", ROOT);
const { KAKAO_REST_API_KEY: KAKAO, NAVER_CLIENT_ID: NID, NAVER_CLIENT_SECRET: NSECRET } = process.env;
const PROVIDER = KAKAO ? "kakao" : NID && NSECRET ? "naver" : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripTags = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();

// ---------- 디저트 관련도 ----------
const count = (text, terms) => terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
const DESSERT = [...new Set([...cfg.dessertTerms, ...cfg.trendKeywords])];
// 제목에 나오면 2점, 본문에 나오면 1점, 제외어는 -3점
export function dessertScore(title = "", body = "") {
  return count(title, DESSERT) * 2 + count(body, DESSERT) - (count(title, cfg.excludeTerms) + count(body, cfg.excludeTerms)) * 3;
}

// ---------- 텍스트에서 정보 추출 (후기 기반 대략값) ----------
export function findRegion(text = "") {
  for (const [region, words] of Object.entries(cfg.regions)) {
    if (words.some((w) => text.includes(w))) return region;
  }
  return "";
}

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url.split("?")[0]} → HTTP ${res.status}: ${await res.text()}`);
  await sleep(120);
  return res.json();
}

// ---------- 검색 API 어댑터 ----------
const providers = {
  kakao: {
    types: ["blog", "cafe"],
    async search(type, query, { sort = "recency", size = 30 } = {}) {
      const url = `https://dapi.kakao.com/v2/search/${type}?query=${encodeURIComponent(query)}&sort=${sort === "recency" ? "recency" : "accuracy"}&size=${size}`;
      const { documents = [] } = await getJSON(url, { Authorization: `KakaoAK ${KAKAO}` });
      return documents.map((d) => ({
        title: stripTags(d.title), desc: stripTags(d.contents), link: d.url,
        source: d.blogname || d.cafename || "웹", date: new Date(d.datetime).toISOString(), thumb: d.thumbnail || "",
      }));
    },
    async places(query, n) {
      const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=${Math.min(n, 15)}`;
      const { documents = [] } = await getJSON(url, { Authorization: `KakaoAK ${KAKAO}` });
      return documents.map((d) => ({
        name: d.place_name, address: d.road_address_name || d.address_name,
        category: d.category_name, link: d.place_url,
      }));
    },
  },
  naver: {
    types: ["blog", "news"],
    async search(type, query, { sort = "recency", size = 30 } = {}) {
      const url = `https://openapi.naver.com/v1/search/${type}.json?query=${encodeURIComponent(query)}&display=${size}&sort=${sort === "recency" ? "date" : "sim"}`;
      const { items = [] } = await getJSON(url, { "X-Naver-Client-Id": NID, "X-Naver-Client-Secret": NSECRET });
      return items.map((r) => {
        const d = r.postdate;
        const date = d ? new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00+09:00`) : new Date(r.pubDate);
        return { title: stripTags(r.title), desc: stripTags(r.description), link: r.originallink || r.link,
                 source: r.bloggername || "뉴스", date: date.toISOString(), thumb: "" };
      });
    },
    async places(query, n) {
      const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=${Math.min(n, 5)}&sort=comment`;
      const { items = [] } = await getJSON(url, { "X-Naver-Client-Id": NID, "X-Naver-Client-Secret": NSECRET });
      return items.map((p) => ({ name: stripTags(p.title), address: p.roadAddress || p.address, category: p.category, link: p.link || "" }));
    },
  },
};

// 글 하나의 파생 정보(지역·키워드·팝업 여부·디저트 점수)를 텍스트로부터 계산
function enrich(it, fallbackRegion = "") {
  const text = `${it.title} ${it.desc} ${it.body || ""}`;
  return {
    ...it,
    region: findRegion(text) || fallbackRegion,
    keywords: cfg.trendKeywords.filter((k) => text.includes(k)),
    popup: /팝업/.test(`${it.title} ${it.desc}`),
    score: dessertScore(it.title, `${it.desc} ${(it.body || "").slice(0, 3000)}`),
  };
}

// ---------- 메인 ----------
async function main() {
  if (!PROVIDER) {
    console.error("API 키가 없어요. KAKAO_REST_API_KEY 또는 NAVER_CLIENT_ID/NAVER_CLIENT_SECRET 을 설정하세요.");
    process.exit(1);
  }
  const api = providers[PROVIDER];
  const crawler = createCrawler(cfg.crawl);
  console.log(`🔎 검색 API: ${PROVIDER} · 크롤링: ${cfg.crawl.enabled ? "ON" : "OFF"}`);

  const prev = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : {};
  const byLink = new Map((prev.items || []).map((it) => [it.link, it]));
  const errors = [];

  // 1) 검색 API로 후보 수집
  for (const acc of cfg.accounts) {
    for (const type of api.types) {
      try {
        for (const r of await api.search(type, acc.query)) {
          if (byLink.has(r.link)) continue;
          byLink.set(r.link, { ...r, type, accountId: acc.id, accRegion: acc.region || "", collectedAt: new Date().toISOString() });
        }
      } catch (e) { errors.push(e.message); console.warn("⚠", e.message); }
    }
  }

  // 2) 최근 글 중 아직 크롤링 안 한 것부터 원문 보강
  const cutoff = Date.now() - cfg.keepDays * 86400e3;
  let candidates = [...byLink.values()].filter((it) => new Date(it.date).getTime() >= cutoff);
  const toCrawl = candidates
    .filter((it) => !it.crawled && dessertScore(it.title, it.desc) > 0) // 제목·요약부터 디저트와 무관하면 굳이 크롤링 안 함
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.crawl.maxPagesPerRun)
    .map((it) => it.link);
  const pages = await crawler.crawlMany(toCrawl);
  for (const [link, page] of pages) {
    const it = byLink.get(link);
    it.crawled = true;
    if (!page) continue;
    it.body = page.text;
    if (!it.thumb && page.image) it.thumb = page.image;
    if ((!it.desc || it.desc.length < 40) && page.description) it.desc = page.description;
  }

  // 3) 디저트 관련 글만 남기기
  const items = candidates
    .map((it) => enrich(it, it.accRegion || cfg.accounts.find((a) => a.id === it.accountId)?.region || ""))
    .filter((it) => it.score >= cfg.minScore)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.maxItems);
  const dropped = candidates.length - items.length;

  // 4) 키워드 순위 (지난 업데이트 대비 변화)
  const prevCount = Object.fromEntries((prev.trends || []).map((t) => [t.keyword, t.count]));
  const counts = {};
  for (const it of items) for (const k of it.keywords) counts[k] = (counts[k] || 0) + 1;
  const trends = Object.entries(counts)
    .map(([keyword, c]) => ({ keyword, count: c, diff: prev.trends?.length ? c - (prevCount[keyword] ?? 0) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // 5) 핫한 디저트 가게: 상위 키워드 → 장소 검색(디저트 업종만) → 대표 후기 글 1개 연결
  const storeCat = new RegExp(cfg.storeCategoryPattern);
  const topKw = (trends.length ? trends.map((t) => t.keyword) : cfg.trendKeywords).slice(0, cfg.stores.topKeywords);
  const stores = [];
  for (const keyword of topKw) {
    try {
      for (const p of await api.places(keyword, cfg.stores.perKeyword)) {
        if (!storeCat.test(p.category || "") || stores.some((s) => s.name === p.name)) continue;
        const reviews = await api.search("blog", p.name, { sort: "accuracy", size: 5 });
        const review = reviews.find((r) => r.title.includes(p.name.split(" ")[0])) || reviews[0];
        stores.push({
          ...p, keyword,
          region: findRegion(`${p.address} ${p.name}`),
          image: reviews.find((r) => r.thumb)?.thumb || "",
          reviewUrl: review?.link || "",
          mapUrl: PROVIDER === "kakao" && p.link ? p.link
            : `https://map.naver.com/p/search/${encodeURIComponent(`${p.name} ${p.address}`)}`,
          mapName: PROVIDER === "kakao" ? "카카오맵" : "네이버 지도",
        });
      }
    } catch (e) { errors.push(e.message); console.warn("⚠", e.message); }
  }

  const accounts = cfg.accounts.map(({ id, name, instagram, verified, region }) => ({
    id, name, instagram, verified, region,
    count: items.filter((it) => it.accountId === id).length,
  }));

  // body는 용량이 커서 다음 실행용 캐시에만 일부 남기고, 화면용 데이터엔 빼요
  const slim = items.map(({ body, accRegion, ...rest }) => ({ ...rest, body: body ? body.slice(0, 1500) : undefined }));

  await mkdir(new URL("public/data/", ROOT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    updatedAt: new Date().toISOString(), provider: PROVIDER,
    stats: { ...crawler.stats, dropped }, errors,
    regions: Object.keys(cfg.regions), trends, stores, accounts, items: slim,
  }, null, 2));
  console.log(`✅ 디저트 소식 ${items.length}건(무관한 글 ${dropped}건 제외) · 가게 ${stores.length}곳`);
  console.log(`🕷️ 크롤링: 성공 ${crawler.stats.fetched} · robots.txt로 건너뜀 ${crawler.stats.blockedByRobots} · 실패 ${crawler.stats.failed}`);
  if (errors.length) console.log(`⚠ 오류 ${errors.length}건`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
