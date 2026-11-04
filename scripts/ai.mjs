// AI 2차 확인 — Claude API로 각 글이 정말 "서울의 디저트 정보"인지 판별해요.
// 결과는 글마다 저장해 두고, 이미 확인한 글은 다시 묻지 않아요(비용 절약).

const PROMPT = `너는 "서울 디저트 레이더" 사이트의 편집자야. 아래 블로그·카페 글 목록을 보고 각 글을 판별해.

[dessert] 이 글이 주로 다음 중 하나에 관한 것이면 true:
- 디저트·빵·떡·과자·아이스크림·음료 디저트를 파는 가게, 카페, 베이커리의 방문 후기나 소개
- 디저트 팝업스토어, 디저트 신메뉴·한정판 출시, 유행하는 디저트 소식
다음은 false:
- 패션·뷰티·캐릭터·굿즈 팝업 (간식이 조금 나와도 주제가 디저트가 아니면 false)
- 일반 식당·술집 위주의 글, 디저트 단어가 다른 뜻으로 쓰인 글(예: 말차색 염색, 쿠키 정책)
- 집에서 만드는 레시피·홈베이킹, 광고만 있는 글, 내용이 거의 없는 글

[seoul] 글에 나오는 가게·팝업의 위치가
- 서울이면 "yes", 서울이 아닌 곳(경기·부산·제주 등)이면 "no", 알 수 없으면 "unknown"

반드시 JSON 배열만 출력해. 다른 말은 쓰지 마.
형식: [{"id": 번호, "dessert": true/false, "seoul": "yes"|"no"|"unknown", "reason": "15자 이내 이유"}]

글 목록:
`;

function parseArray(text) {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error("AI 응답에서 JSON을 찾지 못함");
  return JSON.parse(text.slice(a, b + 1));
}

async function askClaude(apiKey, model, content) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`Claude API → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content?.map((c) => c.text || "").join("") || "";
}

// items: [{ link, title, desc, body }]  →  각 item에 item.ai = { dessert, seoul, reason } 를 채움
export async function aiReview(items, { apiKey, model, batchSize = 20, maxPerRun = 300 }, log = console.log) {
  const stats = { checked: 0, dessert: 0, notDessert: 0, notSeoul: 0, failedBatches: 0 };
  if (!apiKey) { log("🤖 AI 확인: ANTHROPIC_API_KEY 가 없어서 건너뜀 (규칙 기반 판별만 사용)"); return { enabled: false, stats }; }
  const todo = items.filter((it) => !it.ai).slice(0, maxPerRun);
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const list = batch.map((it, k) =>
      `#${k}\n제목: ${it.title}\n요약: ${(it.desc || "").slice(0, 200)}\n본문 일부: ${(it.body || "").slice(0, 500).replace(/\s+/g, " ")}`).join("\n\n");
    try {
      const results = parseArray(await askClaude(apiKey, model, PROMPT + list));
      for (const r of results) {
        const it = batch[r.id];
        if (!it) continue;
        it.ai = { dessert: !!r.dessert, seoul: ["yes", "no", "unknown"].includes(r.seoul) ? r.seoul : "unknown", reason: String(r.reason || "").slice(0, 40), model };
        stats.checked++;
        if (it.ai.dessert) stats.dessert++; else stats.notDessert++;
        if (it.ai.seoul === "no") stats.notSeoul++;
      }
    } catch (e) {
      stats.failedBatches++;
      log(`⚠ AI 확인 실패(${batch.length}건은 규칙 기반으로 판별): ${e.message}`);
    }
  }
  log(`🤖 AI 확인: 새로 ${stats.checked}건 확인 → 디저트 ${stats.dessert} · 디저트 아님 ${stats.notDessert} · 서울 아님 ${stats.notSeoul}`);
  return { enabled: true, stats };
}
