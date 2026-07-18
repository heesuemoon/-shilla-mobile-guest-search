import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { chromium, devices } from 'playwright';

const statePath = path.resolve(process.env.SHILLA_STORAGE_STATE_PATH || '.shilla-storage-state.json');
const base64Path = path.resolve('.shilla-storage-state.base64.txt');
const profileDir = path.resolve(process.env.SHILLA_PROFILE_DIR || '.shilla-chrome-profile');
const verifyUrl = process.env.SHILLA_LOGIN_VERIFY_URL || 'https://m.shilladfs.com/estore/kr/ko/p/5621582';

async function launchLoginContext() {
  const options = {
    ...(devices['iPhone 13'] || {}),
    headless: false,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  };

  try {
    return await chromium.launchPersistentContext(profileDir, { ...options, channel: 'chrome' });
  } catch (chromeError) {
    try {
      return await chromium.launchPersistentContext(profileDir, options);
    } catch {
      throw chromeError;
    }
  }
}

const context = await launchLoginContext().catch((error) => {
  console.error('');
  console.error('Chrome 로그인 프로필을 열 수 없습니다.');
  console.error('앱을 켜둔 상태라면 npm start가 실행 중인 터미널에서 control + C를 누른 뒤 다시 실행하세요.');
  console.error(error.message || error);
  process.exit(1);
});

const page = context.pages()[0] || (await context.newPage());
await page
  .goto('https://m.shilladfs.com/estore/kr/ko/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  })
  .catch((error) => {
    console.log('');
    console.log('신라면세점 첫 화면을 자동으로 열지 못했습니다.');
    console.log('열린 Chrome 주소창에 아래 주소를 직접 붙여넣으세요.');
    console.log('https://m.shilladfs.com/estore/kr/ko/');
    console.log(error.message || error);
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
}).catch((error) => {
  console.log('');
  console.log('상품 상세페이지를 자동으로 열지 못했습니다.');
  console.log('열린 Chrome 주소창에 아래 주소를 직접 붙여넣으세요.');
  console.log(verifyUrl);
  console.log(error.message || error);
});
await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
await rl.question('상품 상세 화면이 보이면 Enter: ');
rl.close();

await mkdir(path.dirname(statePath), { recursive: true });
await context.storageState({ path: statePath });
const stateJson = await readFile(statePath, 'utf8');
await writeFile(base64Path, Buffer.from(stateJson, 'utf8').toString('base64'));

await context.close();

console.log('');
console.log(`로그인 세션 파일: ${statePath}`);
console.log(`로그인 Chrome 프로필: ${profileDir}`);
console.log(`Render 환경변수 SHILLA_STORAGE_STATE_BASE64 값: ${base64Path}`);
console.log('로컬 앱은 이 Chrome 프로필을 사용해 로그인 기준 혜택 조회를 실행합니다.');
