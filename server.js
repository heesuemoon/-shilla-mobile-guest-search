import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRootDir = path.basename(__dirname) === 'src' ? path.join(__dirname, '..') : __dirname;
const publicDir = path.join(appRootDir, 'public');

const PORT = Number(process.env.PORT || 3000);
const IS_HOSTED_RUNTIME = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
const HEADLESS =
  process.env.HEADLESS === 'true' ? true : process.env.HEADLESS === 'false' ? false : IS_HOSTED_RUNTIME;
const SHILLA_ORIGIN = 'https://m.shilladfs.com';
const SEARCH_PATH = '/estore/kr/ko/search';
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_BENEFIT_MAX_RESULTS = 60;
const LOGIN_STORAGE_STATE_PATH = process.env.SHILLA_STORAGE_STATE_PATH || path.join(appRootDir, '.shilla-storage-state.json');
const LOGIN_PROFILE_DIR = process.env.SHILLA_PROFILE_DIR || path.join(appRootDir, '.shilla-chrome-profile-desktop');
const USE_LOGIN_PROFILE = !IS_HOSTED_RUNTIME && process.env.SHILLA_DISABLE_PROFILE !== 'true';
const LOGIN_LABEL = process.env.SHILLA_LOGIN_LABEL || '';
const LOGIN_COOKIE_NAMES = new Set(['sda_tokenKR', 'shilladfsKRRM']);
const DETAIL_SECURITY_COOKIE_NAMES = new Set(['cf_clearance', '__cf_bm']);
const SESSION_PROBE_URL = `${SHILLA_ORIGIN}/estore/kr/ko/p/5901083`;
const SESSION_PROBE_TTL_MS = 5 * 60 * 1000;
const BRAND_QUERY_ALIASES = new Map([
  ['조니워커', 'JOHNNIE WALKER'],
  ['조니 워커', 'JOHNNIE WALKER'],
  ['헤네시', 'HENNESSY'],
  ['헤라', 'HERA'],
  ['설화수', 'SULWHASOO'],
  ['아이오페', 'IOPE'],
  ['이니스프리', 'INNISFREE'],
  ['키엘', 'KIEHLS'],
  ['오쏘물', 'ORTHOMOL'],
  ['오쏘몰', 'ORTHOMOL'],
]);
const BRAND_QUERY_VARIANTS = new Map([
  ['조니워커', ['JOHNNIE WALKER', 'JOHNNIE WALKER BLUE', 'JOHNNIE']],
  ['조니 워커', ['JOHNNIE WALKER', 'JOHNNIE WALKER BLUE', 'JOHNNIE']],
  ['키엘', ['KIEHLS', "KIEHL'S", 'KIEHL']],
  ['헤라', ['HERA']],
  ['설화수', ['SULWHASOO']],
  ['아이오페', ['IOPE']],
]);

let browserPromise;
let loginContextPromise;
let loginPersistentContext;
let loginStorageStateCache;
let loginSessionProbeCache;

function buildSearchUrl(keyword) {
  const url = new URL(`${SHILLA_ORIGIN}${SEARCH_PATH}`);
  url.searchParams.set('text', keyword);
  url.searchParams.set('within', '');
  url.searchParams.set('categoryPath', '');
  url.searchParams.set('isWith', '');
  url.searchParams.set('uiel', 'Mobile');
  return url.toString();
}

function brandSlugFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/estore\/kr\/ko\/b\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function normalizeSearchInput(input) {
  const originalQuery = input.trim();
  const productPathMatch = originalQuery.match(/\/p\/(\d+)(?:[/?#]|$)/);
  const normalizedKey = originalQuery.replace(/\s+/g, ' ').trim().toLowerCase();
  const aliasVariants = BRAND_QUERY_VARIANTS.get(normalizedKey) || [];
  const normalizedAlias = aliasVariants[0] || BRAND_QUERY_ALIASES.get(normalizedKey);

  if (productPathMatch) {
    return {
      originalQuery,
      query: productPathMatch[1],
      inputType: 'productUrl',
      aliasVariants: [],
    };
  }

  return {
    originalQuery,
    query: normalizedAlias || originalQuery,
    inputType: 'keyword',
    aliasVariants,
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
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
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

async function launchPersistentLoginContext() {
  const baseOptions = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    screen: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    ignoreHTTPSErrors: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
    extraHTTPHeaders: {
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  };

  const fallbackOptions = [{ channel: 'chrome' }];
  const macChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  if (process.env.CHROME_PATH) {
    fallbackOptions.unshift({ executablePath: process.env.CHROME_PATH });
  }

  if (existsSync(macChromePath)) {
    fallbackOptions.push({ executablePath: macChromePath });
  }

  let firstError;
  for (const fallback of [{}, ...fallbackOptions]) {
    try {
      return await chromium.launchPersistentContext(LOGIN_PROFILE_DIR, { ...baseOptions, ...fallback });
    } catch (error) {
      firstError ||= error;
    }
  }

  throw firstError;
}

async function getLoginPersistentContext() {
  if (!loginContextPromise) {
    loginContextPromise = launchPersistentLoginContext()
      .then(async (context) => {
        loginPersistentContext = context;
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const storageState = await getLoginStorageStateObject().catch(() => null);
        if (storageState?.cookies?.length) {
          await context.addCookies(storageState.cookies).catch(() => {});
        }

        return context;
      })
      .catch((error) => {
        loginContextPromise = undefined;
        loginPersistentContext = undefined;
        throw error;
      });
  }

  return loginContextPromise;
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

async function getLoginStorageStateObject() {
  const storageState = getLoginStorageState();
  if (!storageState) return null;
  if (typeof storageState === 'string') {
    return JSON.parse(await readFile(storageState, 'utf8'));
  }
  return storageState;
}

async function probeLoginSessionAccess(sessionInfo) {
  if (!sessionInfo.loginTokenValid) return sessionInfo;
  if (!sessionInfo.detailAccessValid && !USE_LOGIN_PROFILE) return sessionInfo;

  const now = Date.now();
  if (loginSessionProbeCache && now - loginSessionProbeCache.checkedAt < SESSION_PROBE_TTL_MS) {
    return {
      ...sessionInfo,
      ...loginSessionProbeCache.result,
      probedAt: new Date(loginSessionProbeCache.checkedAt).toISOString(),
    };
  }

  const browser = USE_LOGIN_PROFILE ? null : await getBrowser();
  const context = await createMobileContext(browser, { useLogin: true });
  const page = await context.newPage();

  try {
    page.setDefaultTimeout(25000);
    await gotoAndContinue(page, SESSION_PROBE_URL, { timeout: 20000 });
    await page.waitForSelector('body', { timeout: 8000 }).catch(() => {});

    const securityCheckAttempts = IS_HOSTED_RUNTIME ? 3 : 20;
    const securityCheckDelayMs = IS_HOSTED_RUNTIME ? 1500 : 3000;
    for (let attempt = 0; attempt < securityCheckAttempts; attempt += 1) {
      const isSecurityCheck = await page
        .evaluate(() =>
          /보안 확인|잠시만 기다리십시오|cloudflare|verify you are human|just a moment|enable javascript and cookies|challenge-platform|cf_chl/i.test(
            `${document.body?.innerText || ''} ${document.title || ''} ${document.documentElement?.innerHTML || ''}`,
          ),
        )
        .catch(() => false);
      if (!isSecurityCheck) break;
      await page.waitForTimeout(securityCheckDelayMs);
    }

    const probe = await page
      .evaluate(() => {
        const text = document.body?.innerText || '';
        return {
          blockedBySecurity:
            /보안 확인|잠시만 기다리십시오|cloudflare|verify you are human|just a moment|enable javascript and cookies|challenge-platform|cf_chl/i.test(
              `${text} ${document.title || ''} ${document.documentElement?.innerHTML || ''}`,
            ),
          hasProductDetail: /(최대\s*혜택가|상품\s*할인|장바구니|바로구매|상품정보|상품\s*상세|SKU|스큐)/i.test(text),
          membershipSignal: /(로그아웃|마이페이지|회원등급|멤버십|골드|gold|실버|silver|블랙|black)/i.test(text),
          finalUrl: window.location.href,
        };
      })
      .catch((error) => ({
        blockedBySecurity: true,
        hasProductDetail: false,
        membershipSignal: false,
        finalUrl: page.url(),
        error: error.message,
      }));

    let result;
    if (probe.blockedBySecurity) {
      const blockedRuntime = IS_HOSTED_RUNTIME ? 'Render 서버' : '로컬 Chrome 자동 브라우저';
      result = {
        loginValid: false,
        detailAccessValid: false,
        needsLogin: true,
        renderSecurityBlocked: IS_HOSTED_RUNTIME,
        localSecurityBlocked: !IS_HOSTED_RUNTIME,
        reason: `${blockedRuntime}에서 신라 상품 상세페이지 보안 확인을 통과하지 못했습니다. 로그인 쿠키는 등록됐지만 신라 보안 확인을 다시 통과해야 합니다.`,
        probeUrl: probe.finalUrl || page.url(),
      };
    } else if (!probe.hasProductDetail) {
      result = {
        loginValid: false,
        detailAccessValid: false,
        needsLogin: true,
        reason:
          '신라 상품 상세페이지를 정상 화면으로 확인하지 못했습니다. 로그인 세션을 다시 캡처해 주세요.',
        probeUrl: probe.finalUrl || page.url(),
      };
    } else {
      result = {
        loginValid: true,
        detailAccessValid: true,
        needsLogin: false,
        reason: '',
        probeUrl: probe.finalUrl || page.url(),
      };
    }

    loginSessionProbeCache = { checkedAt: now, result };
    return { ...sessionInfo, ...result, probedAt: new Date(now).toISOString() };
  } catch (error) {
    const blockedRuntime = IS_HOSTED_RUNTIME ? 'Render 서버' : '로컬 Chrome 자동 브라우저';
    const result = {
      loginValid: false,
      detailAccessValid: false,
      needsLogin: true,
      reason: `${blockedRuntime}에서 신라 상품 상세페이지 확인에 실패했습니다. ${error.message || '로그인 세션을 다시 캡처해 주세요.'}`,
      probeUrl: page.url(),
    };
    loginSessionProbeCache = { checkedAt: now, result };
    return { ...sessionInfo, ...result, probedAt: new Date(now).toISOString() };
  } finally {
    await page.close().catch(() => {});
    await closeMobileContext(context);
  }
}

async function getLoginSessionInfo({ probe = false } = {}) {
  const storageState = await getLoginStorageStateObject().catch(() => null);
  if (!storageState) {
    return {
      loginAvailable: false,
      loginValid: false,
      needsLogin: true,
      accountLabel: '비회원',
      reason: '로그인 세션 파일 또는 환경변수가 없습니다.',
    };
  }

  const now = Date.now() / 1000;
  const allCookies = storageState.cookies || [];
  const loginCookies = allCookies.filter((cookie) => LOGIN_COOKIE_NAMES.has(cookie.name));
  const activeCookies = loginCookies.filter((cookie) => cookie.expires === -1 || Number(cookie.expires || 0) > now);
  const activeDetailSecurityCookies = allCookies.filter(
    (cookie) => DETAIL_SECURITY_COOKIE_NAMES.has(cookie.name) && (cookie.expires === -1 || Number(cookie.expires || 0) > now),
  );
  const hasCfClearance = activeDetailSecurityCookies.some((cookie) => cookie.name === 'cf_clearance');
  const hasCfBm = activeDetailSecurityCookies.some((cookie) => cookie.name === '__cf_bm');
  const loginTokenValid = activeCookies.length > 0;
  const detailAccessValid = loginTokenValid && hasCfClearance && hasCfBm;
  const loginValid = USE_LOGIN_PROFILE ? loginTokenValid : detailAccessValid;
  const expiresAt = activeCookies
    .map((cookie) => Number(cookie.expires || 0))
    .filter((expires) => expires > 0)
    .sort((a, b) => a - b)[0];
  const detailSecurityExpiresAt = activeDetailSecurityCookies
    .map((cookie) => Number(cookie.expires || 0))
    .filter((expires) => expires > 0)
    .sort((a, b) => a - b)[0];

  let reason = '';
  if (!loginTokenValid) {
    reason = '신라 로그인 토큰이 없거나 만료되었습니다.';
  } else if (!detailAccessValid) {
    reason = USE_LOGIN_PROFILE
      ? '로컬 Chrome 프로필로 상품 상세페이지 보안 확인을 다시 확인합니다.'
      : '상품 상세페이지 보안 세션이 없거나 만료되었습니다. npm run capture:login으로 다시 캡처해 주세요.';
  }

  const sessionInfo = {
    loginAvailable: true,
    loginTokenValid,
    loginValid,
    detailAccessValid,
    needsLogin: !detailAccessValid,
    accountLabel: LOGIN_LABEL || '로그인 세션',
    expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : '',
    detailSecurityExpiresAt: detailAccessValid && detailSecurityExpiresAt ? new Date(detailSecurityExpiresAt * 1000).toISOString() : '',
    reason,
  };

  return probe ? probeLoginSessionAccess(sessionInfo) : sessionInfo;
}

async function createMobileContext(browser, { useLogin = false } = {}) {
  if (useLogin && USE_LOGIN_PROFILE) {
    return getLoginPersistentContext();
  }

  const device = devices['iPhone 13'] || {};
  const targetBrowser = browser || (await getBrowser());
  const storageState = useLogin ? getLoginStorageState() : null;
  const context = await targetBrowser.newContext({
    ...device,
    ...(storageState ? { storageState } : {}),
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

async function closeMobileContext(context) {
  if (USE_LOGIN_PROFILE && context === loginPersistentContext) return;
  await context.close().catch(() => {});
}

function extractSku(value) {
  const text = String(value || '');
  const skuLabelMatch = text.match(/(?:sku|스큐|상품sku|상품\s*sku)\D{0,12}(\d{12})/i);
  if (skuLabelMatch?.[1]) return skuLabelMatch[1];

  const numericMatch = text.match(/\b\d{12}\b/);
  return numericMatch?.[0] || '';
}

function brandCodeFromSku(sku) {
  const digits = String(sku || '').replace(/\D/g, '');
  return digits.length === 12 ? digits.slice(0, 4) : '';
}

function isRealSku(value) {
  return /^\d{12}$/.test(String(value || '').replace(/\D/g, ''));
}

function normalizeSkuCandidate(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return isRealSku(digits) ? digits : '';
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
    shillaDiscountRate: _shillaDiscountRate,
    shillaRewardRate: _shillaRewardRate,
    shillaSPoint: _shillaSPoint,
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

function normalizeFallbackItem(item = {}) {
  if (!item || typeof item !== 'object') return {};
  return {
    productCode: String(item.productCode || '').trim(),
    productName: String(item.productName || '').trim(),
    brand: String(item.brand || '').trim(),
    productSku: String(item.productSku || '').trim(),
    productUrl: String(item.productUrl || '').trim(),
    discountRate: String(item.discountRate || item.productDiscount || '').trim(),
    salePrice: String(item.salePrice || item.maxBenefitPrice || '').trim(),
  };
}

function hasVisibleProductData(row = {}) {
  return Boolean(
    row.productName ||
      row.brand ||
      row.productSku ||
      row.maxBenefitPrice ||
      row.productDiscount ||
      row.dailyCoupon ||
      row.rewardAmount ||
      row.sPointBenefit ||
      row.otherBenefits,
  );
}

function mergeBenefitRowWithFallback(row = {}, item = {}, { inputSku = '', loginApplied = false } = {}) {
  const normalizedSku = normalizeSkuCandidate(row.productSku) || normalizeSkuCandidate(item.productSku) || normalizeSkuCandidate(inputSku);
  const merged = {
    ...row,
    brandCode: brandCodeFromSku(normalizedSku),
    brand: row.brand || item.brand || '',
    productName: row.productName || item.productName || '',
    productSku: normalizedSku,
    productUrl: row.productUrl || item.productUrl || '',
    productDiscount: row.productDiscount || '',
    benefitBreakdown: row.benefitBreakdown || {},
  };

  const hasDetailValues = Boolean(
    row.maxBenefitPrice ||
      row.productSku ||
      row.productDiscount ||
      row.dailyCoupon ||
      row.rewardAmount ||
      row.sPointBenefit ||
      row.otherBenefits ||
      Object.keys(row.benefitBreakdown || {}).length > 0,
  );

  if (!hasDetailValues && loginApplied && merged.productUrl) {
    merged.benefitBasis = row.benefitBasis === '상세 보안 차단' ? row.benefitBasis : '상세 정보 추출 실패';
  }

  return merged;
}

async function clickDetailControls(page, patternSource, { limit = 8 } = {}) {
  return page
    .evaluate(
      ({ patternSource: source, limit: maxClicks }) => {
        const pattern = new RegExp(source, 'i');
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const blocked = /(장바구니|바로구매|구매하기|결제|주문|삭제|취소)/;
        const isVisible = (node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const closestControl = (node) =>
          node.closest('button, a, [role="button"], summary, [onclick], .btn, .button') || node;
        const candidates = Array.from(
          document.querySelectorAll('button, a, [role="button"], summary, [onclick], .btn, .button, dt, dd, li, span, div'),
        )
          .map((node) => {
            const text = clean([node.textContent, node.getAttribute?.('aria-label'), node.getAttribute?.('title')].join(' '));
            return { node, text, control: closestControl(node) };
          })
          .filter(({ node, text, control }) => text && pattern.test(text) && !blocked.test(text) && isVisible(node) && isVisible(control));

        const clicked = [];
        const seen = new Set();
        for (const { control, text } of candidates) {
          if (clicked.length >= maxClicks) break;
          if (seen.has(control)) continue;
          seen.add(control);
          try {
            control.click();
            clicked.push(text.slice(0, 80));
          } catch {
            // Keep trying other visible controls.
          }
        }
        return clicked;
      },
      { patternSource, limit },
    )
    .catch(() => []);
}

async function prepareProductDetailForBenefits(page) {
  const interaction = {
    benefitDetailClicks: [],
    couponDownloadClicks: [],
  };

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await clickDetailControls(page, '최대\\s*혜택가|최대\\s*혜택|혜택\\s*(상세|보기|내역|계산)|할인\\s*(상세|보기|내역)|계산\\s*내역|상세\\s*혜택', {
      limit: 6,
    });
    interaction.benefitDetailClicks.push(...clicked);
    if (!clicked.length) break;
    await page.waitForTimeout(500);
  }

  await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.35))).catch(() => {});
  await page.waitForTimeout(300);

  const couponClicks = await clickDetailControls(
    page,
    '쿠폰\\s*(받기|다운|다운로드)|다운로드\\s*쿠폰|쿠폰\\s*다운로드|받을\\s*수\\s*있는\\s*쿠폰|적용\\s*가능\\s*쿠폰',
    { limit: 8 },
  );
  interaction.couponDownloadClicks.push(...couponClicks);
  if (couponClicks.length) {
    await page.waitForTimeout(800);
  }

  return interaction;
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
  let effectiveQuery = query;
  let effectiveSearchUrl = searchUrl;
  const page = await context.newPage();

  try {
    page.setDefaultTimeout(30000);
    await gotoAndContinue(page, searchUrl, { timeout: 25000 });
    await settleSearchPage(page, maxResults);

    const extractCurrentPage = () => page.evaluate(
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
            getDataset(
              card,
              ['button[data-productcode]', '[data-productcode]', 'a.content_link[data-code]', '.pro_img[data-code]'],
              'productcode',
            ) ||
            getDataset(card, ['a.content_link[data-code]', '.pro_img[data-code]'], 'code') ||
            (card.id || '').match(/[0-9]+/)?.[0] ||
            '';

          const href = firstAttr(card, ['a.content_link[href*="/p/"], a[href*="/p/"]'], 'href');
          const attrText = Array.from(card.querySelectorAll('*'))
            .flatMap((node) =>
              Array.from(node.attributes || []).map((attr) => `${attr.name}=${attr.value}`),
            )
            .join(' ');
          const productSku = skuFromImage(`${attrText} ${clean(card.textContent)}`);
          const productUrl = absoluteProductUrl(href, code);
          const dedupeKey = productUrl || code;
          if (!dedupeKey || seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          const productName =
            firstText(card, [
              '.product_summary .proname',
              '.proname',
              '.info_name',
              'p.info_name',
              '.product_txt .tit span',
              '.product_info .name',
            ]) ||
            getDataset(card, ['button[data-productname]', '[data-productname]'], 'productname') ||
            firstAttr(card, ['img[alt]', '[title]', '[aria-label]'], 'alt') ||
            firstAttr(card, ['[title]'], 'title') ||
            firstAttr(card, ['[aria-label]'], 'aria-label');
          const brand =
            firstText(card, ['.short_brand .name', '.info_brand', 'strong.info_brand', '.product_txt .tit strong', '.brand']) ||
            getDataset(card, ['button[data-brandname]', '[data-brandname]'], 'brandname');

          const guestPrice = priceFrom(card.querySelector('.proprice .disprice, .price .sale'));
          const salePrice = priceFrom(card.querySelector('.proprice .setprice, .price .regular, .info_price .p_sum'));
          const dataPriceUsd = getDataset(card, ['button[data-priceusd]', '[data-priceusd]'], 'priceusd');
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

    let extracted = await extractCurrentPage();
    const redirectedBrandSlug = brandSlugFromUrl(page.url());
    if (extracted.items.length === 0 && input.inputType === 'keyword' && redirectedBrandSlug) {
      const retryQuery = redirectedBrandSlug.trim();
      if (retryQuery && retryQuery.toLowerCase() !== query.toLowerCase()) {
        effectiveQuery = retryQuery;
        effectiveSearchUrl = buildSearchUrl(retryQuery);
        await gotoAndContinue(page, effectiveSearchUrl, { timeout: 25000 });
        await settleSearchPage(page, maxResults);
        extracted = await extractCurrentPage();
      }
    }

    if (extracted.items.length === 0 && input.inputType === 'keyword' && input.aliasVariants?.length > 1) {
      for (const retryQuery of input.aliasVariants.slice(1)) {
        if (!retryQuery || retryQuery.toLowerCase() === effectiveQuery.toLowerCase()) continue;
        effectiveQuery = retryQuery;
        effectiveSearchUrl = buildSearchUrl(retryQuery);
        await gotoAndContinue(page, effectiveSearchUrl, { timeout: 25000 });
        await settleSearchPage(page, maxResults);
        extracted = await extractCurrentPage();
        if (extracted.items.length > 0) break;
      }
    }

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
      normalizedQuery: effectiveQuery,
      inputType: input.inputType,
      searchUrl: effectiveSearchUrl,
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
    await closeMobileContext(context);
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
      maxBenefitPrice: '',
      productDiscount: item.discountRate || '',
      dailyCoupon: '',
      rewardAmount: '',
      sPointBenefit: '',
      otherBenefits: '',
      benefitBreakdown: item.discountRate ? { '상품 할인': item.discountRate } : {},
      benefitBasis: loginApplied ? '로그인 세션 사용' : '비회원',
      benefitDetailsText: '',
      benefitText: '',
      productUrl: '',
    };
  }

  const page = await context.newPage();
  page.on('dialog', async (dialog) => {
    await dialog.accept().catch(() => {});
  });

  try {
    page.setDefaultTimeout(30000);
    await gotoAndContinue(page, productUrl, { timeout: 25000 });
    await page.waitForSelector('body', { timeout: 8000 }).catch(() => {});
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const isSecurityCheck = await page
        .evaluate(() =>
          /보안 확인|잠시만 기다리십시오|cloudflare|verify you are human|just a moment|enable javascript and cookies|challenge-platform|cf_chl/i.test(
            `${document.body?.innerText || ''} ${document.title || ''} ${document.documentElement?.innerHTML || ''}`,
          ),
        )
        .catch(() => false);
      if (!isSecurityCheck) break;
      await page.waitForTimeout(1500);
    }

    const blockedBySecurity = await page
      .evaluate(() =>
        /보안 확인|잠시만 기다리십시오|cloudflare|verify you are human|just a moment|enable javascript and cookies|challenge-platform|cf_chl/i.test(
          `${document.body?.innerText || ''} ${document.title || ''} ${document.documentElement?.innerHTML || ''}`,
        ),
      )
      .catch(() => false);

    let detailInteraction = { benefitDetailClicks: [], couponDownloadClicks: [] };
    if (!blockedBySecurity) {
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(600);
      detailInteraction = await prepareProductDetailForBenefits(page);
    }

    const detail = await page.evaluate(
      ({ fallback, interaction }) => {
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

        const moneyOrRatePattern = /(?:-?\$ ?[\d,.]+|-?[\d,]+원|-?[\d,]+P|\d+(?:\.\d+)?\s*%)/i;
        const moneyPattern = /(?:\$ ?[\d,.]+(?:\s*\/\s*[\d,]+원)?|[\d,]+원)/i;
        const valueForLine = (labels, pattern = moneyOrRatePattern, size = 6) => valueNear(labels, pattern, size);
        const indexOfAny = (labels) => {
          const keys = labels.map(compactKey);
          return lines.findIndex((line) => {
            const key = compactKey(line);
            return keys.some((label) => key.includes(label));
          });
        };
        const compactBlock = (startLabels, stopPattern, maxLines = 24) => {
          const startIndex = indexOfAny(startLabels);
          if (startIndex < 0) return '';
          const block = [];
          for (const line of lines.slice(startIndex, startIndex + maxLines)) {
            if (block.length > 0 && stopPattern.test(line)) break;
            block.push(line);
          }
          return block.join(' | ');
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
        const isSecurityCheck =
          /보안 확인|잠시만 기다리십시오|cloudflare|verify you are human|just a moment|enable javascript and cookies|challenge-platform|cf_chl/i.test(
            `${bodyText} ${document.title || ''} ${document.documentElement?.innerHTML || ''}`,
          );
        const productNameCandidate =
          firstText([
            '.product_name',
            '.product_summary .proname',
            '.proname',
            '.goods_name',
            '.info_name',
            'p.info_name',
          ]) ||
          firstAttr(['[data-productname]'], 'data-productname') ||
          clean(jsonLd.name);
        const invalidProductName =
          !productNameCandidate || /shilladfs|신라면세점|javascript/i.test(productNameCandidate);
        const productName = invalidProductName ? fallback.productName : productNameCandidate;
        const brandCandidate =
          firstText(['.brand_name', '.short_brand .name', '.info_brand', 'strong.info_brand', '.brand', '.product_brand']) ||
          firstAttr(['[data-brandname]'], 'data-brandname') ||
          clean(jsonLd.brand?.name || jsonLd.brand);
        const brand = brandCandidate || fallback.brand;

        const validSku = (value) => {
          const digits = String(value || '').replace(/\D/g, '');
          return /^\d{12}$/.test(digits) ? digits : '';
        };
        const skuWindow = valueNear(['SKU', '상품SKU', '상품 SKU', '스큐'], /\d{12}/, 3);
        const detailSku =
          validSku(skuWindow.match(/\d{12}/)?.[0]) ||
          validSku(skuFromImages()) ||
          validSku(firstAttr(['[data-sku]', '[data-productsku]'], 'data-sku')) ||
          validSku(firstAttr(['[data-productsku]'], 'data-productsku'));
        const productSku = detailSku || validSku(fallback.productSku);

        const maxBenefitBlock = compactBlock(
          ['최대혜택가', '최대 혜택가'],
          /(수량|장바구니|바로구매|구매하기|상품정보|상품 정보|상품상세|상품 상세|리뷰|고시정보|배송|교환|환불|추천상품)/i,
          80,
        );
        const benefitLines = (maxBenefitBlock ? maxBenefitBlock.split('|').map(clean) : lines)
          .filter((line) => /(신라|적립|포인트|s\s*point|s포인트|할인|쿠폰|혜택)/i.test(line))
          .slice(0, 40)
          .join(' | ');
        const ratePattern = /\d+(?:\.\d+)?\s*%/i;
        const valueForLinePreferRate = (labels, size = 8) =>
          valueForLine(labels, ratePattern, size) || valueForLine(labels, moneyOrRatePattern, size);
        const maxBenefitPrice = valueForLine(['최대혜택가', '최대 혜택가'], moneyPattern, 12);
        const productDiscount = valueForLinePreferRate(['상품 할인', '상품할인', '신라할인', '신라 할인', '할인'], 12);
        const dailyCoupon = valueForLinePreferRate(['데일리 쿠폰', '데일리쿠폰', '쿠폰'], 12);
        const rewardAmount = valueForLine(['적립금', '신라적립', '신라 적립', '적립'], moneyOrRatePattern, 12);
        const sPointBenefit = valueForLine(['신라S포인트', '신라 S포인트', 'S포인트', 'S-POINT', 'S POINT', 'S.Point'], moneyOrRatePattern, 12);
        const knownBenefitLabels =
          /(최대혜택가|최대 혜택가|상품\s*할인|상품할인|신라\s*할인|신라할인|회원\s*할인|즉시\s*할인|데일리\s*쿠폰|데일리쿠폰|브랜드\s*쿠폰|상품\s*쿠폰|장바구니\s*쿠폰|카드\s*할인|결제\s*할인|적립금|신라\s*적립|신라적립|S\s*포인트|S포인트|S-?POINT|S POINT)/i;
        const otherBenefits = (maxBenefitBlock ? maxBenefitBlock.split('|').map(clean) : [])
          .filter((line) => /(할인|쿠폰|적립|포인트|혜택)/i.test(line) && !knownBenefitLabels.test(line))
          .slice(0, 12)
          .join(' | ');
        const benefitBreakdown = {};
        const addBenefit = (label, value) => {
          const normalizedLabel = clean(label);
          const normalizedValue = clean(value);
          if (!normalizedLabel || !normalizedValue) return;
          if (!benefitBreakdown[normalizedLabel]) {
            benefitBreakdown[normalizedLabel] = normalizedValue;
          }
        };
        const valueInText = (text, { preferRate = false } = {}) => {
          const source = String(text || '');
          if (preferRate) {
            const rate = source.match(ratePattern)?.[0];
            if (rate) return clean(rate);
          }
          return clean(source.match(moneyOrRatePattern)?.[0] || '');
        };
        const followingValue = (index, options = {}) => {
          for (const line of (maxBenefitBlock ? maxBenefitBlock.split('|').map(clean) : lines).slice(index + 1, index + 5)) {
            const value = valueInText(line, options);
            if (value) return value;
          }
          return '';
        };
        const benefitSourceLines = maxBenefitBlock ? maxBenefitBlock.split('|').map(clean).filter(Boolean) : lines;
        const benefitLabelMatchers = [
          ['상품 할인', /상품\s*할인|상품할인|신라\s*할인|신라할인|회원\s*할인|즉시\s*할인/i],
          ['데일리 쿠폰', /데일리\s*쿠폰|데일리쿠폰/i],
          ['브랜드 쿠폰', /브랜드\s*쿠폰|브랜드쿠폰/i],
          ['상품 쿠폰', /상품\s*쿠폰|상품쿠폰/i],
          ['장바구니 쿠폰', /장바구니\s*쿠폰|장바구니쿠폰/i],
          ['카드 할인', /카드\s*할인|결제\s*할인/i],
          ['적립금', /적립금|신라\s*적립|신라적립/i],
          ['S포인트', /S\s*포인트|S-?POINT|S POINT|S\.Point|S포인트/i],
        ];
        benefitSourceLines.forEach((line, index) => {
          for (const [label, matcher] of benefitLabelMatchers) {
            if (!matcher.test(line)) continue;
            const preferRate = /할인|쿠폰/.test(label);
            addBenefit(label, valueInText(line.replace(matcher, ''), { preferRate }) || followingValue(index, { preferRate }));
            break;
          }
        });
        benefitSourceLines.forEach((line, index) => {
          if (!/(할인|쿠폰|적립|포인트|혜택)/i.test(line) || knownBenefitLabels.test(line) || /최대\s*혜택가/i.test(line)) {
            return;
          }
          const value = valueInText(line, { preferRate: /할인|쿠폰/.test(line) }) || followingValue(index, { preferRate: /할인|쿠폰/.test(line) });
          const label = clean(line.replace(moneyOrRatePattern, '').replace(/[:：\-]+$/g, '')).slice(0, 30);
          addBenefit(label, value);
        });
        if (productDiscount) addBenefit('상품 할인', productDiscount);
        if (dailyCoupon) addBenefit('데일리 쿠폰', dailyCoupon);
        if (rewardAmount) addBenefit('적립금', rewardAmount);
        if (sPointBenefit) addBenefit('S포인트', sPointBenefit);
        const couponDownloadText = (interaction?.couponDownloadClicks || []).filter(Boolean).join(' | ');
        if (couponDownloadText) addBenefit('쿠폰 다운로드', couponDownloadText);
        const detailReadOk = Boolean(
          !isSecurityCheck &&
            (productNameCandidate ||
              brandCandidate ||
              detailSku ||
              maxBenefitPrice ||
              Object.keys(benefitBreakdown).length > 0),
        );
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
          maxBenefitPrice,
          productDiscount,
          dailyCoupon,
          rewardAmount,
          sPointBenefit,
          otherBenefits,
          benefitBreakdown,
          couponDownloadText,
          detailReadOk,
          membershipBasis,
          benefitDetailsText: isSecurityCheck
            ? '상세 페이지가 보안 확인 화면으로 전환되어 정확한 혜택을 읽지 못했습니다.'
            : maxBenefitBlock,
          benefitText: isSecurityCheck ? '' : benefitLines,
          isSecurityCheck,
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
        interaction: detailInteraction,
      },
    );

    const productSku = normalizeSkuCandidate(detail.productSku) || normalizeSkuCandidate(fallbackSku);
    const normalizedSku = productSku;
    const benefitBreakdown = detail.benefitBreakdown || {};
    const hasDetailValues = Boolean(
      detail.detailReadOk ||
        detail.maxBenefitPrice ||
        detail.productDiscount ||
        detail.dailyCoupon ||
        detail.rewardAmount ||
        detail.sPointBenefit ||
        detail.otherBenefits ||
        Object.keys(benefitBreakdown).length > 0,
    );

    return {
      sourceQuery: inputQuery,
      brandCode: brandCodeFromSku(normalizedSku),
      brand: detail.brand || item.brand || '',
      productName: detail.productName || item.productName || '',
      productSku: normalizedSku,
      productCode: item.productCode || '',
      salePrice: item.salePrice || '',
      maxBenefitPrice: detail.maxBenefitPrice || '',
      productDiscount: detail.productDiscount || item.discountRate || '',
      dailyCoupon: detail.dailyCoupon || '',
      rewardAmount: detail.rewardAmount || '',
      sPointBenefit: detail.sPointBenefit || '',
      otherBenefits: detail.otherBenefits || '',
      benefitBreakdown,
      benefitBasis:
        detail.membershipBasis ||
        (detail.isSecurityCheck
          ? loginApplied
            ? '상세 보안 차단'
            : '비회원(상세 보안차단)'
          : loginApplied && hasDetailValues
            ? '로그인 세션 사용'
            : loginApplied
              ? '상세 정보 추출 실패'
              : '비회원'),
      benefitDetailsText: detail.benefitDetailsText || '',
      benefitText: detail.benefitText || '',
      productUrl: detail.finalUrl || productUrl,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeBenefitRows(keyword, maxResults = DEFAULT_BENEFIT_MAX_RESULTS, fallbackItem = {}) {
  const sessionInfo = await getLoginSessionInfo();
  const loginApplied = sessionInfo.loginValid;
  const browser = loginApplied && USE_LOGIN_PROFILE ? null : await getBrowser();
  const context = await createMobileContext(browser, { useLogin: loginApplied });
  const inputSku = extractSku(keyword);
  const normalizedInput = normalizeSearchInput(keyword);
  const fallback = normalizeFallbackItem(fallbackItem);

  try {
    if (normalizedInput.inputType === 'productUrl') {
      const productUrl = `${SHILLA_ORIGIN}/estore/kr/ko/p/${normalizedInput.query}`;
      const row = await scrapeProductBenefits(
        context,
        {
          productCode: normalizedInput.query,
          productUrl,
          productName: fallback.productName || '',
          brand: fallback.brand || '',
          productSku: fallback.productSku || '',
          discountRate: fallback.discountRate || '',
          salePrice: fallback.salePrice || '',
        },
        { inputQuery: keyword, inputSku, loginApplied },
      );

      if (hasVisibleProductData(row)) {
        return {
          query: keyword,
          loginApplied,
          accountLabel: sessionInfo.accountLabel,
          needsLogin: sessionInfo.needsLogin,
          loginReason: sessionInfo.reason,
          searchUrl: productUrl,
          finalUrl: row.productUrl || productUrl,
          retrievedAt: new Date().toISOString(),
          count: 1,
          items: [row],
        };
      }
    }

    let search = await scrapeShillaInContext(context, keyword, maxResults);
    if (loginApplied && search.items.length === 0) {
      const guestSearchContext = await createMobileContext(browser || (await getBrowser()));
      try {
        search = await scrapeShillaInContext(guestSearchContext, keyword, maxResults);
      } finally {
        await closeMobileContext(guestSearchContext);
      }
    }

    const items = search.items.slice(0, maxResults);

    if (!items.length) {
      return {
        query: keyword,
        loginApplied,
        accountLabel: sessionInfo.accountLabel,
        needsLogin: sessionInfo.needsLogin,
        loginReason: sessionInfo.reason,
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
            benefitBreakdown: {},
            benefitBasis: loginApplied ? '로그인 세션 사용' : '비회원',
            benefitText: '',
            productUrl: '',
          },
        ],
      };
    }

    const rows = [];
    for (const item of items) {
      const row = await scrapeProductBenefits(context, item, { inputQuery: keyword, inputSku, loginApplied });
      rows.push(mergeBenefitRowWithFallback(row, item, { inputSku, loginApplied }));
    }

    return {
      query: keyword,
      loginApplied,
      accountLabel: sessionInfo.accountLabel,
      needsLogin: sessionInfo.needsLogin,
      loginReason: sessionInfo.reason,
      searchUrl: search.searchUrl,
      finalUrl: search.finalUrl,
      retrievedAt: new Date().toISOString(),
      count: rows.length,
      items: rows,
    };
  } finally {
    await closeMobileContext(context);
  }
}

const STATIC_ASSETS = new Map([
  ["/", { type: "text/html; charset=utf-8", body: "<!doctype html>\n<html lang=\"ko\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>신라면세점 모바일 상품/혜택 조회</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\" />\n  </head>\n  <body>\n    <main class=\"app\">\n      <section class=\"search-panel\">\n        <div>\n          <h1>신라면세점 모바일 상품/혜택 조회</h1>\n          <p class=\"subtle\">상품명, SKU, 신라 상품 URL을 입력하면 모바일 검색 결과에서 상품 정보를 추출합니다.</p>\n        </div>\n\n        <form id=\"searchForm\" class=\"search-form\">\n          <input\n            id=\"query\"\n            name=\"query\"\n            type=\"search\"\n            autocomplete=\"off\"\n            placeholder=\"예: 라네즈, 5745177, https://m.shilladfs.com/.../p/5786502\"\n            aria-label=\"상품명, SKU, 신라 상품 URL\"\n            required\n          />\n          <button id=\"searchButton\" type=\"submit\">검색</button>\n        </form>\n      </section>\n\n      <section class=\"upload-panel\">\n        <div>\n          <h2>엑셀 일괄 조회</h2>\n          <p class=\"subtle\">파일의 입력값 열에 브랜드명, SKU, 상품 URL을 한 줄에 하나씩 넣으면 됩니다.</p>\n        </div>\n        <div class=\"upload-controls\">\n          <input id=\"batchFile\" type=\"file\" accept=\".xlsx,.xls,.csv,.tsv,.txt\" />\n          <button id=\"templateButton\" class=\"secondary-button\" type=\"button\">엑셀 양식 다운로드</button>\n          <button id=\"benefitsButton\" type=\"button\">파일 일괄 조회</button>\n        </div>\n        <div id=\"batchFileInfo\" class=\"file-info\" aria-live=\"polite\">선택된 파일이 없습니다.</div>\n      </section>\n\n      <section class=\"status-panel\" aria-live=\"polite\">\n        <div id=\"statusText\">검색어를 입력하세요.</div>\n        <div class=\"status-actions\">\n          <button id=\"downloadButton\" class=\"secondary-button\" type=\"button\" hidden>엑셀 다운로드</button>\n          <a id=\"sourceLink\" class=\"source-link\" href=\"#\" target=\"_blank\" rel=\"noreferrer\" hidden>검색 결과 페이지 열기</a>\n        </div>\n      </section>\n\n      <section class=\"table-wrap\">\n        <table>\n          <thead id=\"resultsHead\">\n            <tr>\n              <th>입력값</th>\n              <th>브랜드코드</th>\n              <th>브랜드</th>\n              <th>상품명</th>\n              <th>상품SKU</th>\n              <th>최대혜택가</th>\n              <th>조회기준</th>\n              <th>상품 URL</th>\n            </tr>\n          </thead>\n          <tbody id=\"resultsBody\">\n            <tr class=\"empty-row\">\n              <td colspan=\"8\">아직 조회한 결과가 없습니다.</td>\n            </tr>\n          </tbody>\n        </table>\n      </section>\n    </main>\n\n    <script src=\"https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\"></script>\n    <script src=\"/app.js\" type=\"module\"></script>\n  </body>\n</html>\n" }],
  ["/index.html", { type: "text/html; charset=utf-8", body: "<!doctype html>\n<html lang=\"ko\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>신라면세점 모바일 상품/혜택 조회</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\" />\n  </head>\n  <body>\n    <main class=\"app\">\n      <section class=\"search-panel\">\n        <div>\n          <h1>신라면세점 모바일 상품/혜택 조회</h1>\n          <p class=\"subtle\">상품명, SKU, 신라 상품 URL을 입력하면 모바일 검색 결과에서 상품 정보를 추출합니다.</p>\n        </div>\n\n        <form id=\"searchForm\" class=\"search-form\">\n          <input\n            id=\"query\"\n            name=\"query\"\n            type=\"search\"\n            autocomplete=\"off\"\n            placeholder=\"예: 라네즈, 5745177, https://m.shilladfs.com/.../p/5786502\"\n            aria-label=\"상품명, SKU, 신라 상품 URL\"\n            required\n          />\n          <button id=\"searchButton\" type=\"submit\">검색</button>\n        </form>\n      </section>\n\n      <section class=\"upload-panel\">\n        <div>\n          <h2>엑셀 일괄 조회</h2>\n          <p class=\"subtle\">파일의 입력값 열에 브랜드명, SKU, 상품 URL을 한 줄에 하나씩 넣으면 됩니다.</p>\n        </div>\n        <div class=\"upload-controls\">\n          <input id=\"batchFile\" type=\"file\" accept=\".xlsx,.xls,.csv,.tsv,.txt\" />\n          <button id=\"templateButton\" class=\"secondary-button\" type=\"button\">엑셀 양식 다운로드</button>\n          <button id=\"benefitsButton\" type=\"button\">파일 일괄 조회</button>\n        </div>\n        <div id=\"batchFileInfo\" class=\"file-info\" aria-live=\"polite\">선택된 파일이 없습니다.</div>\n      </section>\n\n      <section class=\"status-panel\" aria-live=\"polite\">\n        <div id=\"statusText\">검색어를 입력하세요.</div>\n        <div class=\"status-actions\">\n          <button id=\"downloadButton\" class=\"secondary-button\" type=\"button\" hidden>엑셀 다운로드</button>\n          <a id=\"sourceLink\" class=\"source-link\" href=\"#\" target=\"_blank\" rel=\"noreferrer\" hidden>검색 결과 페이지 열기</a>\n        </div>\n      </section>\n\n      <section class=\"table-wrap\">\n        <table>\n          <thead id=\"resultsHead\">\n            <tr>\n              <th>입력값</th>\n              <th>브랜드코드</th>\n              <th>브랜드</th>\n              <th>상품명</th>\n              <th>상품SKU</th>\n              <th>최대혜택가</th>\n              <th>조회기준</th>\n              <th>상품 URL</th>\n            </tr>\n          </thead>\n          <tbody id=\"resultsBody\">\n            <tr class=\"empty-row\">\n              <td colspan=\"8\">아직 조회한 결과가 없습니다.</td>\n            </tr>\n          </tbody>\n        </table>\n      </section>\n    </main>\n\n    <script src=\"https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\"></script>\n    <script src=\"/app.js\" type=\"module\"></script>\n  </body>\n</html>\n" }],
  ["/styles.css", { type: "text/css; charset=utf-8", body: ":root {\n  color-scheme: light;\n  --bg: #f6f7f9;\n  --panel: #ffffff;\n  --text: #1c1d1f;\n  --muted: #6b7280;\n  --line: #d9dde3;\n  --accent: #111827;\n  --accent-hover: #303846;\n  --error: #b42318;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  background: var(--bg);\n  color: var(--text);\n  font-family:\n    system-ui,\n    -apple-system,\n    BlinkMacSystemFont,\n    \"Segoe UI\",\n    sans-serif;\n}\n\n.app {\n  width: min(1180px, calc(100% - 32px));\n  margin: 32px auto;\n}\n\n.search-panel,\n.upload-panel,\n.status-panel,\n.table-wrap {\n  background: var(--panel);\n  border: 1px solid var(--line);\n  border-radius: 8px;\n}\n\n.search-panel {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(320px, 520px);\n  gap: 24px;\n  align-items: end;\n  padding: 24px;\n}\n\n.upload-panel {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(320px, 520px);\n  gap: 24px;\n  align-items: end;\n  margin-top: 16px;\n  padding: 20px 24px;\n}\n\nh1 {\n  margin: 0 0 8px;\n  font-size: 24px;\n  line-height: 1.25;\n}\n\nh2 {\n  margin: 0 0 8px;\n  font-size: 18px;\n  line-height: 1.3;\n}\n\n.subtle {\n  margin: 0;\n  color: var(--muted);\n  line-height: 1.5;\n}\n\n.search-form {\n  display: flex;\n  gap: 10px;\n}\n\n.upload-controls {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) repeat(2, auto);\n  gap: 10px;\n}\n\n.file-info {\n  grid-column: 1 / -1;\n  padding: 10px 12px;\n  border: 1px solid var(--line);\n  border-radius: 6px;\n  background: #f9fafb;\n  color: var(--muted);\n  font-size: 14px;\n  line-height: 1.45;\n  word-break: break-all;\n}\n\ninput,\nbutton {\n  height: 44px;\n  border-radius: 6px;\n  font: inherit;\n}\n\ninput {\n  width: 100%;\n  border: 1px solid var(--line);\n  padding: 0 12px;\n  background: #fff;\n}\n\ninput[type='file'] {\n  padding: 10px 12px;\n}\n\ninput:focus {\n  outline: 2px solid #9ca3af;\n  outline-offset: 1px;\n}\n\nbutton {\n  min-width: 96px;\n  border: 0;\n  background: var(--accent);\n  color: #fff;\n  cursor: pointer;\n  font-weight: 700;\n}\n\nbutton:hover:not(:disabled) {\n  background: var(--accent-hover);\n}\n\nbutton:disabled {\n  cursor: wait;\n  opacity: 0.65;\n}\n\n.status-panel {\n  display: flex;\n  justify-content: space-between;\n  gap: 16px;\n  align-items: center;\n  margin: 16px 0;\n  padding: 14px 16px;\n  color: var(--muted);\n}\n\n.status-panel.error {\n  color: var(--error);\n}\n\n.source-link {\n  color: var(--accent);\n  font-weight: 700;\n  white-space: nowrap;\n}\n\n.status-actions {\n  display: flex;\n  gap: 10px;\n  align-items: center;\n}\n\n.secondary-button {\n  min-width: auto;\n  height: 34px;\n  padding: 0 12px;\n  border: 1px solid var(--line);\n  background: #fff;\n  color: var(--accent);\n}\n\n.secondary-button:hover:not(:disabled) {\n  background: #f3f4f6;\n}\n\n.upload-controls .secondary-button {\n  height: 44px;\n}\n\n.table-wrap {\n  overflow-x: auto;\n}\n\ntable {\n  width: 100%;\n  border-collapse: collapse;\n  min-width: 2180px;\n}\n\nth,\ntd {\n  padding: 14px 12px;\n  border-bottom: 1px solid var(--line);\n  text-align: left;\n  vertical-align: top;\n  line-height: 1.45;\n}\n\nth {\n  position: sticky;\n  top: 0;\n  background: #f9fafb;\n  color: #374151;\n  font-size: 13px;\n  white-space: nowrap;\n}\n\ntd {\n  font-size: 14px;\n}\n\n.product-name {\n  min-width: 260px;\n  font-weight: 700;\n}\n\n.source-query {\n  min-width: 180px;\n  max-width: 260px;\n  word-break: break-all;\n}\n\n.price {\n  white-space: nowrap;\n}\n\n.url-cell {\n  max-width: 320px;\n  word-break: break-all;\n}\n\n.url-cell a {\n  color: #1f4f99;\n}\n\n.empty-row td {\n  padding: 36px 12px;\n  color: var(--muted);\n  text-align: center;\n}\n\n@media (max-width: 760px) {\n  .app {\n    width: min(100% - 20px, 1180px);\n    margin: 16px auto;\n  }\n\n  .search-panel {\n    grid-template-columns: 1fr;\n    padding: 18px;\n  }\n\n  .upload-panel,\n  .upload-controls {\n    grid-template-columns: 1fr;\n  }\n\n  .search-form,\n  .status-panel {\n    flex-direction: column;\n    align-items: stretch;\n  }\n\n  button {\n    width: 100%;\n  }\n}\n" }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: "const form = document.querySelector('#searchForm');\nconst queryInput = document.querySelector('#query');\nconst button = document.querySelector('#searchButton');\nconst statusPanel = document.querySelector('.status-panel');\nconst statusText = document.querySelector('#statusText');\nconst sourceLink = document.querySelector('#sourceLink');\nconst resultsHead = document.querySelector('#resultsHead');\nconst resultsBody = document.querySelector('#resultsBody');\nconst batchFileInput = document.querySelector('#batchFile');\nconst batchFileInfo = document.querySelector('#batchFileInfo');\nconst benefitsButton = document.querySelector('#benefitsButton');\nconst templateButton = document.querySelector('#templateButton');\nconst downloadButton = document.querySelector('#downloadButton');\n\nconst BATCH_MAX_RESULTS_PER_QUERY = 60;\nconst SINGLE_BENEFIT_MAX_RESULTS = 60;\nconst BATCH_BENEFIT_MAX_RESULTS_PER_QUERY = 60;\nconst BATCH_MAX_QUERIES = 200;\nconst DETAIL_LOOKUP_CONCURRENCY = 1;\nconst SEARCH_RESULT_BASIS = '비로그인 검색';\nconst BASE_RESULT_HEADERS = ['입력값', '브랜드코드', '브랜드', '상품명', '상품SKU', '최대혜택가'];\nconst TRAILING_RESULT_HEADERS = ['조회기준', '상품 URL'];\nconst TEMPLATE_ROWS = [\n  ['입력값'],\n  ['라네즈'],\n  ['102467200030'],\n  ['https://m.shilladfs.com/estore/kr/ko/p/5786502?isSavedId=true'],\n];\nlet latestRows = [];\nlet loginSession = { loginAvailable: false, loginValid: false, accountLabel: '비회원' };\nlet loginPromptShown = false;\n\nconst LOGIN_SETUP_MESSAGE = [\n  '로그인은 앱한테 신라면세점 문을 열 수 있는 열쇠를 주는 일입니다.',\n  '',\n  '이 노트북에서 다시 로그인하는 방법:',\n  '1. 터미널을 엽니다.',\n  '2. cd ~/Documents/GitHub/-shilla-mobile-guest-search 를 붙여넣고 Enter를 누릅니다.',\n  '3. npm run capture:login 을 붙여넣고 Enter를 누릅니다.',\n  '4. Chrome 창이 열리면 신라면세점에 로그인합니다.',\n  '5. 상품 상세페이지가 보이면 터미널로 돌아와 Enter를 누릅니다.',\n  '6. 같은 노트북에서 npm start로 앱을 다시 켜고 http://localhost:3000 으로 들어갑니다.',\n  '',\n  '회사 컴퓨터에서 쓰려면 회사 컴퓨터에서도 위 과정을 한 번 해야 합니다.',\n].join('\\n');\n\nconst RENDER_SECURITY_MESSAGE = [\n  'Render는 내 노트북이 아니라 밖에 있는 다른 컴퓨터입니다.',\n  '신라면세점이 그 컴퓨터는 문 앞에서 막고 있습니다.',\n  '그래서 Render 주소에서는 로그인 혜택 조회가 안 됩니다.',\n  '',\n  '로그인 혜택은 지금 쓰는 노트북에서 npm start로 켠 http://localhost:3000 에서 조회합니다.',\n  '회사 컴퓨터에서 쓰려면 회사 컴퓨터에서 다시 로그인 캡처를 해야 합니다.',\n].join('\\n');\n\nfunction setStatus(message, { error = false, sourceUrl = '' } = {}) {\n  statusPanel.classList.toggle('error', error);\n  statusText.textContent = message;\n\n  if (sourceUrl) {\n    sourceLink.href = sourceUrl;\n    sourceLink.hidden = false;\n  } else {\n    sourceLink.hidden = true;\n  }\n}\n\nfunction escapeHtml(value) {\n  return String(value || '')\n    .replaceAll('&', '&amp;')\n    .replaceAll('<', '&lt;')\n    .replaceAll('>', '&gt;')\n    .replaceAll('\"', '&quot;')\n    .replaceAll(\"'\", '&#039;');\n}\n\nfunction renderEmpty(message) {\n  latestRows = [];\n  downloadButton.hidden = true;\n  const headers = renderHeaders([]);\n  resultsBody.innerHTML = `\n    <tr class=\"empty-row\">\n      <td colspan=\"${headers.length}\">${escapeHtml(message)}</td>\n    </tr>\n  `;\n}\n\nfunction benefitHeadersForRows(items) {\n  const preferredOrder = [\n    '상품 할인',\n    '데일리 쿠폰',\n    '브랜드 쿠폰',\n    '상품 쿠폰',\n    '장바구니 쿠폰',\n    '카드 할인',\n    '쿠폰 다운로드',\n    '적립금',\n    'S포인트',\n  ];\n  const headers = new Set();\n\n  for (const item of items) {\n    for (const header of Object.keys(item.benefitBreakdown || {})) {\n      if (header) headers.add(header);\n    }\n    if (item.productDiscount) headers.add('상품 할인');\n    if (item.dailyCoupon) headers.add('데일리 쿠폰');\n    if (item.rewardAmount) headers.add('적립금');\n    if (item.sPointBenefit) headers.add('S포인트');\n    if (item.otherBenefits) headers.add('기타혜택');\n  }\n\n  return [\n    ...preferredOrder.filter((header) => headers.has(header)),\n    ...Array.from(headers).filter((header) => !preferredOrder.includes(header)),\n  ];\n}\n\nfunction resultHeadersForRows(items = []) {\n  return [...BASE_RESULT_HEADERS, ...benefitHeadersForRows(items), ...TRAILING_RESULT_HEADERS];\n}\n\nfunction renderHeaders(items = []) {\n  const headers = resultHeadersForRows(items);\n  resultsHead.innerHTML = `\n    <tr>\n      ${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}\n    </tr>\n  `;\n  return headers;\n}\n\nfunction benefitValueForHeader(item, header) {\n  const benefitBreakdown = item.benefitBreakdown || {};\n  if (benefitBreakdown[header]) return benefitBreakdown[header];\n  if (header === '상품 할인') return item.productDiscount || '';\n  if (header === '데일리 쿠폰') return item.dailyCoupon || '';\n  if (header === '적립금') return item.rewardAmount || '';\n  if (header === 'S포인트') return item.sPointBenefit || '';\n  if (header === '기타혜택') return item.otherBenefits || '';\n  return '';\n}\n\nfunction valueForHeader(item, header) {\n  if (header === '입력값') return item.sourceQuery || '';\n  if (header === '브랜드코드') return item.brandCode || '';\n  if (header === '브랜드') return item.brand || '';\n  if (header === '상품명') return item.productName || '';\n  if (header === '상품SKU') return item.productSku || '';\n  if (header === '최대혜택가') return item.maxBenefitPrice || '';\n  if (header === '조회기준') return item.benefitBasis || '';\n  if (header === '상품 URL') return item.productUrl || '';\n  return benefitValueForHeader(item, header);\n}\n\nfunction classForHeader(header) {\n  if (header === '입력값') return 'source-query';\n  if (header === '상품명') return 'product-name';\n  if (header === '상품 URL') return 'url-cell';\n  if (header === '최대혜택가' || /가격|가|할인|쿠폰|적립|포인트|P$/.test(header)) return 'price';\n  return '';\n}\n\nfunction renderRows(items) {\n  const normalizedItems = fillMissingBrandCodes(items);\n  const headers = renderHeaders(normalizedItems);\n  latestRows = normalizedItems;\n  downloadButton.hidden = normalizedItems.length === 0;\n\n  if (!normalizedItems.length) {\n    resultsBody.innerHTML = `\n      <tr class=\"empty-row\">\n        <td colspan=\"${headers.length}\">검색 결과가 없습니다.</td>\n      </tr>\n    `;\n    return;\n  }\n\n  resultsBody.innerHTML = normalizedItems\n    .map((item) => {\n      return `\n        <tr>\n          ${headers\n            .map((header) => {\n              const value = valueForHeader(item, header);\n              const className = classForHeader(header);\n              if (header === '상품 URL' && value) {\n                const url = escapeHtml(value);\n                return `<td class=\"${className}\"><a href=\"${url}\" target=\"_blank\" rel=\"noreferrer\">${url}</a></td>`;\n              }\n              return `<td${className ? ` class=\"${className}\"` : ''}>${escapeHtml(value)}</td>`;\n            })\n            .join('')}\n        </tr>\n      `;\n    })\n    .join('');\n}\n\nfunction setBusy(isBusy) {\n  button.disabled = isBusy;\n  benefitsButton.disabled = isBusy;\n  templateButton.disabled = isBusy;\n}\n\nasync function searchShilla(query, maxResults) {\n  const body = maxResults ? { query, maxResults } : { query };\n  const response = await fetch('/api/search', {\n    method: 'POST',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify(body),\n  });\n\n  const payload = await readJsonResponse(response);\n  if (!response.ok) {\n    throw new Error(payload.error || '검색에 실패했습니다.');\n  }\n  return payload;\n}\n\nasync function searchBenefits(query, maxResults = 1, fallbackItem = null) {\n  const body = { query, maxResults };\n  if (fallbackItem) body.fallbackItem = fallbackItem;\n\n  const response = await fetch('/api/benefits', {\n    method: 'POST',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify(body),\n  });\n\n  const payload = await readJsonResponse(response);\n  if (!response.ok) {\n    throw new Error(payload.error || '혜택 조회에 실패했습니다.');\n  }\n  return payload;\n}\n\nasync function readJsonResponse(response) {\n  const text = await response.text();\n  try {\n    return JSON.parse(text);\n  } catch {\n    const message = response.ok\n      ? '서버가 JSON이 아닌 응답을 반환했습니다.'\n      : `서버 오류가 발생했습니다. 상태코드: ${response.status}`;\n    throw new Error(message);\n  }\n}\n\nasync function loadSessionStatus() {\n  try {\n    setStatus('로그인 세션 유효성을 확인 중입니다.');\n    const response = await fetch('/api/session', { cache: 'no-store' });\n    const payload = await response.json();\n    loginSession = payload;\n    if (payload.loginValid && !payload.needsLogin) {\n      setStatus(\n        `로그인 세션이 유효합니다. 상단 검색과 파일 일괄 조회는 ${payload.accountLabel || '로그인'} 기준 상세페이지 값으로 실행됩니다.`,\n      );\n    } else if (payload.loginValid && payload.needsLogin) {\n      setStatus(\n        '로그인 쿠키가 있습니다. 혜택 조회를 누르면 열린 Chrome에서 신라 보안 확인을 통과해야 할 수 있습니다.',\n      );\n    } else if (payload.loginTokenValid && !payload.detailAccessValid) {\n      setStatus(payload.reason || '상품 상세페이지 보안 세션이 만료되었습니다. 다시 로그인 캡처가 필요합니다.', { error: true });\n    } else {\n      setStatus(payload.reason || '로그인 세션이 없거나 만료되었습니다. 상단 검색은 비로그인 결과로 실행됩니다.', { error: true });\n    }\n  } catch {\n    setStatus('검색어를 입력하세요.');\n  }\n}\n\nfunction showLoginPrompt(payload = loginSession) {\n  if (loginPromptShown) return;\n  loginPromptShown = true;\n  const reason = payload?.reason ? `사유: ${payload.reason}\\n\\n` : '';\n  const setupMessage = payload?.renderSecurityBlocked ? RENDER_SECURITY_MESSAGE : LOGIN_SETUP_MESSAGE;\n  window.alert(`${reason}${setupMessage}`);\n}\n\nfunction isDirectProductQuery(query) {\n  return /\\/p\\/\\d+(?:[/?#]|$)/.test(String(query || '')) || isRealSku(extractSku(query));\n}\n\nfunction loginBasis(payload) {\n  return payload.loginApplied ? `로그인${payload.accountLabel ? ` (${payload.accountLabel})` : ''}` : '비로그인';\n}\n\nasync function collectLoginBenefitRows(query, maxResults, onProgress) {\n  if (isDirectProductQuery(query)) {\n    const payload = await searchBenefits(query, 1);\n    const rows = (payload.items || []).map((item) => normalizeSearchItem(item, query, loginBasis(payload)));\n    return {\n      rows,\n      searchUrl: payload.searchUrl,\n      finalUrl: payload.finalUrl,\n      retrievedAt: payload.retrievedAt,\n    };\n  }\n\n  const listPayload = await searchShilla(query, maxResults);\n  const items = listPayload.items || [];\n  if (!items.length) {\n    return {\n      rows: [\n        {\n          sourceQuery: query,\n          brandCode: brandCodeFromSku(extractSku(query)),\n          brand: '',\n          productName: listPayload.noResultMessage || '검색 결과가 없습니다.',\n          productSku: extractSku(query),\n          maxBenefitPrice: '',\n          productDiscount: '',\n          dailyCoupon: '',\n          rewardAmount: '',\n          sPointBenefit: '',\n          otherBenefits: '',\n          benefitBreakdown: {},\n          benefitDetailsText: '',\n          benefitBasis: '검색 결과 없음',\n          productUrl: '',\n        },\n      ],\n      searchUrl: listPayload.searchUrl,\n      finalUrl: listPayload.finalUrl,\n      retrievedAt: listPayload.retrievedAt,\n    };\n  }\n\n  const detailRowsByIndex = new Array(items.length);\n  let nextIndex = 0;\n  let completed = 0;\n  const workerCount = Math.min(DETAIL_LOOKUP_CONCURRENCY, items.length);\n\n  async function worker() {\n    while (nextIndex < items.length) {\n      const index = nextIndex;\n      nextIndex += 1;\n      const item = items[index];\n      const detailQuery = item.productUrl || item.productSku || item.productName;\n\n      try {\n        const payload = await searchBenefits(detailQuery, 1, item);\n        const rows = (payload.items || []).map((detailItem) => ({\n          ...normalizeSearchItem(detailItem, query, loginBasis(payload)),\n          sourceQuery: query,\n        }));\n        detailRowsByIndex[index] = rows.length ? rows : [normalizeSearchItem(item, query, '상세 결과 없음')];\n      } catch (error) {\n        detailRowsByIndex[index] = [\n          {\n            ...normalizeSearchItem(item, query, '상세 확인 실패'),\n            benefitDetailsText: error.message || '상세 확인 실패',\n          },\n        ];\n      }\n\n      completed += 1;\n      const currentRows = detailRowsByIndex.flat().filter(Boolean);\n      onProgress?.(currentRows, completed, items.length);\n    }\n  }\n\n  await Promise.all(Array.from({ length: workerCount }, () => worker()));\n\n  return {\n    rows: detailRowsByIndex.flat().filter(Boolean),\n    searchUrl: listPayload.searchUrl,\n    finalUrl: listPayload.finalUrl,\n    retrievedAt: new Date().toISOString(),\n  };\n}\n\nfunction extractSku(value) {\n  const text = String(value || '');\n  const skuLabelMatch = text.match(/(?:sku|스큐|상품sku|상품\\s*sku)\\D{0,12}(\\d{12})/i);\n  if (skuLabelMatch?.[1]) return skuLabelMatch[1];\n  return text.match(/\\b\\d{12}\\b/)?.[0] || '';\n}\n\nfunction brandCodeFromSku(sku) {\n  const digits = String(sku || '').replace(/\\D/g, '');\n  return digits.length === 12 ? digits.slice(0, 4) : '';\n}\n\nfunction isRealSku(value) {\n  return /^\\d{12}$/.test(String(value || '').replace(/\\D/g, ''));\n}\n\nfunction normalizeSearchItem(item, sourceQuery, benefitBasis = SEARCH_RESULT_BASIS) {\n  const sourceSku = extractSku(sourceQuery);\n  const itemSku = isRealSku(item.productSku) ? item.productSku : '';\n  const sku = itemSku || sourceSku;\n  const resolvedBasis =\n    item.benefitBasis && !(item.benefitBasis === '비회원' && benefitBasis.startsWith('로그인'))\n      ? item.benefitBasis\n      : benefitBasis;\n  return {\n    sourceQuery,\n    brandCode: brandCodeFromSku(sku),\n    brand: item.brand || '',\n    productName: item.productName || '',\n    productSku: sku,\n    productCode: item.productCode || '',\n    salePrice: item.salePrice || '',\n    maxBenefitPrice: item.maxBenefitPrice || '',\n    productDiscount: item.productDiscount || item.discountRate || '',\n    dailyCoupon: item.dailyCoupon || '',\n    rewardAmount: item.rewardAmount || '',\n    sPointBenefit: item.sPointBenefit || '',\n    otherBenefits: item.otherBenefits || '',\n    benefitBreakdown: item.benefitBreakdown || {},\n    benefitBasis: resolvedBasis,\n    benefitDetailsText: item.benefitDetailsText || '',\n    benefitText: item.benefitText || '',\n    productUrl: item.productUrl || '',\n  };\n}\n\nfunction fillMissingBrandCodes(items) {\n  return items.map((item) => ({\n    ...item,\n    brandCode: brandCodeFromSku(item.productSku),\n  }));\n}\n\nfunction parseDelimitedText(text, delimiter) {\n  const rows = [];\n  let row = [];\n  let cell = '';\n  let quoted = false;\n\n  for (let i = 0; i < text.length; i += 1) {\n    const char = text[i];\n    const next = text[i + 1];\n\n    if (char === '\"' && quoted && next === '\"') {\n      cell += '\"';\n      i += 1;\n    } else if (char === '\"') {\n      quoted = !quoted;\n    } else if (char === delimiter && !quoted) {\n      row.push(cell);\n      cell = '';\n    } else if ((char === '\\n' || char === '\\r') && !quoted) {\n      if (char === '\\r' && next === '\\n') i += 1;\n      row.push(cell);\n      rows.push(row);\n      row = [];\n      cell = '';\n    } else {\n      cell += char;\n    }\n  }\n\n  row.push(cell);\n  rows.push(row);\n  return rows;\n}\n\nfunction normalizeHeader(value) {\n  return String(value || '')\n    .trim()\n    .toLowerCase()\n    .replace(/[\\s_-]+/g, '');\n}\n\nfunction extractQueriesFromRows(rows) {\n  const cleanedRows = rows\n    .map((row) => row.map((cell) => String(cell || '').trim()))\n    .filter((row) => row.some(Boolean));\n\n  if (!cleanedRows.length) return [];\n\n  const headerAliases = new Map([\n    ['입력값', 0],\n    ['검색값', 0],\n    ['검색대상', 0],\n    ['value', 0],\n    ['input', 0],\n    ['상품url', 1],\n    ['url', 1],\n    ['producturl', 1],\n    ['sku', 2],\n    ['스큐', 2],\n    ['상품sku', 2],\n    ['상품코드', 3],\n    ['상품번호', 3],\n    ['productcode', 3],\n    ['검색어', 4],\n    ['keyword', 4],\n    ['query', 4],\n    ['상품명', 5],\n    ['productname', 5],\n    ['브랜드명', 6],\n    ['브랜드', 6],\n    ['brand', 6],\n  ]);\n\n  const headers = cleanedRows[0].map(normalizeHeader);\n  const matchingHeaders = headers\n    .map((header, index) => ({ index, priority: headerAliases.get(header) }))\n    .filter((header) => header.priority !== undefined)\n    .sort((a, b) => a.priority - b.priority);\n\n  const valueIndex = matchingHeaders[0]?.index ?? 0;\n  const dataRows = matchingHeaders.length ? cleanedRows.slice(1) : cleanedRows;\n  const seen = new Set();\n  const queries = [];\n\n  for (const row of dataRows) {\n    const value = (row[valueIndex] || row.find(Boolean) || '').trim();\n    if (!value || seen.has(value)) continue;\n    seen.add(value);\n    queries.push(value);\n    if (queries.length >= BATCH_MAX_QUERIES) break;\n  }\n\n  return queries;\n}\n\nasync function readBatchQueries(file) {\n  const lowerName = file.name.toLowerCase();\n\n  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {\n    if (!window.XLSX) {\n      throw new Error('엑셀 파일 읽기 모듈을 불러오지 못했습니다. CSV로 저장한 뒤 업로드해 주세요.');\n    }\n\n    const buffer = await file.arrayBuffer();\n    const workbook = window.XLSX.read(buffer, { type: 'array' });\n    const firstSheetName = workbook.SheetNames[0];\n    const sheet = workbook.Sheets[firstSheetName];\n    const rows = window.XLSX.utils.sheet_to_json(sheet, {\n      header: 1,\n      raw: false,\n      defval: '',\n    });\n    return extractQueriesFromRows(rows);\n  }\n\n  const text = await file.text();\n  const delimiter = lowerName.endsWith('.tsv') || text.includes('\\t') ? '\\t' : ',';\n  return extractQueriesFromRows(parseDelimitedText(text, delimiter));\n}\n\nfunction formatFileSize(bytes) {\n  if (!Number.isFinite(bytes)) return '';\n  if (bytes < 1024) return `${bytes}B`;\n  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;\n  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;\n}\n\nasync function updateBatchFileInfo() {\n  const file = batchFileInput.files?.[0];\n  if (!file) {\n    batchFileInfo.textContent = '선택된 파일이 없습니다.';\n    return;\n  }\n\n  const baseText = `선택된 파일: ${file.name} (${formatFileSize(file.size)})`;\n  batchFileInfo.textContent = `${baseText} / 입력값을 확인 중입니다.`;\n\n  try {\n    const queries = await readBatchQueries(file);\n    batchFileInfo.textContent = `${baseText} / 읽은 입력값 ${queries.length}개`;\n  } catch (error) {\n    batchFileInfo.textContent = `${baseText} / 파일을 읽지 못했습니다: ${error.message}`;\n  }\n}\n\nfunction toCsvValue(value) {\n  const text = String(value || '');\n  return /[\",\\n\\r]/.test(text) ? `\"${text.replaceAll('\"', '\"\"')}\"` : text;\n}\n\nfunction downloadTemplate() {\n  if (window.XLSX) {\n    const workbook = window.XLSX.utils.book_new();\n    const sheet = window.XLSX.utils.aoa_to_sheet(TEMPLATE_ROWS);\n    sheet['!cols'] = [{ wch: 70 }];\n    window.XLSX.utils.book_append_sheet(workbook, sheet, '일괄조회양식');\n    window.XLSX.writeFile(workbook, 'shilla-batch-template.xlsx');\n    return;\n  }\n\n  const lines = TEMPLATE_ROWS.map((row) => row.map(toCsvValue).join(','));\n  const blob = new Blob([`\\ufeff${lines.join('\\n')}`], { type: 'text/csv;charset=utf-8' });\n  const url = URL.createObjectURL(blob);\n  const link = document.createElement('a');\n  link.href = url;\n  link.download = 'shilla-batch-template.csv';\n  link.click();\n  URL.revokeObjectURL(url);\n}\n\nfunction downloadCsv() {\n  if (!latestRows.length) return;\n  const exportRows = fillMissingBrandCodes(latestRows);\n  const headers = resultHeadersForRows(exportRows);\n\n  const rows = exportRows.map((row) => {\n    return Object.fromEntries(headers.map((header) => [header, valueForHeader(row, header)]));\n  });\n\n  if (window.XLSX) {\n    const workbook = window.XLSX.utils.book_new();\n    const sheet = window.XLSX.utils.json_to_sheet(rows, { header: headers });\n    sheet['!cols'] = headers.map((header) => ({ wch: header === '상품 URL' ? 70 : 18 }));\n    window.XLSX.utils.book_append_sheet(workbook, sheet, '조회결과');\n    window.XLSX.writeFile(workbook, `shilla-benefits-${new Date().toISOString().slice(0, 10)}.xlsx`);\n    return;\n  }\n\n  const lines = [\n    headers.map(toCsvValue).join(','),\n    ...rows.map((row) => headers.map((header) => toCsvValue(row[header])).join(',')),\n  ];\n\n  const blob = new Blob([`\\ufeff${lines.join('\\n')}`], { type: 'text/csv;charset=utf-8' });\n  const url = URL.createObjectURL(blob);\n  const link = document.createElement('a');\n  link.href = url;\n  link.download = `shilla-benefits-${new Date().toISOString().slice(0, 10)}.csv`;\n  link.click();\n  URL.revokeObjectURL(url);\n}\n\nform.addEventListener('submit', async (event) => {\n  event.preventDefault();\n\n  const query = queryInput.value.trim();\n  if (!query) return;\n\n  setBusy(true);\n  setStatus('검색 중입니다. 신라면세점 모바일 페이지를 Playwright로 열고 있습니다.');\n  renderEmpty('검색 중입니다.');\n\n  try {\n    if (loginSession.loginValid) {\n      const result = await collectLoginBenefitRows(query, SINGLE_BENEFIT_MAX_RESULTS, (partialRows, completed, total) => {\n        renderRows(partialRows);\n        setStatus(`로그인 상세 혜택 조회 중입니다. ${completed}/${total}: ${query}`);\n      });\n      renderRows(result.rows);\n      const message = result.rows.length\n        ? `${result.rows.length}건의 로그인 상세 혜택을 추출했습니다. 조회 시각: ${new Date(result.retrievedAt).toLocaleString()}`\n        : '검색 결과가 없습니다.';\n      setStatus(message, { sourceUrl: result.finalUrl || result.searchUrl });\n    } else {\n      const payload = await searchShilla(query, BATCH_MAX_RESULTS_PER_QUERY);\n\n      renderRows((payload.items || []).map((item) => normalizeSearchItem(item, query, SEARCH_RESULT_BASIS)));\n      const message =\n        payload.count > 0\n          ? `${payload.count}건의 비로그인 검색 결과를 추출했습니다. 로그인하지 않은 상태라 상세 혜택 값은 확인하지 않았습니다.`\n          : payload.noResultMessage || '검색 결과가 없습니다.';\n      setStatus(message, { sourceUrl: payload.finalUrl || payload.searchUrl });\n    }\n  } catch (error) {\n    renderEmpty('조회에 실패했습니다.');\n    setStatus(error.message, { error: true });\n  } finally {\n    setBusy(false);\n  }\n});\n\nbenefitsButton.addEventListener('click', async () => {\n  const file = batchFileInput.files?.[0];\n  if (!file) {\n    setStatus('엑셀 또는 CSV 파일을 선택하세요.', { error: true });\n    return;\n  }\n\n  if (!loginSession.loginValid) {\n    setStatus(loginSession.reason || '로그인 세션이 유효하지 않아 로그인 혜택 조회를 실행할 수 없습니다.', { error: true });\n    showLoginPrompt(loginSession);\n    return;\n  }\n\n  setBusy(true);\n  renderEmpty('파일을 읽는 중입니다.');\n  setStatus('파일을 읽는 중입니다.');\n\n  try {\n    const queries = await readBatchQueries(file);\n    if (!queries.length) {\n      throw new Error('파일에서 검색어를 찾지 못했습니다.');\n    }\n\n    const rows = [];\n    for (let i = 0; i < queries.length; i += 1) {\n      const query = queries[i];\n      setStatus(`혜택 일괄 조회 중입니다. ${i + 1}/${queries.length}: ${query}`);\n\n      try {\n        const result = await collectLoginBenefitRows(query, BATCH_BENEFIT_MAX_RESULTS_PER_QUERY, (partialRows, completed, total) => {\n          renderRows([...rows, ...partialRows]);\n          setStatus(`혜택 일괄 조회 중입니다. ${i + 1}/${queries.length}: ${query} 상품 ${completed}/${total}`);\n        });\n        rows.push(...result.rows);\n      } catch (error) {\n        rows.push({\n          sourceQuery: query,\n          brandCode: brandCodeFromSku(extractSku(query)),\n          brand: '',\n          productName: error.message || '혜택 조회 실패',\n          productSku: extractSku(query),\n          productCode: '',\n          guestPrice: '',\n          salePrice: '',\n          maxBenefitPrice: '',\n          productDiscount: '',\n          dailyCoupon: '',\n          rewardAmount: '',\n          sPointBenefit: '',\n          otherBenefits: '',\n          benefitBreakdown: {},\n          benefitBasis: '확인 실패',\n          benefitDetailsText: error.message || '혜택 조회 실패',\n          benefitText: '',\n          productUrl: '',\n        });\n      }\n\n      renderRows(rows);\n    }\n\n    setStatus(`${queries.length}개 입력값의 혜택 조회를 완료했습니다. 엑셀 다운로드를 누르면 결과 파일을 받을 수 있습니다.`);\n  } catch (error) {\n    renderEmpty('혜택 일괄 조회에 실패했습니다.');\n    setStatus(error.message, { error: true });\n  } finally {\n    setBusy(false);\n  }\n});\n\ntemplateButton.addEventListener('click', downloadTemplate);\ndownloadButton.addEventListener('click', downloadCsv);\nbatchFileInput.addEventListener('change', updateBatchFileInfo);\nrenderHeaders([]);\nupdateBatchFileInfo();\nloadSessionStatus();\n" }],
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
      const shouldProbe = requestUrl.searchParams.get('probe') === '1';
      jsonResponse(res, 200, await getLoginSessionInfo({ probe: shouldProbe }));
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
      const fallbackItem = normalizeFallbackItem(body.fallbackItem);
      const requestedMaxResults = Number(body.maxResults || DEFAULT_BENEFIT_MAX_RESULTS);
      const maxResults = Number.isFinite(requestedMaxResults)
        ? Math.min(Math.max(Math.floor(requestedMaxResults), 1), 100)
        : DEFAULT_BENEFIT_MAX_RESULTS;

      if (!query) {
        jsonResponse(res, 400, { error: '상품명, SKU 또는 상품 URL을 입력하세요.' });
        return;
      }

      const sessionInfo = await getLoginSessionInfo({ probe: true });
      if (!sessionInfo.loginValid) {
        jsonResponse(res, 428, {
          error: sessionInfo.reason || '로그인 세션이 유효하지 않습니다.',
          ...sessionInfo,
        });
        return;
      }

      const result = await scrapeBenefitRows(query, maxResults, fallbackItem);
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

function listenWithPortFallback(port, attempt = 0) {
  server.removeAllListeners('error');
  server.removeAllListeners('listening');
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && !process.env.PORT && attempt < 10) {
      const nextPort = port + 1;
      console.log(`Port ${port} is already in use. Trying http://localhost:${nextPort}`);
      listenWithPortFallback(nextPort, attempt + 1);
      return;
    }

    throw error;
  });

  server.once('listening', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Shilla guest search app: http://localhost:${actualPort}`);
    console.log(`Browser mode: ${HEADLESS ? 'headless' : 'visible Chrome'}`);
  });
  server.listen(port);
}

listenWithPortFallback(PORT);

async function shutdown() {
  server.close();
  if (loginContextPromise) {
    const context = await loginContextPromise.catch(() => null);
    await context?.close().catch(() => {});
  }
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
