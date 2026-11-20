import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { extractCards } from './course.js';
import { RunError } from './run-error.js';

const CARD = '.ant-card-body';
const NEXT = 'li.ant-pagination-next button';

export async function launchChrome(
  profileDir,
  chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  launchContext = (dir, options) => chromium.launchPersistentContext(dir, options),
) {
  await mkdir(profileDir, { recursive: true });
  const context = await launchContext(profileDir, {
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: false,
    chromiumSandbox: true,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.educoder.net/classrooms', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return { context, page };
  } catch (error) {
    try { await context.close(); } catch { /* Preserve the original startup failure. */ }
    throw error;
  }
}

export class ChromeCourse {
  constructor(context, page, listUrl) {
    this.context = context;
    this.page = page;
    this.listUrl = listUrl;
    this.currentPage = 1;
  }

  async prepare() {
    await this.waitForVideoList(() => this.page.goto(this.listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }));
    this.currentPage = 1;
  }

  async waitForVideoList(navigate) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt === 0) await navigate();
        else await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (error) {
        throw new RunError('PAGE_LOAD_FAILED', `视频列表页面加载失败：${error.message}`);
      }

      try {
        await this.page.waitForFunction(() => {
          const card = document.querySelector('.ant-card-body');
          const readyCard = card && card.getClientRects().length > 0;
          const chunkError = /Loading chunk\s+\d+\s+failed|ChunkLoadError/i.test(document.body?.innerText ?? '');
          const login = /^\/(?:login|user\/login|users\/login|signin)(?:\/|$)/i.test(globalThis.location?.pathname ?? '');
          return readyCard || chunkError || login;
        }, null, { timeout: 90_000 });
      } catch {
        // Inspect the visible page below so a timeout is classified accurately.
      }

      if (await this.page.locator(CARD).first().isVisible().catch(() => false)) return;
      const visibleText = await this.page.locator('body').innerText().catch(() => '');
      if (/Loading chunk\s+\d+\s+failed|ChunkLoadError/i.test(visibleText)) {
        if (attempt === 0) continue;
        throw new RunError('CDN_TIMEOUT', '头歌 CDN 脚本加载超时（www-cdn.educoder.net）；已刷新重试一次，仍无法显示视频列表');
      }
      const pathname = new URL(this.page.url?.() ?? this.listUrl).pathname;
      if (/^\/(?:login|user\/login|users\/login|signin)(?:\/|$)/i.test(pathname)) {
        throw new RunError('LOGIN_REQUIRED', '头歌登录已失效，请在头歌专用浏览器中重新登录');
      }
      throw new RunError('LIST_UNAVAILABLE', '视频列表未加载：请检查头歌专用浏览器的登录状态、课堂权限和网络连接');
    }
  }

  async listCards() {
    await this.page.locator(CARD).first().waitFor({ state: 'visible', timeout: 30_000 });
    try {
      await this.page.waitForFunction(() => {
        const cards = [...document.querySelectorAll('.ant-card-body')];
        return cards.length > 0 && !document.querySelector('.ant-spin-spinning')
          && cards.every(card => {
            if (!card.getClientRects().length || !card.querySelector('[class*="bottomTitle"]')?.textContent?.trim()) return false;
            const raw = card.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow');
            if (raw == null || raw.trim() === '') return false;
            const value = Number(raw);
            return Number.isFinite(value) && value >= 0 && value <= 100;
          });
      }, null, { timeout: 30_000 });
    } catch {
      throw new RunError('LIST_UNAVAILABLE', '视频卡片进度未加载，不能安全读取列表');
    }
    return this.page.locator(CARD).evaluateAll(extractCards);
  }

  async courseTitle() {
    return this.page.title();
  }

  async nextPage() {
    const next = this.page.locator(NEXT);
    if (await next.isDisabled()) {
      const numberedPages = await this.page.locator('li.ant-pagination-item').allTextContents();
      if (numberedPages.some(label => Number(label.trim()) > this.currentPage)) {
        throw new RunError('PAGE_LOAD_FAILED', `页面仍显示第 ${this.currentPage} 页之后的页码，但下一页不可用`);
      }
      return false;
    }
    const target = this.currentPage + 1;
    try {
      const pageToken = randomUUID();
      const previousSignature = await this.page.locator(CARD).evaluateAll((cards, token) => {
        cards.forEach(card => { card.dataset.studyPageBefore = token; });
        return JSON.stringify(cards.map(card => [
          card.querySelector('[class*="bottomTitle"]')?.textContent?.trim() ?? '',
          card.querySelector('[class*="imgWrap"] img')?.getAttribute('src') ?? '',
        ]));
      }, pageToken);
      await next.click();
      await this.page.waitForFunction(({ target, previousSignature, pageToken }) => {
        const active = Number(document.querySelector('li.ant-pagination-item-active')?.textContent?.trim());
        const cards = [...document.querySelectorAll('.ant-card-body')];
        const readyCards = cards.length > 0 && cards.every(card =>
          card.getClientRects().length > 0 && card.querySelector('[class*="bottomTitle"]'));
        const signature = JSON.stringify(cards.map(card => [
          card.querySelector('[class*="bottomTitle"]')?.textContent?.trim() ?? '',
          card.querySelector('[class*="imgWrap"] img')?.getAttribute('src') ?? '',
        ]));
        const replacedCards = cards.every(card => card.dataset.studyPageBefore !== pageToken);
        return active === target && readyCards && (signature !== previousSignature || replacedCards)
          && !document.querySelector('.ant-spin-spinning');
      }, { target, previousSignature, pageToken }, { timeout: 45_000 });
    } catch (error) {
      throw new RunError('PAGE_LOAD_FAILED', `第 ${target} 页加载失败：${error.message}`);
    }
    this.currentPage = target;
    return true;
  }

  async restorePage(pageNumber) {
    await this.waitForVideoList(() => this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }));
    this.currentPage = 1;
    while (this.currentPage < pageNumber) {
      if (!await this.nextPage()) throw new RunError('PAGE_LOAD_FAILED', `无法返回第 ${pageNumber} 页`);
    }
  }
}
