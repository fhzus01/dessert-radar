// 디저트/팝업 소식 + 핫한 가게 정보를 모아 public/data/feed.json 생성
// 검색 API는 카카오(추천) 또는 네이버 중 키가 있는 쪽을 자동으로 사용해요.
//   카카오: KAKAO_REST_API_KEY=... node scripts/collect.mjs
//   네이버: NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=... node scripts/collect.mjs
//   샘플:   node scripts/collect.mjs --mock   (API 키 없이 화면 확인용)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const cfg = JSON.parse(await readFile(new URL("config/sources.json", ROOT), "utf8"));
const OUT = new URL("public/data/feed.json", ROOT);
const MOCK = process.argv.includes("--mock");
const { KAKAO_REST_API_KEY: KAKAO, NAVER_CLIENT_ID: NID, NAVER_CLIENT_SECRET: NSECRET } = process.env;
const PROVIDER = MOCK ? "mock" : KAKAO ? "kakao" : NID && NSECRET ? "naver" : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripTags = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();

// ---------- 텍스트에서 정보 추출 (후기 기반 대략값) ----------
export function findRegion(text = "") {
  for (const [region, words] of Object.entries(cfg.regions)) {
    if (words.some((w) => text.includes(w))) return region;
  }
  return "";
}

// "6,500원", "4500원", "5천원", "1.2만원" → 숫자(원). 디저트 가격대(1천~10만원)만 인정
export function findPrices(text = "") {
  const out = [];
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,6})\s?원/g)) out.push(+m[1].replace(/,/g, ""));
  for (const m of text.matchAll(/(\d+(?:\.\d)?)\s?천\s?원/g)) out.push(Math.round(+m[1] * 1000));
  for (const m of text.matchAll(/(\d+(?:\.\d)?)\s?만\s?원/g)) out.push(Math.round(+m[1] * 10000));
  return out.filter((n) => n >= 1000 && n <= 100000);
}

// "웨이팅 40분", "1시간 대기", "2시간 줄 서서" → 분. "웨이팅 없" → 0
export function findWaits(text = "") {
  const out = [];
  const toMin = (n, unit) => (unit === "시간" ? Math.round(+n * 60) : +n);
  for (const m of text.matchAll(/(?:웨이팅|대기|줄)[^\d.]{0,8}(\d+(?:\.\d)?)\s?(분|시간)/g)) out.push(toMin(m[1], m[2]));
  for (const m of text.matchAll(/(\d+(?:\.\d)?)\s?(분|시간)\s?(?:정도\s?)?(?:웨이팅|대기|기다|줄)/g)) out.push(toMin(m[1], m[2]));
  if (/웨이팅\s?(?:없|0)|바로\s?입장/.test(text)) out.push(0);
  return out.filter((n) => n >= 0 && n <= 600);
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url.split("?")[0]} → HTTP ${res.status}: ${await res.text()}`);
  await sleep(120);
  return res.json();
}

// ---------- 검색 API 어댑터 ----------
// search(type, query, opts) → [{ title, desc, link, source, date, thumb }]
// places(query, n)          → [{ name, address, category, link }]
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
      const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=${n}`;
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
      const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=${n}&sort=comment`;
      const { items = [] } = await getJSON(url, { "X-Naver-Client-Id": NID, "X-Naver-Client-Secret": NSECRET });
      return items.map((p) => ({ name: stripTags(p.title), address: p.roadAddress || p.address, category: p.category, link: p.link || "" }));
    },
  },

  mock: {
    types: ["blog", "cafe"],
    async search(type, query) {
      const spots = ["성수동", "연남동 골목", "신사 가로수길", "잠실 석촌호수", "여의도", "부산 해운대", "한남동"];
      return Array.from({ length: 4 }, (_, i) => {
        const kw = cfg.trendKeywords[(query.length * 3 + i * 5) % cfg.trendKeywords.length];
        const spot = spots[(query.length + i) % spots.length];
        return {
          title: `[샘플] ${spot} ${kw} 후기 ${i + 1}`,
          desc: `샘플 데이터예요. ${spot}에서 ${kw} 먹으려고 웨이팅 ${20 + i * 15}분, 가격은 ${4 + i},500원이었어요.`,
          link: `https://example.com/${type}/${encodeURIComponent(query)}/${i}`,
          source: type === "blog" ? "샘플블로거" : "샘플카페", date: new Date(Date.now() - i * 7 * 3600e3).toISOString(), thumb: "",
        };
      });
    },
    async places(keyword) {
      const addrs = ["서울특별시 성동구 성수동2가 1-1", "서울특별시 마포구 연남동 2-2", "부산광역시 해운대구 우동 3-3"];
      return Array.from({ length: 3 }, (_, i) => ({
        name: `[샘플] ${keyword} 하우스 ${i + 1}호점`, address: addrs[(keyword.length + i) % 3], category: "카페,디저트", link: "",
      }));
    },
  },
};

