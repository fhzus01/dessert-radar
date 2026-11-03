# 🍪 디저트 레이더

유행 디저트(두쫀쿠, 버터떡, 한정판…)와 팝업스토어 소식을 **매일 12시·24시(KST)** 자동으로 모아 보여주는 사이트.

- 수집: 카카오(다음) 검색 API(블로그·카페·장소) — 인스타그램 무단 크롤링 대신 합법적인 공개 API 사용 (네이버 검색 API 키가 있으면 그것도 지원)
- 자동 실행: GitHub Actions 크론 (`0 3,15 * * *` UTC = 12:00 / 24:00 KST)
- 배포: GitHub Pages (서버·DB 없이 무료)

## 구조
```
config/sources.json      추적할 소스(계정·검색어)와 트렌드 키워드
scripts/collect.mjs      검색 API(카카오·네이버) 호출 → public/data/feed.json 생성
public/                  정적 사이트 (index.html, app.js, style.css)
.github/workflows/update.yml   12시·24시 자동 수집 + 배포
```

## 시작하기
1. **카카오 REST API 키 발급** — https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가하기 → 만든 앱의 **앱 키 > REST API 키** 복사. 가게 검색이 안 되면 앱 설정에서 **카카오맵** 사용 설정을 ON
2. **로컬 확인**
   ```bash
   node scripts/collect.mjs --mock      # 키 없이 샘플 데이터
   KAKAO_REST_API_KEY=xxx node scripts/collect.mjs   # 실제 수집
   npx serve public                     # http://localhost:3000
   ```
3. **GitHub에 올리기**
   - 새 저장소에 push
   - Settings → Secrets and variables → Actions → `KAKAO_REST_API_KEY` 등록 (네이버를 쓸 땐 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`)
   - Settings → Pages → Source: **GitHub Actions**
   - Actions 탭 → "디저트 소식 업데이트 & 배포" → Run workflow 로 첫 실행

## 기능
- 🔥 지금 뜨는 키워드 순위 (지난 업데이트 대비 ▲▼)
- 🏪 지금 핫한 가게: 상위 키워드로 **장소 검색** → 주소·지도 링크, 블로그 후기 문구("6,500원", "웨이팅 40분" 등)에서 뽑은 **대략적인 가격·웨이팅** (후기 건수 함께 표시)
- 📍 지역 필터 (성수, 홍대·연남, 강남·신사, 잠실, 부산 …) — `config/sources.json`의 `regions`에서 수정
- ♥ 찜하기: 소식·가게 모두, 브라우저에 저장 (로그인 없음)
- 🎨 파스텔 테마: `public/style.css` 맨 위 `:root` 색 변수만 바꾸면 전체 색상 변경

> 카카오 키가 있으면 카카오를, 없고 네이버 키가 있으면 네이버를 자동으로 사용해요.

## 소스·키워드 바꾸기
`config/sources.json`의 `accounts`에 항목을 추가하면 됩니다.
- `query`: 검색할 문구 (예: `"성수 팝업스토어 디저트"`)
- `instagram`: 사이트에 바로가기 링크로 표시할 인스타 아이디 (**실제 계정인지 확인 후** `verified: true`)
- `trendKeywords`: 언급 수를 세서 "지금 뜨는 키워드" 순위를 매길 단어 목록 — 새 유행 디저트가 나오면 여기에 추가

## 다음 단계 아이디어
- Claude API로 업데이트마다 "오늘의 디저트 브리핑" 3줄 요약 생성
- 인스타 비즈니스 계정이 생기면 Instagram Graph API(Business Discovery)로 실제 게시물 연동
- 키워드 언급 수 히스토리 저장 → 트렌드 그래프
