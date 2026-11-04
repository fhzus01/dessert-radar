# 🍪 디저트 레이더

요즘 뜨는 디저트 소식을 **매일 12시·24시(KST)** 자동으로 모아 보여주는 사이트.
시작 단어 `"디저트"` 하나에서 출발해서 **검색어·키워드·가게·지역이 모두 수집한 데이터로 자동 결정**돼요.

- 수집: 카카오(다음) 블로그·카페 검색 API + 장소 검색 API
- 크롤링: 검색 결과 원문 페이지 (robots.txt 준수)
- 자동 실행: GitHub Actions 크론 (`0 3,15 * * *` UTC = 12:00 / 24:00 KST)
- 배포: GitHub Pages (서버·DB 없이 무료)

## 구조
```
config/sources.json      시작 단어, 동작 숫자, 흔한 단어 제외 목록
scripts/collect.mjs      수집·판별·키워드 추출 → public/data/feed.json
scripts/crawl.mjs        robots.txt를 지키는 원문 크롤러
public/                  정적 사이트 (index.html, app.js, style.css)
.github/workflows/update.yml   12시·24시 자동 수집 + 배포
```

## 업데이트 한 번에 일어나는 일
1. **검색어 정하기** — `"디저트"` + 지난 업데이트에서 뜬 키워드 (예: 버터떡, 두쫀쿠). 유행이 바뀌면 검색어도 바뀜
2. **수집** — 카카오 블로그·카페 검색으로 최근 글 수집
3. **크롤링** — 원문 페이지에서 본문·대표 이미지 가져오기
   - 각 사이트 `robots.txt`를 확인해 막아둔 곳은 건너뜀
   - 같은 사이트엔 0.4초 간격, 1회 최대 80페이지
4. **디저트 글 판별**
   - 본문까지 봐서 "디저트"라는 말이 들어간 글 → 디저트 글
   - 위 글들에서 뽑힌 키워드가 제목에 있는 글 → 디저트 글
   - 그 외(패션 팝업, 일반 맛집 등)는 제외 → 팝업도 **디저트 팝업만** 남음
5. **지금 뜨는 키워드** — 디저트 글 제목에서 자동 추출
   - 3개 이상 글, 2명 이상 작성자가 쓴 단어
   - **디저트 순도**: 그 단어가 들어간 글 중 디저트 글이 60% 이상이어야 함 → 백화점·브랜드 이름 같은 단어는 자동으로 빠짐
   - 지역 이름(아래 6번에서 배운 것)과 흔한 단어(`trend.stopwords`)는 제외
6. **가게·지역** — 뜨는 키워드로 카카오 장소 검색 → 카카오 분류상 `카페`·`간식` 업종만. 가게 주소로 지역 목록(예: 서울 성동구)을 자동으로 만들고, 업데이트마다 누적
7. **많이 올린 작성자** 집계

## 시작하기
1. **카카오 REST API 키** — https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가하기 → **앱 키 > REST API 키** 복사. 가게 검색이 안 되면 앱 설정에서 **카카오맵** 사용 설정 ON
2. **GitHub 설정**
   - Settings → Secrets and variables → Actions → `KAKAO_REST_API_KEY` 등록
   - Settings → Actions → General → Workflow permissions → **Read and write**
   - Settings → Pages → Source: **GitHub Actions**
3. Actions 탭 → "디저트 소식 업데이트 & 배포" → **Run workflow**
4. 로컬 실행: `KAKAO_REST_API_KEY=xxx node scripts/collect.mjs` 후 `npx serve public`

> 첫 업데이트는 "디저트" 한 단어로만 검색해서 결과가 적을 수 있어요. 몇 번 돌수록 키워드·가게·지역이 쌓여요.

## 설정 (`config/sources.json`)
| 항목 | 뜻 |
|---|---|
| `seed` | 시작 단어 (사이트 주제) |
| `expandQueries` | 지난번 뜬 키워드 중 몇 개를 다음 검색어로 쓸지 |
| `keepDays` | 며칠 지난 글까지 보여줄지 |
| `trend.minPosts / minSources / minPurity / maxShare` | 키워드 기준 |
| `trend.stopwords` | "후기", "맛집" 같은 흔한 단어 — 엉뚱한 단어가 순위에 끼면 여기 추가 |
| `crawl.*` | 크롤링 속도·양 |

## 기능
- 🔥 지금 뜨는 키워드 (지난 업데이트 대비 ▲▼, 📷 누르면 인스타그램 해시태그 페이지)
- 🏪 지금 핫한 가게 — 주소, 대표 후기 글, 카카오맵 링크
- 📍 지역 필터 (가게 주소에서 자동 생성)
- 🎪 디저트 팝업 탭, ♥ 찜하기 (브라우저에 저장)

> 인스타그램은 이용약관상 크롤링이 금지돼 있어 수집하지 않고, 해시태그 페이지 링크만 제공해요.