// ---------- 메인 ----------
async function main() {
  if (!PROVIDER) {
    console.error("API 키가 없어요. KAKAO_REST_API_KEY 또는 NAVER_CLIENT_ID/NAVER_CLIENT_SECRET 을 설정하세요. (화면만 보려면 --mock)");
    process.exit(1);
  }
  const api = providers[PROVIDER];
  console.log(`🔎 검색 API: ${PROVIDER}`);

  const prev = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : { items: [], trends: [], stores: [] };
  const byLink = new Map(prev.items.map((it) => [it.link, it]));
  const errors = [];

  // 1) 소스별 소식 수집
  for (const acc of cfg.accounts) {
    for (const type of api.types) {
      try {
        for (const r of await api.search(type, acc.query)) {
          if (byLink.has(r.link)) continue;
          const text = `${r.title} ${r.desc}`;
          byLink.set(r.link, {
            ...r, type,
            accountId: acc.id,
            category: acc.category,
            region: findRegion(text) || acc.region || "",
            price: median(findPrices(text)),
            wait: median(findWaits(text)),
            keywords: cfg.trendKeywords.filter((k) => text.includes(k)),
            collectedAt: new Date().toISOString(),
          });
        }
      } catch (e) { errors.push(e.message); console.warn("⚠", e.message); }
    }
  }

  const cutoff = Date.now() - cfg.keepDays * 86400e3;
  const items = [...byLink.values()]
    .filter((it) => new Date(it.date).getTime() >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, cfg.maxItems);

  // 2) 키워드 순위 (지난 업데이트 대비 변화 포함)
  const prevCount = Object.fromEntries(prev.trends.map((t) => [t.keyword, t.count]));
  const counts = {};
  for (const it of items) for (const k of it.keywords) counts[k] = (counts[k] || 0) + 1;
  const trends = Object.entries(counts)
    .map(([keyword, count]) => ({ keyword, count, diff: count - (prevCount[keyword] ?? 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // 3) 핫한 가게: 상위 키워드 → 장소 검색 → 그 가게 후기에서 가격·웨이팅 추정
  const topKw = (trends.length ? trends.map((t) => t.keyword) : cfg.trendKeywords).slice(0, cfg.stores.topKeywords);
  const stores = [];
  for (const keyword of topKw) {
    try {
      for (const p of await api.places(keyword, cfg.stores.perKeyword)) {
        if (stores.some((s) => s.name === p.name)) continue;
        const reviews = await api.search("blog", `${p.name} 웨이팅`, { sort: "accuracy", size: 20 });
        const texts = reviews.map((r) => `${r.title} ${r.desc}`);
        const prices = texts.flatMap(findPrices);
        const waits = texts.flatMap(findWaits);
        stores.push({
          ...p, keyword,
          region: findRegion(`${p.address} ${p.name}`),
          mapUrl: PROVIDER === "kakao" && p.link
            ? p.link
            : `https://map.naver.com/p/search/${encodeURIComponent(`${p.name} ${p.address}`)}`,
          mapName: PROVIDER === "kakao" ? "카카오맵" : "네이버 지도",
          price: median(prices), priceSamples: prices.length,
          wait: median(waits), waitSamples: waits.length,
        });
      }
    } catch (e) { errors.push(e.message); console.warn("⚠", e.message); }
  }

  const accounts = cfg.accounts.map(({ id, name, instagram, category, verified, region }) => ({
    id, name, instagram, category, verified, region,
    count: items.filter((it) => it.accountId === id).length,
  }));

  await mkdir(new URL("public/data/", ROOT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    updatedAt: new Date().toISOString(), provider: PROVIDER,
    mock: MOCK, errors, regions: Object.keys(cfg.regions), trends, stores, accounts, items,
  }, null, 2));
  console.log(`✅ 소식 ${items.length}건 · 가게 ${stores.length}곳 저장, 오류 ${errors.length}건`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
