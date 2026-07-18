import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { chromium, devices } from 'playwright';

const statePath = path.resolve(process.env.SHILLA_STORAGE_STATE_PATH || '.shilla-storage-state.json');
const base64Path = path.resolve('.shilla-storage-state.base64.txt');
const verifyUrl = process.env.SHILLA_LOGIN_VERIFY_URL || 'https://m.shilladfs.com/estore/kr/ko/p/5621582';

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    return chromium.launch({ headless: false });
  }
}

const browser = await launchBrowser();
const context = await browser.newContext({
  ...(devices['iPhone 13'] || {}),
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: {
    'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  },
});

const page = await context.newPage();
await page.goto('https://m.shilladfs.com/estore/kr/ko/', {
  waitUntil: 'domcontentloaded',
  timeout: 45000,
});

console.log('');
console.log('열린 Chrome 창에서 신라면세점에 로그인하세요.');
console.log('로그인이 끝나면 이 터미널로 돌아와 Enter를 누르세요.');
console.log('');

const rl = createInterface({ input, output });
await rl.question('로그인을 마쳤으면 Enter: ');

console.log('');
console.log('상품 상세페이지 보안 세션을 확인합니다.');
console.log('열린 Chrome 창에서 상품 상세 화면이 정상으로 보이는지 확인하세요.');
console.log('보안 확인 화면이 나오면 끝날 때까지 기다린 뒤 Enter를 누르세요.');
console.log('');

await page.goto(verifyUrl, {
  waitUntil: 'domcontentloaded',
  timeout: 45000,
}).catch(() => {});
await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
await rl.question('상품 상세 화면이 보이면 Enter: ');
rl.close();

await mkdir(path.dirname(statePath), { recursive: true });
await context.storageState({ path: statePath });
const stateJson = await readFile(statePath, 'utf8');
await writeFile(base64Path, Buffer.from(stateJson, 'utf8').toString('base64'));

await browser.close();

console.log('');
console.log(`로그인 세션 파일: ${statePath}`);
console.log(`Render 환경변수 SHILLA_STORAGE_STATE_BASE64 값: ${base64Path}`);
console.log('이 파일 내용 전체를 Render Environment에 붙여넣으면 로그인 기준 혜택 조회가 됩니다.');
