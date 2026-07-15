import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 3000);
const SHILLA_ORIGIN = 'https://m.shilladfs.com';
const SEARCH_PATH = '/estore/kr/ko/search';
const DEFAULT_MAX_RESULTS = 50;

let browserPromise;

function buildSearchUrl(keyword) {
  const url = new URL(`${SHILLA_ORIGIN}${SEARCH_PATH}`);
  url.searchParams.set('text', keyword);
  url.searchParams.set('within', '');
  url.searchParams.set('categoryPath', '');
  url.searchParams.set('isWith', '');
  url.searchParams.set('uiel', 'Mobile');
  return url.toString();
}

function normalizeSearchInput(input) {
  const originalQuery = input.trim();
  const productPathMatch = originalQuery.match(/\/p\/(\d+)(?:[/?#]|$)/);

  if (productPathMatch) {
    return {
      originalQuery,
      query: productPathMatch[1],
      inputType: 'productUrl',
    };
  }

  return {
    originalQuery,
    query: originalQuery,
    inputType: 'keyword',
  };
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error('요청 본문이 너무 큽니다.');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

async function launchBrowser() {
  const baseOptions = {
    headless: process.env.HEADLESS !== 'false',
  };

  try {
    return await chromium.launch(baseOptions);
  } catch (bundledBrowserError) {
    const fallbackOptions = [];
    const macChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    if (process.env.CHROME_PATH) {
      fallbackOptions.push({ executablePath: process.env.CHROME_PATH });
    }

    fallbackOptions.push({ channel: 'chrome' });

    if (existsSync(macChromePath)) {
      fallbackOptions.push({ executablePath: macChromePath });
    }

    for (const fallback of fallbackOptions) {
      try {
        return await chromium.launch({ ...baseOptions, ...fallback });
      } catch {
        // Try the next configured browser source.
      }
    }

    throw bundledBrowserError;
  }
}

async function settleSearchPage(page, maxResults) {
  await page
    .waitForSelector(
      'li.facet-product.product_box, #facet_new_product_list_container, .filter_no_result, .search_result_nodate',
      { timeout: 30000 },
    )
    .catch(() => {});

  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  await page
    .waitForFunction(
      () => {
        const productCount = document.querySelectorAll('li.facet-product.product_box').length;
        const aiLoading = document.querySelector('.result_ai_loading');
        const visibleNoResult = Array.from(
          document.querySelectorAll('.search_result_nodate, .filter_no_result, .no_result, .result_none, .result_null'),
        ).some((node) => {
          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.textContent.trim();
        });

        return productCount > 0 || (!aiLoading && visibleNoResult);
      },
      { timeout: 25000 },
    )
    .catch(() => {});

  let previousCount = -1;
  let stableRounds = 0;

  for (let i = 0; i < 8; i += 1) {
    const count = await page.locator('li.facet-product.product_box').count().catch(() => 0);
    if (count >= maxResults) break;

    if (count === previousCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      previousCount = count;
    }

    if (stableRounds >= 2) break;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(700);
  }
}

async function scrapeShilla(keyword, maxResults = DEFAULT_MAX_RESULTS) {
  const input = normalizeSearchInput(keyword);
  const { query } = input;
  const searchUrl = buildSearchUrl(query);
  const browser = await getBrowser();
  const device = devices['iPhone 13'] || {};
  const context = await browser.newContext({
    ...device,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settleSearchPage(page, maxResults);

    const extracted = await page.evaluate(
      ({ maxResults: limit, origin }) => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const compact = (value) => clean(value).replace(/\s+원/g, '원');

        const firstText = (root, selectors) => {
          for (const selector of selectors) {
            const node = root.querySelector(selector);
            const text = clean(node?.textContent);
            if (text) return text;
          }
          return '';
        };

        const firstAttr = (root, selectors, attr) => {
          for (const selector of selectors) {
            const node = root.querySelector(selector);
            const value = node?.getAttribute(attr);
            if (value) return value;
          }
          return '';
        };

        const getDataset = (root, selectors, key) => {
          for (const selector of selectors) {
            const node = root.querySelector(selector);
            const value = node?.dataset?.[key];
            if (value) return value;
          }
          return '';
        };

        const pathFromHref = (href) => {
          if (!href) return '';
          if (href.startsWith('http')) {
            try {
              const url = new URL(href);
              return `${url.pathname}${url.search}`;
            } catch {
              return '';
            }
          }
          if (href.startsWith('/')) return href;

          const openMatch = href.match(/open\(['"]([^'"]+)['"]/);
          if (openMatch?.[1]) return openMatch[1];

          const pathMatch = href.match(/(\/estore\/kr\/ko\/p\/[0-9]+[^'")]*)/);
          return pathMatch?.[1] || '';
        };

        const absoluteProductUrl = (pathOrHref, code) => {
          let productPath = pathFromHref(pathOrHref);
          if (!productPath && code) productPath = `/estore/kr/ko/p/${code}`;
          if (!productPath) return '';
          return new URL(productPath, origin).toString();
        };

        const priceFrom = (node) => {
          if (!node) {
            return { text: '', usd: '', krw: '', rate: '' };
          }

          const usd = compact(node.querySelector('.dollar')?.textContent);
          const krw = compact(node.querySelector('.local')?.textContent);
          const rate = compact(node.querySelector('.rate')?.textContent);
          const fallback = compact(node.textContent);
          const text = [usd, krw].filter(Boolean).join(' / ') || fallback;

          return { text, usd, krw, rate };
        };

        const resultContainer = document.querySelector('#facet_new_product_list_container');
        const cards = resultContainer
          ? Array.from(resultContainer.querySelectorAll('li.facet-product.product_box, li.product_box'))
          : Array.from(document.querySelectorAll('li.facet-product.product_box'));
        const seen = new Set();
        const items = [];

        for (const card of cards) {
          const code =
            getDataset(card, ['button[data-productcode]', 'a.content_link[data-code]', '.pro_img[data-code]'], 'productcode') ||
            getDataset(card, ['a.content_link[data-code]', '.pro_img[data-code]'], 'code') ||
            (card.id || '').match(/[0-9]+/)?.[0] ||
            '';

          const href = firstAttr(card, ['a.content_link[href*="/p/"], a[href*="/p/"]'], 'href');
          const productUrl = absoluteProductUrl(href, code);
          const dedupeKey = productUrl || code;
          if (!dedupeKey || seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          const productName =
            firstText(card, ['.product_summary .proname', '.proname', '.product_txt .tit span']) ||
            getDataset(card, ['button[data-productname]'], 'productname');
          const brand =
            firstText(card, ['.short_brand .name', '.product_txt .tit strong', '.brand']) ||
            getDataset(card, ['button[data-brandname]'], 'brandname');

          const guestPrice = priceFrom(card.querySelector('.proprice .disprice, .price .sale'));
          const salePrice = priceFrom(card.querySelector('.proprice .setprice, .price .regular'));
          const dataPriceUsd = getDataset(card, ['button[data-priceusd]'], 'priceusd');
          const normalizedSalePrice = salePrice.text || (dataPriceUsd ? `$${dataPriceUsd}` : guestPrice.usd || guestPrice.text);

          if (!productName && !brand && !guestPrice.text) continue;

          items.push({
            productCode: code,
            productName,
            brand,
            guestPrice: guestPrice.text,
            salePrice: normalizedSalePrice,
            discountRate: salePrice.rate,
            productUrl,
          });

          if (items.length >= limit) break;
        }

        const visibleNoResult = Array.from(
          document.querySelectorAll('.search_result_nodate, .filter_no_result, .no_result, .result_none, .result_null'),
        )
          .filter((node) => {
            const style = window.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden';
          })
          .map((node) => clean(node.textContent))
          .find(Boolean);

        return {
          items,
          noResultMessage: visibleNoResult || '',
          title: clean(document.title),
        };
      },
      { maxResults, origin: SHILLA_ORIGIN },
    );

    const isLikelySku = /^\d{10,}$/.test(input.originalQuery);
    let noResultMessage = extracted.noResultMessage || '';

    if (extracted.items.length === 0 && input.inputType === 'productUrl') {
      noResultMessage = `상품 URL에서 신라 상품코드 ${query}를 추출했지만 검색 결과가 없습니다.`;
    } else if (extracted.items.length === 0 && isLikelySku) {
      noResultMessage =
        '신라면세점 공개 모바일 검색과 AI 검색에서 이 숫자 SKU가 상품으로 매핑되지 않았습니다. 상품 URL 또는 신라 상품코드(/p/ 뒤 숫자)를 입력해 주세요.';
    }

    return {
      query: input.originalQuery,
      normalizedQuery: query,
      inputType: input.inputType,
      searchUrl,
      finalUrl: page.url(),
      retrievedAt: new Date().toISOString(),
      count: extracted.items.length,
      ...extracted,
      noResultMessage,
    };
  } finally {
    await context.close();
  }
}

const STATIC_ASSETS = new Map([
  ["/", { type: "text/html; charset=utf-8", body: "<!doctype html>\n<html lang=\"ko\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>신라면세점 모바일 비회원 검색</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\" />\n  </head>\n  <body>\n    <main class=\"app\">\n      <section class=\"search-panel\">\n        <div>\n          <h1>신라면세점 모바일 비회원 검색</h1>\n          <p class=\"subtle\">상품명, SKU, 신라 상품 URL을 입력하면 모바일 검색 결과에서 상품 정보를 추출합니다.</p>\n        </div>\n\n        <form id=\"searchForm\" class=\"search-form\">\n          <input\n            id=\"query\"\n            name=\"query\"\n            type=\"search\"\n            autocomplete=\"off\"\n            placeholder=\"예: 라네즈, 5745177, https://m.shilladfs.com/.../p/5786502\"\n            aria-label=\"상품명, SKU, 신라 상품 URL\"\n            required\n          />\n          <button id=\"searchButton\" type=\"submit\">검색</button>\n        </form>\n      </section>\n\n      <section class=\"status-panel\" aria-live=\"polite\">\n        <div id=\"statusText\">검색어를 입력하세요.</div>\n        <a id=\"sourceLink\" class=\"source-link\" href=\"#\" target=\"_blank\" rel=\"noreferrer\" hidden>검색 결과 페이지 열기</a>\n      </section>\n\n      <section class=\"table-wrap\">\n        <table>\n          <thead>\n            <tr>\n              <th>상품명</th>\n              <th>브랜드</th>\n              <th>비회원가</th>\n              <th>판매가</th>\n              <th>상품 URL</th>\n            </tr>\n          </thead>\n          <tbody id=\"resultsBody\">\n            <tr class=\"empty-row\">\n              <td colspan=\"5\">아직 조회한 결과가 없습니다.</td>\n            </tr>\n          </tbody>\n        </table>\n      </section>\n    </main>\n\n    <script src=\"/app.js\" type=\"module\"></script>\n  </body>\n</html>\n" }],
  ["/index.html", { type: "text/html; charset=utf-8", body: "<!doctype html>\n<html lang=\"ko\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>신라면세점 모바일 비회원 검색</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\" />\n  </head>\n  <body>\n    <main class=\"app\">\n      <section class=\"search-panel\">\n        <div>\n          <h1>신라면세점 모바일 비회원 검색</h1>\n          <p class=\"subtle\">상품명, SKU, 신라 상품 URL을 입력하면 모바일 검색 결과에서 상품 정보를 추출합니다.</p>\n        </div>\n\n        <form id=\"searchForm\" class=\"search-form\">\n          <input\n            id=\"query\"\n            name=\"query\"\n            type=\"search\"\n            autocomplete=\"off\"\n            placeholder=\"예: 라네즈, 5745177, https://m.shilladfs.com/.../p/5786502\"\n            aria-label=\"상품명, SKU, 신라 상품 URL\"\n            required\n          />\n          <button id=\"searchButton\" type=\"submit\">검색</button>\n        </form>\n      </section>\n\n      <section class=\"status-panel\" aria-live=\"polite\">\n        <div id=\"statusText\">검색어를 입력하세요.</div>\n        <a id=\"sourceLink\" class=\"source-link\" href=\"#\" target=\"_blank\" rel=\"noreferrer\" hidden>검색 결과 페이지 열기</a>\n      </section>\n\n      <section class=\"table-wrap\">\n        <table>\n          <thead>\n            <tr>\n              <th>상품명</th>\n              <th>브랜드</th>\n              <th>비회원가</th>\n              <th>판매가</th>\n              <th>상품 URL</th>\n            </tr>\n          </thead>\n          <tbody id=\"resultsBody\">\n            <tr class=\"empty-row\">\n              <td colspan=\"5\">아직 조회한 결과가 없습니다.</td>\n            </tr>\n          </tbody>\n        </table>\n      </section>\n    </main>\n\n    <script src=\"/app.js\" type=\"module\"></script>\n  </body>\n</html>\n" }],
  ["/styles.css", { type: "text/css; charset=utf-8", body: ":root {\n  color-scheme: light;\n  --bg: #f6f7f9;\n  --panel: #ffffff;\n  --text: #1c1d1f;\n  --muted: #6b7280;\n  --line: #d9dde3;\n  --accent: #111827;\n  --accent-hover: #303846;\n  --error: #b42318;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  background: var(--bg);\n  color: var(--text);\n  font-family:\n    system-ui,\n    -apple-system,\n    BlinkMacSystemFont,\n    \"Segoe UI\",\n    sans-serif;\n}\n\n.app {\n  width: min(1180px, calc(100% - 32px));\n  margin: 32px auto;\n}\n\n.search-panel,\n.status-panel,\n.table-wrap {\n  background: var(--panel);\n  border: 1px solid var(--line);\n  border-radius: 8px;\n}\n\n.search-panel {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(320px, 520px);\n  gap: 24px;\n  align-items: end;\n  padding: 24px;\n}\n\nh1 {\n  margin: 0 0 8px;\n  font-size: 24px;\n  line-height: 1.25;\n}\n\n.subtle {\n  margin: 0;\n  color: var(--muted);\n  line-height: 1.5;\n}\n\n.search-form {\n  display: flex;\n  gap: 10px;\n}\n\ninput,\nbutton {\n  height: 44px;\n  border-radius: 6px;\n  font: inherit;\n}\n\ninput {\n  width: 100%;\n  border: 1px solid var(--line);\n  padding: 0 12px;\n  background: #fff;\n}\n\ninput:focus {\n  outline: 2px solid #9ca3af;\n  outline-offset: 1px;\n}\n\nbutton {\n  min-width: 96px;\n  border: 0;\n  background: var(--accent);\n  color: #fff;\n  cursor: pointer;\n  font-weight: 700;\n}\n\nbutton:hover:not(:disabled) {\n  background: var(--accent-hover);\n}\n\nbutton:disabled {\n  cursor: wait;\n  opacity: 0.65;\n}\n\n.status-panel {\n  display: flex;\n  justify-content: space-between;\n  gap: 16px;\n  align-items: center;\n  margin: 16px 0;\n  padding: 14px 16px;\n  color: var(--muted);\n}\n\n.status-panel.error {\n  color: var(--error);\n}\n\n.source-link {\n  color: var(--accent);\n  font-weight: 700;\n  white-space: nowrap;\n}\n\n.table-wrap {\n  overflow-x: auto;\n}\n\ntable {\n  width: 100%;\n  border-collapse: collapse;\n  min-width: 900px;\n}\n\nth,\ntd {\n  padding: 14px 12px;\n  border-bottom: 1px solid var(--line);\n  text-align: left;\n  vertical-align: top;\n  line-height: 1.45;\n}\n\nth {\n  position: sticky;\n  top: 0;\n  background: #f9fafb;\n  color: #374151;\n  font-size: 13px;\n  white-space: nowrap;\n}\n\ntd {\n  font-size: 14px;\n}\n\n.product-name {\n  min-width: 260px;\n  font-weight: 700;\n}\n\n.price {\n  white-space: nowrap;\n}\n\n.url-cell {\n  max-width: 320px;\n  word-break: break-all;\n}\n\n.url-cell a {\n  color: #1f4f99;\n}\n\n.empty-row td {\n  padding: 36px 12px;\n  color: var(--muted);\n  text-align: center;\n}\n\n@media (max-width: 760px) {\n  .app {\n    width: min(100% - 20px, 1180px);\n    margin: 16px auto;\n  }\n\n  .search-panel {\n    grid-template-columns: 1fr;\n    padding: 18px;\n  }\n\n  .search-form,\n  .status-panel {\n    flex-direction: column;\n    align-items: stretch;\n  }\n\n  button {\n    width: 100%;\n  }\n}\n" }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: "const form = document.querySelector('#searchForm');\nconst queryInput = document.querySelector('#query');\nconst button = document.querySelector('#searchButton');\nconst statusPanel = document.querySelector('.status-panel');\nconst statusText = document.querySelector('#statusText');\nconst sourceLink = document.querySelector('#sourceLink');\nconst resultsBody = document.querySelector('#resultsBody');\n\nfunction setStatus(message, { error = false, sourceUrl = '' } = {}) {\n  statusPanel.classList.toggle('error', error);\n  statusText.textContent = message;\n\n  if (sourceUrl) {\n    sourceLink.href = sourceUrl;\n    sourceLink.hidden = false;\n  } else {\n    sourceLink.hidden = true;\n  }\n}\n\nfunction escapeHtml(value) {\n  return String(value || '')\n    .replaceAll('&', '&amp;')\n    .replaceAll('<', '&lt;')\n    .replaceAll('>', '&gt;')\n    .replaceAll('\"', '&quot;')\n    .replaceAll(\"'\", '&#039;');\n}\n\nfunction renderEmpty(message) {\n  resultsBody.innerHTML = `\n    <tr class=\"empty-row\">\n      <td colspan=\"5\">${escapeHtml(message)}</td>\n    </tr>\n  `;\n}\n\nfunction renderRows(items) {\n  if (!items.length) {\n    resultsBody.innerHTML = `\n      <tr class=\"empty-row\">\n        <td colspan=\"5\">검색 결과가 없습니다.</td>\n      </tr>\n    `;\n    return;\n  }\n\n  resultsBody.innerHTML = items\n    .map((item) => {\n      const url = escapeHtml(item.productUrl);\n      return `\n        <tr>\n          <td class=\"product-name\">${escapeHtml(item.productName)}</td>\n          <td>${escapeHtml(item.brand)}</td>\n          <td class=\"price\">${escapeHtml(item.guestPrice)}</td>\n          <td class=\"price\">${escapeHtml(item.salePrice)}</td>\n          <td class=\"url-cell\"><a href=\"${url}\" target=\"_blank\" rel=\"noreferrer\">${url}</a></td>\n        </tr>\n      `;\n    })\n    .join('');\n}\n\nform.addEventListener('submit', async (event) => {\n  event.preventDefault();\n\n  const query = queryInput.value.trim();\n  if (!query) return;\n\n  button.disabled = true;\n  setStatus('검색 중입니다. 신라면세점 모바일 페이지를 Playwright로 열고 있습니다.');\n  renderEmpty('검색 중입니다.');\n\n  try {\n    const response = await fetch('/api/search', {\n      method: 'POST',\n      headers: { 'content-type': 'application/json' },\n      body: JSON.stringify({ query }),\n    });\n\n    const payload = await response.json();\n    if (!response.ok) {\n      throw new Error(payload.error || '검색에 실패했습니다.');\n    }\n\n    renderRows(payload.items || []);\n    const message =\n      payload.count > 0\n        ? `${payload.count}건을 추출했습니다. 조회 시각: ${new Date(payload.retrievedAt).toLocaleString()}`\n        : payload.noResultMessage || '검색 결과가 없습니다.';\n    setStatus(message, { sourceUrl: payload.finalUrl || payload.searchUrl });\n  } catch (error) {\n    renderEmpty('조회에 실패했습니다.');\n    setStatus(error.message, { error: true });\n  } finally {\n    button.disabled = false;\n  }\n});\n" }],
]);

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const asset = STATIC_ASSETS.get(requestUrl.pathname);

  if (!asset) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  res.writeHead(200, {
    "content-type": asset.type,
    "cache-control": "no-store",
  });
  res.end(asset.body);
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === '/healthz') {
      jsonResponse(res, 200, {
        ok: true,
        service: 'shilla-mobile-guest-search',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (requestUrl.pathname === '/api/search') {
      if (req.method !== 'POST') {
        jsonResponse(res, 405, { error: 'POST만 지원합니다.' });
        return;
      }

      const body = await readJsonBody(req);
      const query = String(body.query || '').trim();
      const requestedMaxResults = Number(body.maxResults || DEFAULT_MAX_RESULTS);
      const maxResults = Number.isFinite(requestedMaxResults)
        ? Math.min(Math.max(Math.floor(requestedMaxResults), 1), 100)
        : DEFAULT_MAX_RESULTS;

      if (!query) {
        jsonResponse(res, 400, { error: '상품명 또는 SKU를 입력하세요.' });
        return;
      }

      const result = await scrapeShilla(query, maxResults);
      jsonResponse(res, 200, result);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      jsonResponse(res, 405, { error: '지원하지 않는 메서드입니다.' });
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    jsonResponse(res, 500, {
      error: error.message || '검색 중 오류가 발생했습니다.',
    });
  }
});

server.listen(PORT, () => {
  console.log(`Shilla guest search app: http://localhost:${PORT}`);
});

async function shutdown() {
  server.close();
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
