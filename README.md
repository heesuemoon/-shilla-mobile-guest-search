# 신라면세점 모바일 비회원 검색 웹앱

상품명, SKU, 신라 상품 URL을 입력하면 신라면세점 모바일 검색 결과 페이지를 Playwright로 열고, 결과 카드에서 상품명, 브랜드, 비회원가, 판매가, 상품 URL을 추출해 표로 보여줍니다.

엑셀 또는 CSV 파일을 올려 여러 검색어를 한 번에 조회할 수 있습니다. 첫 번째 시트에서 `검색어`, `SKU`, `상품명`, `상품 URL`, `브랜드명` 열을 우선 읽고, 헤더가 없으면 첫 번째 열을 검색어로 사용합니다.

## 실행

```bash
npm install
npm run install:browsers
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다.

Playwright Chromium이 아직 설치되지 않은 경우 서버는 설치된 Google Chrome도 자동으로 시도합니다. 직접 지정하려면 `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm start`처럼 실행할 수 있습니다.

## 공개 URL로 배포

아이폰이나 외부 기기에서 `localhost`로 접속할 수 없습니다. `localhost`는 각 기기 자기 자신을 뜻하므로, 어디서든 접속하려면 Render, Fly.io, Railway, VPS 같은 서버 실행형 호스팅에 배포해야 합니다.

이 앱은 Playwright로 Chromium을 실행하므로 정적 사이트 호스팅이 아니라 Docker 기반 웹 서비스로 배포하는 편이 안전합니다. 이 저장소에는 `Dockerfile`이 포함되어 있습니다.

Render 예시:

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 `New > Web Service`를 만들고 GitHub 저장소를 연결합니다.
3. Runtime 또는 Language는 `Docker`를 선택합니다.
4. Dockerfile 경로는 저장소 루트의 `Dockerfile`을 사용합니다.
5. 배포가 끝나면 `https://...onrender.com` 형태의 공개 URL이 생깁니다.

헬스체크 URL은 `/healthz`입니다.

## 동작 범위

- 로그인 없는 비회원 조회만 구현했습니다.
- 검색 URL은 한국어 모바일 웹 기준 `https://m.shilladfs.com/estore/kr/ko/search?text=...`를 사용합니다.
- 신라 상품 URL(`/estore/kr/ko/p/숫자`)을 입력하면 `/p/` 뒤 상품코드를 추출해 검색합니다.
- 일괄 조회는 입력값당 최대 10건씩 추출하며, 한 파일에서 최대 200개 입력값까지 처리합니다.
- `비회원가`는 검색 카드의 할인/현재가 영역(`.disprice`)에서 추출합니다.
- `판매가`는 정가/판매가 영역(`.setprice`)을 우선 사용하고, 값이 없으면 상품 데이터의 USD 가격 또는 비회원가를 사용합니다.
- 기본 추출 건수는 50건이며 서버에서 최대 100건으로 제한합니다.

## 참고

신라면세점 페이지 구조가 바뀌면 `src/server.js`의 카드 선택자와 가격 선택자를 조정해야 합니다.
