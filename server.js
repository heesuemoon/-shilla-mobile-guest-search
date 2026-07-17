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
const DEFAULT_BENEFIT_MAX_RESULTS = 1;
const LOGIN_STORAGE_STATE_PATH = process.env.SHILLA_STORAGE_STATE_PATH || path.join(__dirname, '..', '.shilla-storage-state.json');
const LOGIN_LABEL = process.env.SHILLA_LOGIN_LABEL || '';
const BRAND_QUERY_ALIASES = new Map([
  ['조니워커', 'JOHNNIE WALKER'],
  ['조니 워커', 'JOHNNIE WALKER'],
  ['헤네시', 'HENNESSY'],
  ['오쏘물', 'ORTHOMOL'],
  ['오쏘몰', 'ORTHOMOL'],
]);

let browserPromise;
let loginStorageStateCache;

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
  const normalizedAlias = BRAND_QUERY_ALIASES.get(originalQuery.replace(/\s+/g, ' ').trim().toLowerCase());

  if (productPathMatch) {
    return {
      originalQuery,
      query: productPathMatch[1],
      inputType: 'productUrl',
    };
  }

  return {
    originalQuery,
    query: normalizedAlias || originalQuery,
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

function getLoginStorageState() {
  if (loginStorageStateCache !== undefined) return loginStorageStateCache;

  const rawJson = process.env.SHILLA_STORAGE_STATE_JSON;
  const rawBase64 = process.env.SHILLA_STORAGE_STATE_BASE64;

  if (rawJson) {
    loginStorageStateCache = JSON.parse(rawJson);
    return loginStorageStateCache;
  }

  if (rawBase64) {
    loginStorageStateCache = JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf8'));
    return loginStorageStateCache;
  }

  if (existsSync(LOGIN_STORAGE_STATE_PATH)) {
    loginStorageStateCache = LOGIN_STORAGE_STATE_PATH;
    return loginStorageStateCache;
  }

  loginStorageStateCache = null;
  return loginStorageStateCache;
}

function hasLoginStorageState() {
  return Boolean(getLoginStorageState());
}

async function createMobileContext(browser, { useLogin = false } = {}) {
  const device = devices['iPhone 13'] || {};
  const storageState = useLogin ? getLoginStorageState() : null;
  return browser.newContext({
    ...device,
    ...(storageState ? { storageState } : {}),
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
}

function extractSku(value) {
  const text = String(value || '');
  const skuLabelMatch = text.match(/(?:sku|스큐|상품sku|상품\s*sku)\D{0,12}(\d{6,})/i);
  if (skuLabelMatch?.[1]) return skuLabelMatch[1];

  const numericMatch = text.match(/\b\d{8,}\b/);
  return numericMatch?.[0] || '';
}

function brandCodeFromSku(sku) {
  const digits = String(sku || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(0, 4) : '';
}

function isRealSku(value) {
  return String(value || '').replace(/\D/g, '').length >= 10;
}

async function gotoAndContinue(page, url, { timeout = 25000 } = {}) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    const currentUrl = page.url();
    const hasDocument = await page
      .locator('body')
      .count()
      .then((count) => count > 0)
      .catch(() => false);

    if (!hasDocument && currentUrl === 'about:blank') {
      throw error;
    }
  }
}

function publicItem(item) {
  const {
    productCode: _productCode,
    guestPrice: _guestPrice,
    salePrice: _salePrice,
    ...rest
  } = item;
  return rest;
}

function publicResult(result) {
  return {
    ...result,
    items: Array.isArray(result.items) ? result.items.map(publicItem) : [],
  };
}

async function settleSearchPage(page, maxResults) {
  await page
    .waitForSelector(
      'li.facet-product.product_box, #facet_new_product_list_container, .filter_no_result, .search_result_nodate',
      { timeout: 15000 },
    )
    .catch(() => {});

  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

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
      { timeout: 12000 },
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
    await page.waitForTimeout(500);
  }
}

async function scrapeShillaInContext(context, keyword, maxResults = DEFAULT_MAX_RESULTS) {
  const input = normalizeSearchInput(keyword);
  const { query } = input;
  const searchUrl = buildSearchUrl(query);
  const page = await context.newPage();

  try {
    page.setDefaultTimeout(30000);
    await gotoAndContinue(page, searchUrl, { timeout: 25000 });
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

        const skuFromText = (value) => {
          const matches = String(value || '').match(/\d{12}/g) || [];
          return matches.find((candidate) => !/^20\d{10}$/.test(candidate)) || '';
        };

        const skuFromImage = (value) => {
          const text = String(value || '');
          const fileMatch = text.match(/(?:^|[/_])(\d{12})(?=(?:[_./-]|$))/);
          return fileMatch?.[1] || skuFromText(text);
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
          const imageSrc = firstAttr(card, ['img[src]'], 'src');
          const productSku = skuFromImage(imageSrc);
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
          const normalizedSalePrice = salePrice.text || (dataPriceUsd ? `$${dataPriceUsd}` : '');

          if (!productName && !brand && !guestPrice.text) continue;

          items.push({
            productCode: code,
            productName,
            brand,
            productSku,
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
    await page.close().catch(() => {});
  }
}

async function scrapeShilla(keyword, maxResults = DEFAULT_MAX_RESULTS) {
  const browser = await getBrowser();
  const context = await createMobileContext(browser);

  try {
    return await scrapeShillaInContext(context, keyword, maxResults);
  } finally {
    await context.close();
  }
}

async function scrapeProductBenefits(context, item, { inputQuery, inputSku, loginApplied }) {
  const productUrl = item.productUrl || (item.productCode ? `${SHILLA_ORIGIN}/estore/kr/ko/p/${item.productCode}` : '');
  const fallbackSku = inputSku || (isRealSku(item.productSku) ? item.productSku : '') || extractSku(item.productName) || '';

  if (!productUrl) {
    return {
      sourceQuery: inputQuery,
      brandCode: brandCodeFromSku(fallbackSku),
      brand: item.brand || '',
      productName: item.productName || '',
      productSku: fallbackSku,
      productCode: item.productCode || '',
      guestPrice: item.guestPrice || '',
      salePrice: item.salePrice || '',
      shillaDiscountRate: item.discountRate || '',
      shillaRewardRate: '',
      shillaSPoint: '',
      benefitBasis: loginApplied ? '로그인 세션 사용' : '비회원',
      benefitText: '',
      productUrl: '',
    };
  }

  const page = await context.newPage();

  try {
    page.setDefaultTimeout(30000);
    await gotoAndContinue(page, productUrl, { timeout: 25000 });
    await page.waitForSelector('body', { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);

    const detail = await page.evaluate(
      ({ fallback }) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const compactKey = (value) => clean(value).replace(/\s+/g, '').toLowerCase();
        const bodyText = document.body?.innerText || '';
        const lines = bodyText
          .split(/\n+/)
          .map(clean)
          .filter(Boolean);

        const firstText = (selectors) => {
          for (const selector of selectors) {
            const text = clean(document.querySelector(selector)?.textContent);
            if (text) return text;
          }
          return '';
        };

        const firstAttr = (selectors, attr) => {
          for (const selector of selectors) {
            const value = document.querySelector(selector)?.getAttribute(attr);
            if (value) return value;
          }
          return '';
        };

        const skuFromText = (value) => {
          const matches = String(value || '').match(/\d{12}/g) || [];
          return matches.find((candidate) => !/^20\d{10}$/.test(candidate)) || '';
        };

        const skuFromImages = () => {
          const imageTexts = Array.from(document.querySelectorAll('img[src]'))
            .map((image) => image.getAttribute('src') || '')
            .join(' ');
          return skuFromText(imageTexts);
        };

        const windowNear = (labels, size = 5) => {
          const keys = labels.map(compactKey);
          for (let i = 0; i < lines.length; i += 1) {
            const key = compactKey(lines[i]);
            if (keys.some((label) => key.includes(label))) {
              return lines.slice(i, i + size).join(' ');
            }
          }
          return '';
        };

        const valueNear = (labels, valuePattern, size = 5) => {
          const text = windowNear(labels, size);
          if (!text) return '';
          const match = text.match(valuePattern);
          return clean(match?.[0] || text);
        };

        const parseJsonLd = () => {
          const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const script of scripts) {
            try {
              const parsed = JSON.parse(script.textContent || '{}');
              const items = Array.isArray(parsed) ? parsed : [parsed];
              const product = items.find((entry) => String(entry?.['@type'] || '').toLowerCase().includes('product'));
              if (product) return product;
            } catch {
              // Ignore malformed JSON-LD blocks.
            }
          }
          return {};
        };

        const jsonLd = parseJsonLd();
        const productNameCandidate =
          firstText(['.product_name', '.product_summary .proname', '.proname', '.goods_name']) ||
          clean(jsonLd.name);
        const invalidProductName =
          !productNameCandidate || /shilladfs|신라면세점|javascript/i.test(productNameCandidate);
        const productName = invalidProductName ? fallback.productName : productNameCandidate;
        const brand =
          firstText(['.brand_name', '.short_brand .name', '.brand', '.product_brand']) ||
          clean(jsonLd.brand?.name || jsonLd.brand) ||
          fallback.brand;

        const skuWindow = valueNear(['SKU', '상품SKU', '상품 SKU', '스큐', '상품코드', '상품번호'], /\d{6,}/, 3);
        const productSku =
          skuWindow.match(/\d{6,}/)?.[0] ||
          skuFromImages() ||
          firstAttr(['[data-sku]', '[data-productsku]', '[data-product-code]', '[data-productcode]'], 'data-sku') ||
          firstAttr(['[data-productsku]'], 'data-productsku') ||
          firstAttr(['[data-product-code]'], 'data-product-code') ||
          firstAttr(['[data-productcode]'], 'data-productcode') ||
          fallback.productSku;

        const benefitLines = lines
          .filter((line) => /(신라|적립|포인트|s\s*point|s포인트|할인|혜택)/i.test(line))
          .slice(0, 40)
          .join(' | ');
        const membershipLine = lines.find((line) => /(gold|골드|silver|실버|black|블랙|회원등급|멤버십|로그아웃|마이페이지)/i.test(line)) || '';
        const membershipBasis = /gold|골드/i.test(membershipLine)
          ? '로그인(골드)'
          : /silver|실버/i.test(membershipLine)
            ? '로그인(실버)'
            : /black|블랙/i.test(membershipLine)
              ? '로그인(블랙)'
              : /(회원등급|멤버십|로그아웃|마이페이지)/i.test(membershipLine)
                ? '로그인'
                : '';

        return {
          brand,
          productName,
          productSku,
          shillaDiscountRate:
            valueNear(['신라할인율', '신라 할인율', '할인율'], /\d+(?:\.\d+)?\s*%/, 5) || fallback.discountRate,
          shillaRewardRate: valueNear(['신라적립율', '신라 적립율', '신라적립률', '신라 적립률', '적립율', '적립률', '적립금'], /(?:\d+(?:\.\d+)?\s*%|[\d,]+\s*원|[\d,]+\s*P)/, 5),
          shillaSPoint: valueNear(['신라S포인트', '신라 S포인트', 'S포인트', 'S-POINT', 'S POINT', 'S.Point'], /(?:[\d,]+\s*P|[\d,]+\s*포인트|[\d,]+\s*원|\d+(?:\.\d+)?\s*%)/i, 6),
          membershipBasis,
          benefitText: benefitLines,
          finalUrl: window.location.href,
        };
      },
      {
        fallback: {
          brand: item.brand || '',
          productName: item.productName || '',
          productSku: fallbackSku,
          discountRate: item.discountRate || '',
        },
      },
    );

    const productSku = detail.productSku || fallbackSku;
    const normalizedSku = isRealSku(productSku) ? productSku : fallbackSku;

    return {
      sourceQuery: inputQuery,
      brandCode: brandCodeFromSku(inputSku || normalizedSku),
      brand: detail.brand || item.brand || '',
      productName: detail.productName || item.productName || '',
      productSku: normalizedSku,
      productCode: item.productCode || '',
      salePrice: item.salePrice || '',
      shillaDiscountRate: detail.shillaDiscountRate || item.discountRate || '',
      shillaRewardRate: detail.shillaRewardRate || '',
      shillaSPoint: detail.shillaSPoint || '',
      benefitBasis: detail.membershipBasis || (loginApplied ? '로그인 세션 사용' : '비회원'),
      benefitText: detail.benefitText || '',
      productUrl: detail.finalUrl || productUrl,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeBenefitRows(keyword, maxResults = DEFAULT_BENEFIT_MAX_RESULTS) {
  const browser = await getBrowser();
  const loginApplied = hasLoginStorageState();
  const context = await createMobileContext(browser, { useLogin: loginApplied });
  const inputSku = extractSku(keyword);

  try {
    let search = await scrapeShillaInContext(context, keyword, maxResults);
    if (loginApplied && search.items.length === 0) {
      const guestSearchContext = await createMobileContext(browser);
      try {
        search = await scrapeShillaInContext(guestSearchContext, keyword, maxResults);
      } finally {
        await guestSearchContext.close();
      }
    }

    const items = search.items.slice(0, maxResults);

    if (!items.length) {
      return {
        query: keyword,
        loginApplied,
        accountLabel: LOGIN_LABEL || (loginApplied ? '로그인 세션' : '비회원'),
        retrievedAt: new Date().toISOString(),
        count: 1,
        items: [
          {
            sourceQuery: keyword,
            brandCode: brandCodeFromSku(inputSku),
            brand: '',
            productName: search.noResultMessage || '검색 결과가 없습니다.',
            productSku: inputSku,
            productCode: '',
            guestPrice: '',
            salePrice: '',
            shillaDiscountRate: '',
            shillaRewardRate: '',
            shillaSPoint: '',
            benefitBasis: loginApplied ? '로그인 세션 사용' : '비회원',
            benefitText: '',
            productUrl: '',
          },
        ],
      };
    }

    const rows = [];
    for (const item of items) {
      rows.push(await scrapeProductBenefits(context, item, { inputQuery: keyword, inputSku, loginApplied }));
    }

    return {
      query: keyword,
      loginApplied,
      accountLabel: LOGIN_LABEL || (loginApplied ? '로그인 세션' : '비회원'),
      searchUrl: search.searchUrl,
      finalUrl: search.finalUrl,
      retrievedAt: new Date().toISOString(),
      count: rows.length,
      items: rows,
    };
  } finally {
    await context.close();
  }
}

const STATIC_ASSETS = new Map([
  ["/", { type: "text/html; charset=utf-8", body: "<!doctype html>\n<html lang=\"ko\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>신라면세점 모바일 상품/혜택 조회</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\" />\n  </head>\n  <body>\n    <main class=\"app\">\n      <section class=\"search-panel\">\n        <div>\n          <h1>신라면세점 모바일 상품/혜택 조회</h1>\n          <p class=\"subtle\">상품명, SKU, 신라 상품 URL을 입력하면 모바일 검색 결과에서 상품 정보를 추출합니다.</p>\n        </div>\n\n        <form id=\"searchForm\" class=\"search-form\">\n          <input\n            id=\"query\"\n            name=\"query\"\n            type=\"search\"\n            autocomplete=\"off\"\n            placeholder=\"예: 라네즈, 5745177, https://m.shilladfs.com/.../p/5786502\"\n            aria-label=\"상품명, SKU, 신라 상품 URL\"\n            required\n          />\n          <button id=\"searchButton\" type=\"submit\">검색</button>\n        </form>\n      </section>\n\n      <section class=\"upload-panel\">\n        <div>\n          <h2>엑셀 일괄 조회</h2>\n          <p class=\"subtle\">엑셀 양식의 입력값 열에 브랜드명, SKU, 상품 URL을 한 줄에 하나씩 넣으면 됩니다. 로그인 세션이 있으면 혜택 조회는 회원 기준으로 실행됩니다.</p>\n        </div>\n        <div class=\"upload-controls\">\n          <input id=\"batchFile\" type=\"file\" accept=\".xlsx,.xls,.csv,.tsv,.txt\" />\n          <button id=\"templateButton\" class=\"secondary-button\" type=\"button\">엑셀 양식 다운로드</button>\n          <button id=\"batchButton\" type=\"button\">검색결과 일괄 조회</button>\n          <button id=\"benefitsButton\" type=\"button\">로그인 혜택 조회</button>\n        </div>\n      </section>\n\n      <section class=\"status-panel\" aria-live=\"polite\">\n        <div id=\"statusText\">검색어를 입력하세요.</div>\n        <div class=\"status-actions\">\n          <button id=\"downloadButton\" class=\"secondary-button\" type=\"button\" hidden>엑셀 다운로드</button>\n          <a id=\"sourceLink\" class=\"source-link\" href=\"#\" target=\"_blank\" rel=\"noreferrer\" hidden>검색 결과 페이지 열기</a>\n        </div>\n      </section>\n\n      <section class=\"table-wrap\">\n        <table>\n          <thead>\n            <tr>\n              <th>입력값</th>\n              <th>브랜드코드</th>\n              <th>브랜드</th>\n              <th>상품명</th>\n              <th>상품SKU</th>\n              <th>신라할인율</th>\n              <th>신라적립율</th>\n              <th>신라S포인트</th>\n              <th>조회기준</th>\n              <th>상품 URL</th>\n            </tr>\n          </thead>\n          <tbody id=\"resultsBody\">\n            <tr class=\"empty-row\">\n              <td colspan=\"10\">아직 조회한 결과가 없습니다.</td>\n            </tr>\n          </tbody>\n        </table>\n      </section>\n    </main>\n\n    <script src=\"https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\"></script>\n    <script src=\"/app.js\" type=\"module\"></script>\n  </body>\n</html>\n" }],
  ["/index.html", { type: "text/html; charset=utf-8", body: "<!doctype html>\n<html lang=\"ko\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>신라면세점 모바일 상품/혜택 조회</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\" />\n  </head>\n  <body>\n    <main class=\"app\">\n      <section class=\"search-panel\">\n        <div>\n          <h1>신라면세점 모바일 상품/혜택 조회</h1>\n          <p class=\"subtle\">상품명, SKU, 신라 상품 URL을 입력하면 모바일 검색 결과에서 상품 정보를 추출합니다.</p>\n        </div>\n\n        <form id=\"searchForm\" class=\"search-form\">\n          <input\n            id=\"query\"\n            name=\"query\"\n            type=\"search\"\n            autocomplete=\"off\"\n            placeholder=\"예: 라네즈, 5745177, https://m.shilladfs.com/.../p/5786502\"\n            aria-label=\"상품명, SKU, 신라 상품 URL\"\n            required\n          />\n          <button id=\"searchButton\" type=\"submit\">검색</button>\n        </form>\n      </section>\n\n      <section class=\"upload-panel\">\n        <div>\n          <h2>엑셀 일괄 조회</h2>\n          <p class=\"subtle\">엑셀 양식의 입력값 열에 브랜드명, SKU, 상품 URL을 한 줄에 하나씩 넣으면 됩니다. 로그인 세션이 있으면 혜택 조회는 회원 기준으로 실행됩니다.</p>\n        </div>\n        <div class=\"upload-controls\">\n          <input id=\"batchFile\" type=\"file\" accept=\".xlsx,.xls,.csv,.tsv,.txt\" />\n          <button id=\"templateButton\" class=\"secondary-button\" type=\"button\">엑셀 양식 다운로드</button>\n          <button id=\"batchButton\" type=\"button\">검색결과 일괄 조회</button>\n          <button id=\"benefitsButton\" type=\"button\">로그인 혜택 조회</button>\n        </div>\n      </section>\n\n      <section class=\"status-panel\" aria-live=\"polite\">\n        <div id=\"statusText\">검색어를 입력하세요.</div>\n        <div class=\"status-actions\">\n          <button id=\"downloadButton\" class=\"secondary-button\" type=\"button\" hidden>엑셀 다운로드</button>\n          <a id=\"sourceLink\" class=\"source-link\" href=\"#\" target=\"_blank\" rel=\"noreferrer\" hidden>검색 결과 페이지 열기</a>\n        </div>\n      </section>\n\n      <section class=\"table-wrap\">\n        <table>\n          <thead>\n            <tr>\n              <th>입력값</th>\n              <th>브랜드코드</th>\n              <th>브랜드</th>\n              <th>상품명</th>\n              <th>상품SKU</th>\n              <th>신라할인율</th>\n              <th>신라적립율</th>\n              <th>신라S포인트</th>\n              <th>조회기준</th>\n              <th>상품 URL</th>\n            </tr>\n          </thead>\n          <tbody id=\"resultsBody\">\n            <tr class=\"empty-row\">\n              <td colspan=\"10\">아직 조회한 결과가 없습니다.</td>\n            </tr>\n          </tbody>\n        </table>\n      </section>\n    </main>\n\n    <script src=\"https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\"></script>\n    <script src=\"/app.js\" type=\"module\"></script>\n  </body>\n</html>\n" }],
  ["/styles.css", { type: "text/css; charset=utf-8", body: ":root {\n  color-scheme: light;\n  --bg: #f6f7f9;\n  --panel: #ffffff;\n  --text: #1c1d1f;\n  --muted: #6b7280;\n  --line: #d9dde3;\n  --accent: #111827;\n  --accent-hover: #303846;\n  --error: #b42318;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  background: var(--bg);\n  color: var(--text);\n  font-family:\n    system-ui,\n    -apple-system,\n    BlinkMacSystemFont,\n    \"Segoe UI\",\n    sans-serif;\n}\n\n.app {\n  width: min(1180px, calc(100% - 32px));\n  margin: 32px auto;\n}\n\n.search-panel,\n.upload-panel,\n.status-panel,\n.table-wrap {\n  background: var(--panel);\n  border: 1px solid var(--line);\n  border-radius: 8px;\n}\n\n.search-panel {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(320px, 520px);\n  gap: 24px;\n  align-items: end;\n  padding: 24px;\n}\n\n.upload-panel {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(320px, 520px);\n  gap: 24px;\n  align-items: end;\n  margin-top: 16px;\n  padding: 20px 24px;\n}\n\nh1 {\n  margin: 0 0 8px;\n  font-size: 24px;\n  line-height: 1.25;\n}\n\nh2 {\n  margin: 0 0 8px;\n  font-size: 18px;\n  line-height: 1.3;\n}\n\n.subtle {\n  margin: 0;\n  color: var(--muted);\n  line-height: 1.5;\n}\n\n.search-form {\n  display: flex;\n  gap: 10px;\n}\n\n.upload-controls {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) repeat(3, auto);\n  gap: 10px;\n}\n\ninput,\nbutton {\n  height: 44px;\n  border-radius: 6px;\n  font: inherit;\n}\n\ninput {\n  width: 100%;\n  border: 1px solid var(--line);\n  padding: 0 12px;\n  background: #fff;\n}\n\ninput[type='file'] {\n  padding: 10px 12px;\n}\n\ninput:focus {\n  outline: 2px solid #9ca3af;\n  outline-offset: 1px;\n}\n\nbutton {\n  min-width: 96px;\n  border: 0;\n  background: var(--accent);\n  color: #fff;\n  cursor: pointer;\n  font-weight: 700;\n}\n\nbutton:hover:not(:disabled) {\n  background: var(--accent-hover);\n}\n\nbutton:disabled {\n  cursor: wait;\n  opacity: 0.65;\n}\n\n.status-panel {\n  display: flex;\n  justify-content: space-between;\n  gap: 16px;\n  align-items: center;\n  margin: 16px 0;\n  padding: 14px 16px;\n  color: var(--muted);\n}\n\n.status-panel.error {\n  color: var(--error);\n}\n\n.source-link {\n  color: var(--accent);\n  font-weight: 700;\n  white-space: nowrap;\n}\n\n.status-actions {\n  display: flex;\n  gap: 10px;\n  align-items: center;\n}\n\n.secondary-button {\n  min-width: auto;\n  height: 34px;\n  padding: 0 12px;\n  border: 1px solid var(--line);\n  background: #fff;\n  color: var(--accent);\n}\n\n.secondary-button:hover:not(:disabled) {\n  background: #f3f4f6;\n}\n\n.upload-controls .secondary-button {\n  height: 44px;\n}\n\n.table-wrap {\n  overflow-x: auto;\n}\n\ntable {\n  width: 100%;\n  border-collapse: collapse;\n  min-width: 1620px;\n}\n\nth,\ntd {\n  padding: 14px 12px;\n  border-bottom: 1px solid var(--line);\n  text-align: left;\n  vertical-align: top;\n  line-height: 1.45;\n}\n\nth {\n  position: sticky;\n  top: 0;\n  background: #f9fafb;\n  color: #374151;\n  font-size: 13px;\n  white-space: nowrap;\n}\n\ntd {\n  font-size: 14px;\n}\n\n.product-name {\n  min-width: 260px;\n  font-weight: 700;\n}\n\n.source-query {\n  min-width: 180px;\n  max-width: 260px;\n  word-break: break-all;\n}\n\n.price {\n  white-space: nowrap;\n}\n\n.url-cell {\n  max-width: 320px;\n  word-break: break-all;\n}\n\n.url-cell a {\n  color: #1f4f99;\n}\n\n.empty-row td {\n  padding: 36px 12px;\n  color: var(--muted);\n  text-align: center;\n}\n\n@media (max-width: 760px) {\n  .app {\n    width: min(100% - 20px, 1180px);\n    margin: 16px auto;\n  }\n\n  .search-panel {\n    grid-template-columns: 1fr;\n    padding: 18px;\n  }\n\n  .upload-panel,\n  .upload-controls {\n    grid-template-columns: 1fr;\n  }\n\n  .search-form,\n  .status-panel {\n    flex-direction: column;\n    align-items: stretch;\n  }\n\n  button {\n    width: 100%;\n  }\n}\n" }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: "const form = document.querySelector('#searchForm');\nconst queryInput = document.querySelector('#query');\nconst button = document.querySelector('#searchButton');\nconst statusPanel = document.querySelector('.status-panel');\nconst statusText = document.querySelector('#statusText');\nconst sourceLink = document.querySelector('#sourceLink');\nconst resultsBody = document.querySelector('#resultsBody');\nconst batchFileInput = document.querySelector('#batchFile');\nconst batchButton = document.querySelector('#batchButton');\nconst benefitsButton = document.querySelector('#benefitsButton');\nconst templateButton = document.querySelector('#templateButton');\nconst downloadButton = document.querySelector('#downloadButton');\n\nconst BATCH_MAX_RESULTS_PER_QUERY = 10;\nconst BATCH_MAX_QUERIES = 200;\nconst SEARCH_RESULT_BASIS = '검색결과';\nconst TEMPLATE_ROWS = [\n  ['입력값'],\n  ['라네즈'],\n  ['102467200030'],\n  ['https://m.shilladfs.com/estore/kr/ko/p/5786502?isSavedId=true'],\n];\nlet latestRows = [];\n\nfunction setStatus(message, { error = false, sourceUrl = '' } = {}) {\n  statusPanel.classList.toggle('error', error);\n  statusText.textContent = message;\n\n  if (sourceUrl) {\n    sourceLink.href = sourceUrl;\n    sourceLink.hidden = false;\n  } else {\n    sourceLink.hidden = true;\n  }\n}\n\nfunction escapeHtml(value) {\n  return String(value || '')\n    .replaceAll('&', '&amp;')\n    .replaceAll('<', '&lt;')\n    .replaceAll('>', '&gt;')\n    .replaceAll('\"', '&quot;')\n    .replaceAll(\"'\", '&#039;');\n}\n\nfunction renderEmpty(message) {\n  latestRows = [];\n  downloadButton.hidden = true;\n  resultsBody.innerHTML = `\n    <tr class=\"empty-row\">\n      <td colspan=\"10\">${escapeHtml(message)}</td>\n    </tr>\n  `;\n}\n\nfunction renderRows(items) {\n  const normalizedItems = fillMissingBrandCodes(items);\n  latestRows = normalizedItems;\n  downloadButton.hidden = normalizedItems.length === 0;\n\n  if (!normalizedItems.length) {\n    resultsBody.innerHTML = `\n      <tr class=\"empty-row\">\n        <td colspan=\"10\">검색 결과가 없습니다.</td>\n      </tr>\n    `;\n    return;\n  }\n\n  resultsBody.innerHTML = normalizedItems\n    .map((item) => {\n      const url = escapeHtml(item.productUrl);\n      const urlCell = url ? `<a href=\"${url}\" target=\"_blank\" rel=\"noreferrer\">${url}</a>` : '';\n      return `\n        <tr>\n          <td class=\"source-query\">${escapeHtml(item.sourceQuery)}</td>\n          <td>${escapeHtml(item.brandCode)}</td>\n          <td>${escapeHtml(item.brand)}</td>\n          <td class=\"product-name\">${escapeHtml(item.productName)}</td>\n          <td>${escapeHtml(item.productSku)}</td>\n          <td>${escapeHtml(item.shillaDiscountRate || item.discountRate)}</td>\n          <td>${escapeHtml(item.shillaRewardRate)}</td>\n          <td>${escapeHtml(item.shillaSPoint)}</td>\n          <td>${escapeHtml(item.benefitBasis)}</td>\n          <td class=\"url-cell\">${urlCell}</td>\n        </tr>\n      `;\n    })\n    .join('');\n}\n\nfunction setBusy(isBusy) {\n  button.disabled = isBusy;\n  batchButton.disabled = isBusy;\n  benefitsButton.disabled = isBusy;\n  templateButton.disabled = isBusy;\n}\n\nasync function searchShilla(query, maxResults) {\n  const body = maxResults ? { query, maxResults } : { query };\n  const response = await fetch('/api/search', {\n    method: 'POST',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify(body),\n  });\n\n  const payload = await readJsonResponse(response);\n  if (!response.ok) {\n    throw new Error(payload.error || '검색에 실패했습니다.');\n  }\n  return payload;\n}\n\nasync function searchBenefits(query, maxResults = 1) {\n  const response = await fetch('/api/benefits', {\n    method: 'POST',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify({ query, maxResults }),\n  });\n\n  const payload = await readJsonResponse(response);\n  if (!response.ok) {\n    throw new Error(payload.error || '혜택 조회에 실패했습니다.');\n  }\n  return payload;\n}\n\nasync function readJsonResponse(response) {\n  const text = await response.text();\n  try {\n    return JSON.parse(text);\n  } catch {\n    const message = response.ok\n      ? '서버가 JSON이 아닌 응답을 반환했습니다.'\n      : `서버 오류가 발생했습니다. 상태코드: ${response.status}`;\n    throw new Error(message);\n  }\n}\n\nasync function loadSessionStatus() {\n  try {\n    const response = await fetch('/api/session', { cache: 'no-store' });\n    const payload = await response.json();\n    if (payload.loginAvailable) {\n      setStatus(`로그인 세션이 등록되어 있습니다. 혜택 조회는 ${payload.accountLabel || '로그인'} 기준으로 실행됩니다.`);\n    } else {\n      setStatus('로그인 세션이 없어서 비회원 기준으로 조회합니다.');\n    }\n  } catch {\n    setStatus('검색어를 입력하세요.');\n  }\n}\n\nfunction extractSku(value) {\n  const text = String(value || '');\n  const skuLabelMatch = text.match(/(?:sku|스큐|상품sku|상품\\s*sku)\\D{0,12}(\\d{6,})/i);\n  if (skuLabelMatch?.[1]) return skuLabelMatch[1];\n  return text.match(/\\b\\d{8,}\\b/)?.[0] || '';\n}\n\nfunction brandCodeFromSku(sku) {\n  const digits = String(sku || '').replace(/\\D/g, '');\n  return digits.length >= 4 ? digits.slice(0, 4) : '';\n}\n\nfunction isRealSku(value) {\n  return String(value || '').replace(/\\D/g, '').length >= 10;\n}\n\nfunction normalizeSearchItem(item, sourceQuery, benefitBasis = SEARCH_RESULT_BASIS) {\n  const sourceSku = extractSku(sourceQuery);\n  const itemSku = isRealSku(item.productSku) ? item.productSku : '';\n  const sku = itemSku || sourceSku;\n  const resolvedBasis =\n    item.benefitBasis && !(item.benefitBasis === '비회원' && benefitBasis.startsWith('로그인'))\n      ? item.benefitBasis\n      : benefitBasis;\n  return {\n    sourceQuery,\n    brandCode: item.brandCode || brandCodeFromSku(sku),\n    brand: item.brand || '',\n    productName: item.productName || '',\n    productSku: sku,\n    productCode: item.productCode || '',\n    salePrice: item.salePrice || '',\n    shillaDiscountRate: item.shillaDiscountRate || item.discountRate || '',\n    shillaRewardRate: item.shillaRewardRate || '',\n    shillaSPoint: item.shillaSPoint || '',\n    benefitBasis: resolvedBasis,\n    benefitText: item.benefitText || '',\n    productUrl: item.productUrl || '',\n  };\n}\n\nfunction fillMissingBrandCodes(items) {\n  const brandToCode = new Map();\n\n  for (const item of items) {\n    const brand = String(item.brand || '').trim();\n    const code = String(item.brandCode || brandCodeFromSku(item.productSku)).trim();\n    if (brand && code && !brandToCode.has(brand)) {\n      brandToCode.set(brand, code);\n    }\n  }\n\n  return items.map((item) => {\n    const brand = String(item.brand || '').trim();\n    if (item.brandCode || !brand) return item;\n\n    const inferredCode = brandToCode.get(brand);\n    return inferredCode ? { ...item, brandCode: inferredCode } : item;\n  });\n}\n\nfunction parseDelimitedText(text, delimiter) {\n  const rows = [];\n  let row = [];\n  let cell = '';\n  let quoted = false;\n\n  for (let i = 0; i < text.length; i += 1) {\n    const char = text[i];\n    const next = text[i + 1];\n\n    if (char === '\"' && quoted && next === '\"') {\n      cell += '\"';\n      i += 1;\n    } else if (char === '\"') {\n      quoted = !quoted;\n    } else if (char === delimiter && !quoted) {\n      row.push(cell);\n      cell = '';\n    } else if ((char === '\\n' || char === '\\r') && !quoted) {\n      if (char === '\\r' && next === '\\n') i += 1;\n      row.push(cell);\n      rows.push(row);\n      row = [];\n      cell = '';\n    } else {\n      cell += char;\n    }\n  }\n\n  row.push(cell);\n  rows.push(row);\n  return rows;\n}\n\nfunction normalizeHeader(value) {\n  return String(value || '')\n    .trim()\n    .toLowerCase()\n    .replace(/[\\s_-]+/g, '');\n}\n\nfunction extractQueriesFromRows(rows) {\n  const cleanedRows = rows\n    .map((row) => row.map((cell) => String(cell || '').trim()))\n    .filter((row) => row.some(Boolean));\n\n  if (!cleanedRows.length) return [];\n\n  const headerAliases = new Map([\n    ['입력값', 0],\n    ['검색값', 0],\n    ['검색대상', 0],\n    ['value', 0],\n    ['input', 0],\n    ['상품url', 1],\n    ['url', 1],\n    ['producturl', 1],\n    ['sku', 2],\n    ['스큐', 2],\n    ['상품sku', 2],\n    ['상품코드', 3],\n    ['상품번호', 3],\n    ['productcode', 3],\n    ['검색어', 4],\n    ['keyword', 4],\n    ['query', 4],\n    ['상품명', 5],\n    ['productname', 5],\n    ['브랜드명', 6],\n    ['브랜드', 6],\n    ['brand', 6],\n  ]);\n\n  const headers = cleanedRows[0].map(normalizeHeader);\n  const matchingHeaders = headers\n    .map((header, index) => ({ index, priority: headerAliases.get(header) }))\n    .filter((header) => header.priority !== undefined)\n    .sort((a, b) => a.priority - b.priority);\n\n  const valueIndex = matchingHeaders[0]?.index ?? 0;\n  const dataRows = matchingHeaders.length ? cleanedRows.slice(1) : cleanedRows;\n  const seen = new Set();\n  const queries = [];\n\n  for (const row of dataRows) {\n    const value = (row[valueIndex] || row.find(Boolean) || '').trim();\n    if (!value || seen.has(value)) continue;\n    seen.add(value);\n    queries.push(value);\n    if (queries.length >= BATCH_MAX_QUERIES) break;\n  }\n\n  return queries;\n}\n\nasync function readBatchQueries(file) {\n  const lowerName = file.name.toLowerCase();\n\n  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {\n    if (!window.XLSX) {\n      throw new Error('엑셀 파일 읽기 모듈을 불러오지 못했습니다. CSV로 저장한 뒤 업로드해 주세요.');\n    }\n\n    const buffer = await file.arrayBuffer();\n    const workbook = window.XLSX.read(buffer, { type: 'array' });\n    const firstSheetName = workbook.SheetNames[0];\n    const sheet = workbook.Sheets[firstSheetName];\n    const rows = window.XLSX.utils.sheet_to_json(sheet, {\n      header: 1,\n      raw: false,\n      defval: '',\n    });\n    return extractQueriesFromRows(rows);\n  }\n\n  const text = await file.text();\n  const delimiter = lowerName.endsWith('.tsv') || text.includes('\\t') ? '\\t' : ',';\n  return extractQueriesFromRows(parseDelimitedText(text, delimiter));\n}\n\nfunction toCsvValue(value) {\n  const text = String(value || '');\n  return /[\",\\n\\r]/.test(text) ? `\"${text.replaceAll('\"', '\"\"')}\"` : text;\n}\n\nfunction downloadTemplate() {\n  if (window.XLSX) {\n    const workbook = window.XLSX.utils.book_new();\n    const sheet = window.XLSX.utils.aoa_to_sheet(TEMPLATE_ROWS);\n    sheet['!cols'] = [{ wch: 70 }];\n    window.XLSX.utils.book_append_sheet(workbook, sheet, '일괄조회양식');\n    window.XLSX.writeFile(workbook, 'shilla-batch-template.xlsx');\n    return;\n  }\n\n  const lines = TEMPLATE_ROWS.map((row) => row.map(toCsvValue).join(','));\n  const blob = new Blob([`\\ufeff${lines.join('\\n')}`], { type: 'text/csv;charset=utf-8' });\n  const url = URL.createObjectURL(blob);\n  const link = document.createElement('a');\n  link.href = url;\n  link.download = 'shilla-batch-template.csv';\n  link.click();\n  URL.revokeObjectURL(url);\n}\n\nfunction downloadCsv() {\n  if (!latestRows.length) return;\n  const exportRows = fillMissingBrandCodes(latestRows);\n\n  const headers = [\n    '입력값',\n    '브랜드코드',\n    '브랜드',\n    '상품명',\n    '상품SKU',\n    '신라할인율',\n    '신라적립율',\n    '신라S포인트',\n    '조회기준',\n    '상품 URL',\n    '혜택 원문',\n  ];\n\n  const rows = exportRows.map((row) => ({\n    입력값: row.sourceQuery || '',\n    브랜드코드: row.brandCode || '',\n    브랜드: row.brand || '',\n    상품명: row.productName || '',\n    상품SKU: row.productSku || '',\n    신라할인율: row.shillaDiscountRate || '',\n    신라적립율: row.shillaRewardRate || '',\n    신라S포인트: row.shillaSPoint || '',\n    조회기준: row.benefitBasis || '',\n    '상품 URL': row.productUrl || '',\n    '혜택 원문': row.benefitText || '',\n  }));\n\n  if (window.XLSX) {\n    const workbook = window.XLSX.utils.book_new();\n    const sheet = window.XLSX.utils.json_to_sheet(rows, { header: headers });\n    sheet['!cols'] = headers.map((header) => ({ wch: header === '혜택 원문' || header === '상품 URL' ? 70 : 18 }));\n    window.XLSX.utils.book_append_sheet(workbook, sheet, '조회결과');\n    window.XLSX.writeFile(workbook, `shilla-benefits-${new Date().toISOString().slice(0, 10)}.xlsx`);\n    return;\n  }\n\n  const lines = [\n    headers.map(toCsvValue).join(','),\n    ...rows.map((row) => headers.map((header) => toCsvValue(row[header])).join(',')),\n  ];\n\n  const blob = new Blob([`\\ufeff${lines.join('\\n')}`], { type: 'text/csv;charset=utf-8' });\n  const url = URL.createObjectURL(blob);\n  const link = document.createElement('a');\n  link.href = url;\n  link.download = `shilla-benefits-${new Date().toISOString().slice(0, 10)}.csv`;\n  link.click();\n  URL.revokeObjectURL(url);\n}\n\nform.addEventListener('submit', async (event) => {\n  event.preventDefault();\n\n  const query = queryInput.value.trim();\n  if (!query) return;\n\n  setBusy(true);\n  setStatus('검색 중입니다. 신라면세점 모바일 페이지를 Playwright로 열고 있습니다.');\n  renderEmpty('검색 중입니다.');\n\n  try {\n    const payload = await searchShilla(query);\n\n    renderRows((payload.items || []).map((item) => normalizeSearchItem(item, query, SEARCH_RESULT_BASIS)));\n    const message =\n      payload.count > 0\n        ? `${payload.count}건을 추출했습니다. 조회 시각: ${new Date(payload.retrievedAt).toLocaleString()}`\n        : payload.noResultMessage || '검색 결과가 없습니다.';\n    setStatus(message, { sourceUrl: payload.finalUrl || payload.searchUrl });\n  } catch (error) {\n    renderEmpty('조회에 실패했습니다.');\n    setStatus(error.message, { error: true });\n  } finally {\n    setBusy(false);\n  }\n});\n\nbatchButton.addEventListener('click', async () => {\n  const file = batchFileInput.files?.[0];\n  if (!file) {\n    setStatus('엑셀 또는 CSV 파일을 선택하세요.', { error: true });\n    return;\n  }\n\n  setBusy(true);\n  renderEmpty('파일을 읽는 중입니다.');\n  setStatus('파일을 읽는 중입니다.');\n\n  try {\n    const queries = await readBatchQueries(file);\n    if (!queries.length) {\n      throw new Error('파일에서 검색어를 찾지 못했습니다.');\n    }\n\n    const rows = [];\n    for (let i = 0; i < queries.length; i += 1) {\n      const query = queries[i];\n      setStatus(`검색결과 일괄 조회 중입니다. ${i + 1}/${queries.length}: ${query}`);\n\n      try {\n        const payload = await searchShilla(query, BATCH_MAX_RESULTS_PER_QUERY);\n        if (payload.items?.length) {\n          rows.push(...payload.items.map((item) => normalizeSearchItem(item, query, SEARCH_RESULT_BASIS)));\n        } else {\n          rows.push({\n            sourceQuery: query,\n            brandCode: brandCodeFromSku(extractSku(query)),\n            brand: '',\n            productName: payload.noResultMessage || '검색 결과가 없습니다.',\n            productSku: extractSku(query),\n            productCode: '',\n            guestPrice: '',\n            salePrice: '',\n            shillaDiscountRate: '',\n            shillaRewardRate: '',\n            shillaSPoint: '',\n            benefitBasis: SEARCH_RESULT_BASIS,\n            benefitText: '',\n            productUrl: '',\n          });\n        }\n      } catch (error) {\n        rows.push({\n          sourceQuery: query,\n          brandCode: brandCodeFromSku(extractSku(query)),\n          brand: '',\n          productName: error.message || '조회 실패',\n          productSku: extractSku(query),\n          productCode: '',\n          guestPrice: '',\n          salePrice: '',\n          shillaDiscountRate: '',\n          shillaRewardRate: '',\n          shillaSPoint: '',\n          benefitBasis: SEARCH_RESULT_BASIS,\n          benefitText: '',\n          productUrl: '',\n        });\n      }\n\n      renderRows(rows);\n    }\n\n    setStatus(`${queries.length}개 입력값의 검색결과 조회를 완료했습니다. 결과 ${rows.length}행을 추출했습니다.`);\n  } catch (error) {\n    renderEmpty('검색결과 일괄 조회에 실패했습니다.');\n    setStatus(error.message, { error: true });\n  } finally {\n    setBusy(false);\n  }\n});\n\nbenefitsButton.addEventListener('click', async () => {\n  const file = batchFileInput.files?.[0];\n  if (!file) {\n    setStatus('엑셀 또는 CSV 파일을 선택하세요.', { error: true });\n    return;\n  }\n\n  setBusy(true);\n  renderEmpty('파일을 읽는 중입니다.');\n  setStatus('파일을 읽는 중입니다.');\n\n  try {\n    const queries = await readBatchQueries(file);\n    if (!queries.length) {\n      throw new Error('파일에서 검색어를 찾지 못했습니다.');\n    }\n\n    const rows = [];\n    for (let i = 0; i < queries.length; i += 1) {\n      const query = queries[i];\n      setStatus(`혜택 일괄 조회 중입니다. ${i + 1}/${queries.length}: ${query}`);\n\n      try {\n        const payload = await searchBenefits(query, 1);\n        const basis = payload.loginApplied ? `로그인${payload.accountLabel ? ` (${payload.accountLabel})` : ''}` : '비회원';\n        if (payload.items?.length) {\n          rows.push(...payload.items.map((item) => normalizeSearchItem(item, query, basis)));\n        } else {\n          rows.push({\n            sourceQuery: query,\n            brandCode: brandCodeFromSku(extractSku(query)),\n            brand: '',\n            productName: '검색 결과가 없습니다.',\n            productSku: extractSku(query),\n            productCode: '',\n            guestPrice: '',\n            salePrice: '',\n            shillaDiscountRate: '',\n            shillaRewardRate: '',\n            shillaSPoint: '',\n            benefitBasis: basis,\n            benefitText: '',\n            productUrl: '',\n          });\n        }\n      } catch (error) {\n        rows.push({\n          sourceQuery: query,\n          brandCode: brandCodeFromSku(extractSku(query)),\n          brand: '',\n          productName: error.message || '혜택 조회 실패',\n          productSku: extractSku(query),\n          productCode: '',\n          guestPrice: '',\n          salePrice: '',\n          shillaDiscountRate: '',\n          shillaRewardRate: '',\n          shillaSPoint: '',\n          benefitBasis: '확인 실패',\n          benefitText: '',\n          productUrl: '',\n        });\n      }\n\n      renderRows(rows);\n    }\n\n    setStatus(`${queries.length}개 입력값의 혜택 조회를 완료했습니다. 엑셀 다운로드를 누르면 결과 파일을 받을 수 있습니다.`);\n  } catch (error) {\n    renderEmpty('혜택 일괄 조회에 실패했습니다.');\n    setStatus(error.message, { error: true });\n  } finally {\n    setBusy(false);\n  }\n});\n\ntemplateButton.addEventListener('click', downloadTemplate);\ndownloadButton.addEventListener('click', downloadCsv);\nloadSessionStatus();\n" }],
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

    if (requestUrl.pathname === '/api/session') {
      jsonResponse(res, 200, {
        loginAvailable: hasLoginStorageState(),
        accountLabel: LOGIN_LABEL || (hasLoginStorageState() ? '로그인 세션' : '비회원'),
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
      jsonResponse(res, 200, publicResult(result));
      return;
    }

    if (requestUrl.pathname === '/api/benefits') {
      if (req.method !== 'POST') {
        jsonResponse(res, 405, { error: 'POST만 지원합니다.' });
        return;
      }

      const body = await readJsonBody(req);
      const query = String(body.query || '').trim();
      const requestedMaxResults = Number(body.maxResults || DEFAULT_BENEFIT_MAX_RESULTS);
      const maxResults = Number.isFinite(requestedMaxResults)
        ? Math.min(Math.max(Math.floor(requestedMaxResults), 1), 5)
        : DEFAULT_BENEFIT_MAX_RESULTS;

      if (!query) {
        jsonResponse(res, 400, { error: '상품명, SKU 또는 상품 URL을 입력하세요.' });
        return;
      }

      const result = await scrapeBenefitRows(query, maxResults);
      jsonResponse(res, 200, publicResult(result));
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
