const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (iso) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

let data = { items: [], stores: [] };
const state = { filter: "all", query: "", region: "전체", storeFavOnly: false, storeLimit: 6, feedLimit: 24 };

// ---------- 찜 (이 브라우저에만 저장) ----------
const FAV_KEY = "dessert-radar:favs";
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch {}
const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch {} };
const heart = (id) => `<button class="heart ${favs.has(id) ? "on" : ""}" data-fav="${esc(id)}" aria-label="찜하기">${favs.has(id) ? "♥" : "♡"}</button>`;

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fav]");
  if (!b) return;
  e.preventDefault();
  const id = b.dataset.fav;
  favs.has(id) ? favs.delete(id) : favs.add(id);
  saveFavs();
  render();
});

// ---------- 다음 업데이트 카운트다운 ----------
function nextUpdate() {
  const kst = new Date(Date.now() + 9 * 3600e3);
  const h = kst.getUTCHours();
  const t = new Date(kst); t.setUTCMinutes(0, 0, 0); t.setUTCHours(h < 12 ? 12 : 24);
  const ms = t - kst;
  $("#next").textContent = `⏰ ${h < 12 ? "12시" : "24시"} 업데이트까지 ${Math.floor(ms / 3600e3)}시간 ${Math.floor((ms % 3600e3) / 60e3)}분`;
}

const inRegion = (r) => state.region === "전체" || r === state.region;

// ---------- 렌더 ----------
function renderRegions() {
  const used = new Set([...data.items, ...data.stores].map((x) => x.region).filter(Boolean));
  const list = ["전체", ...(data.regions || []).filter((r) => used.has(r))];
  $("#regions").innerHTML = list.map((r) =>
    `<button data-r="${esc(r)}" class="${r === state.region ? "on" : ""}">${r === "전체" ? "📍 전체" : esc(r)}</button>`).join("");
}

function renderStores() {
  const list = data.stores.filter((s) => inRegion(s.region) && (!state.storeFavOnly || favs.has("s:" + s.name)));
  $("#storesMore").hidden = list.length <= state.storeLimit;
  $("#stores").innerHTML = list.slice(0, state.storeLimit).map((s) => `
    <div class="card store">
      ${heart("s:" + s.name)}
      ${s.image ? `<img class="thumb" src="${esc(s.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
      <span class="kw">#${esc(s.keyword)}</span>
      <div class="name">${esc(s.name)}</div>
      <div class="addr">📍 ${esc(s.address || "주소 정보 없음")}</div>
      <div class="links">
        ${s.reviewUrl ? `<a class="map review" href="${esc(s.reviewUrl)}" target="_blank" rel="noopener">✏️ 후기 보기</a>` : ""}
        <a class="map" href="${esc(s.mapUrl)}" target="_blank" rel="noopener">🗺️ 카카오맵</a>
      </div>
    </div>`).join("");
  $("#storesEmpty").hidden = list.length > 0;
}

function renderFeed() {
  const fresh = (it) => data.updatedAt && Math.abs(new Date(it.collectedAt) - new Date(data.updatedAt)) < 600e3;
  const list = data.items.filter((it) =>
    (state.filter === "all" || (state.filter === "fav" ? favs.has(it.link) : it.popup)) &&
    inRegion(it.region) &&
    (!state.query || `${it.title} ${it.desc} ${it.keywords.join(" ")} ${it.region}`.includes(state.query)));

  $("#feedMore").hidden = list.length <= state.feedLimit;
  $("#feed").innerHTML = list.slice(0, state.feedLimit).map((it) => `
    <article class="card item">
      ${heart(it.link)}
      <div class="row">
        ${fresh(it) ? '<span class="new">NEW</span>' : ""}
        <span class="badge">${({ news: "📰 뉴스", cafe: "☕ 카페글", blog: "✏️ 블로그" })[it.type] || "🌐 웹"}</span>
        ${it.popup ? '<span class="badge">🎪 디저트 팝업</span>' : ""}
        ${it.region ? `<span class="badge region">📍 ${esc(it.region)}</span>` : ""}
      </div>
      <a href="${esc(it.link)}" target="_blank" rel="noopener">
        ${it.thumb ? `<img class="thumb" src="${esc(it.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
        <div class="title">${esc(it.title)}</div>
        <div class="desc">${esc(it.desc)}</div>
      </a>
      <div class="row">
        ${it.keywords.map((k) => `<span class="tag">#${esc(k)}</span>`).join("")}
      </div>
      <div class="row"><span style="margin-left:auto">${esc(it.source)} · ${fmt(it.date)}</span></div>
    </article>`).join("");
  $("#empty").hidden = list.length > 0;
}

function render() { renderRegions(); renderStores(); renderFeed(); }

async function init() {
  try {
    data = await (await fetch(`data/feed.json?t=${Date.now()}`)).json();
    data.stores ||= [];
  } catch {
    $("#updated").textContent = "데이터를 불러오지 못했어요";
    return;
  }
  data.items ||= []; data.trends ||= []; data.sources ||= []; data.queries ||= [];
  $("#updated").textContent = data.updatedAt ? `🕐 ${fmt(data.updatedAt)} 업데이트` : "🕐 첫 업데이트를 기다리는 중";
  $("#waitingNotice").hidden = !!data.updatedAt;

  $("#trends").innerHTML = data.trends.map((t, i) => `
    <li data-k="${esc(t.keyword)}"><b>${i + 1}</b>${esc(t.keyword)}<span class="cnt">${t.count}</span>
      ${t.diff > 0 ? `<span class="up">▲${t.diff}</span>` : t.diff < 0 ? `<span class="down">▼${-t.diff}</span>` : ""}
      <a class="insta" href="https://www.instagram.com/explore/tags/${encodeURIComponent(t.keyword)}/" target="_blank" rel="noopener" title="인스타그램에서 #${esc(t.keyword)} 보기">📷</a>
    </li>`).join("") || "<li>아직 데이터가 없어요</li>";
  if (data.trends[0]) $("#q").placeholder = `🔍 검색 (예: ${data.trends[0].keyword})`;

  $("#queries").innerHTML = data.queries.map((q) => `<span class="tag">${esc(q)}</span>`).join("") || '<span class="small">아직 없음</span>';
  $("#sources").innerHTML = data.sources.map((x) => `
    <div class="card acc"><div class="name">${esc(x.name)}</div><div class="small">디저트 글 ${x.count}건</div></div>`).join("");

  render();
}

// ---------- 이벤트 ----------
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  state.filter = b.dataset.f;
  renderFeed();
}));
$("#regions").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-r]");
  if (!b) return;
  state.region = b.dataset.r;
  render();
});
$("#feedMore").addEventListener("click", () => { state.feedLimit += 24; renderFeed(); });
$("#storesMore").addEventListener("click", () => { state.storeLimit += 6; renderStores(); });
$("#storeFav").addEventListener("change", (e) => { state.storeFavOnly = e.target.checked; renderStores(); });
$("#q").addEventListener("input", (e) => { state.query = e.target.value.trim(); renderFeed(); });
$("#trends").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // 인스타 링크는 그대로 열기
  const li = e.target.closest("li[data-k]");
  if (!li) return;
  $("#q").value = state.query = li.dataset.k;
  renderFeed();
  $("#q").scrollIntoView({ behavior: "smooth", block: "center" });
});

nextUpdate();
setInterval(nextUpdate, 60e3);
init();
