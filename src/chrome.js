import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { extractCards } from './course.js';
import { watchVideo } from './player.js';
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
    this.playerPage = null;
    this.playerClosing = null;
  }

  async closePlayer(playerPage = this.playerPage) {
    if (!playerPage) return;
    if (this.playerClosing) return this.playerClosing;
    this.playerClosing = (async () => {
      try {
        if (!playerPage.isClosed?.()) await playerPage.close();
      } finally {
        if (this.playerPage === playerPage) this.playerPage = null;
        this.playerClosing = null;
      }
    })();
    return this.playerClosing;
  }

  async cancel() {
    await this.closePlayer();
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

  async verify(card, pageNumber) {
    await this.restorePage(pageNumber);
    const current = (await this.listCards())[card.index];
    if (!current || current.title !== card.title) throw new RunError('CARD_CHANGED', `视频列表顺序已改变：${card.title}`);
    return current.progress === 100;
  }

  async openAndWatch(card, { signal, onProgress, expectedPage, expectedProgress } = {}) {
    if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
    const tile = this.page.locator(CARD).nth(card.index);
    const visibleTitle = (await tile.locator('[class*="bottomTitle"]').innerText()).trim();
    if (visibleTitle !== card.title) throw new RunError('CARD_CHANGED', `视频列表顺序已改变：${card.title}`);
    if (expectedPage !== undefined || expectedProgress !== undefined) {
      const current = await tile.evaluate(node => {
        const activeText = document.querySelector('li.ant-pagination-item-active')?.textContent?.trim();
        return {
          title: node.querySelector('[class*="bottomTitle"]')?.textContent?.trim(),
          rawProgress: node.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
          activePage: activeText ? Number(activeText) : null,
        };
      });
      const matchesPage = current.activePage === expectedPage || (expectedPage === 1 && current.activePage === null);
      if (this.currentPage !== expectedPage || !matchesPage || current.title !== card.title
        || current.rawProgress == null || current.rawProgress.trim() === ''
        || Number(current.rawProgress) !== expectedProgress) {
        throw new RunError('CARD_CHANGED', `视频位置或进度在打开前已变化：${card.title}`);
      }
    }

    const opened = this.page.waitForEvent('popup', { timeout: 60_000 });
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new RunError('STOPPED', 'task stopped'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    let playerPage;
    try {
      await Promise.race([tile.locator('[class*="imgWrap"]').click(), interrupted]);
      playerPage = await Promise.race([opened, interrupted]);
    } catch (error) {
      opened.then(latePage => latePage.close()).catch(() => {});
      if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
      if (error instanceof RunError) throw error;
      throw new RunError('PAGE_LOAD_FAILED', '视频播放页打开失败或加载超时');
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    this.playerPage = playerPage;
    try {
      if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
      await playerPage.bringToFront();
      let loadStage = '播放器';
      let playerText;
      try {
        await playerPage.locator('video').waitFor({ state: 'attached', timeout: 120_000 });
        loadStage = '媒体时长';
        await playerPage.waitForFunction(() => {
          const video = document.querySelector('video');
          return video && Number.isFinite(video.duration) && video.duration > 0;
        }, null, { timeout: 180_000 });
        loadStage = '检查点信息';
        playerText = await playerPage.locator('body').innerText();
      } catch (error) {
        if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
        const reason = String(error?.message ?? error).split('\n')[0];
        throw new RunError('PAGE_LOAD_FAILED', `视频播放页${loadStage}加载失败：${reason}`);
      }
      const questionCount = playerText.match(/试题总数\s*(\d+)/);
      if (questionCount && Number(questionCount[1]) > 0) {
        throw new RunError('CHECKPOINT', '此视频包含试题，需要用户自行处理');
      }
      if (!playerText.includes('暂无检查点')) {
        throw new RunError('CHECKPOINT', '未能确认检查点列表为空，需要用户检查');
      }

      const player = {
        play: async () => {
          const box = await playerPage.locator('video').boundingBox();
          if (!box) throw new Error('播放器不在可见区域');
          await playerPage.mouse.move(box.x + 24, box.y + box.height - 40);
          await playerPage.mouse.click(box.x + 24, box.y + box.height - 40);
          await playerPage.waitForFunction(() => !document.querySelector('video')?.paused, null, { timeout: 10_000 });
        },
        snapshot: () => playerPage.locator('video').evaluate(video => ({
          currentTime: video.currentTime,
          duration: video.duration,
          ended: video.ended,
          paused: video.paused,
          readyState: video.readyState,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
        })),
      };
      await watchVideo(player, { signal, onProgress });
      await playerPage.waitForFunction(() => {
        const match = document.body.innerText.match(/观看\s*(\d{2}:\d{2}:\d{2})\s*\/\s*(\d{2}:\d{2}:\d{2})/);
        return match && match[1] === match[2] && match[2] !== '00:00:00';
      }, null, { timeout: 20_000 });
      await playerPage.waitForTimeout(3_000);
    } finally {
      await this.closePlayer(playerPage);
    }
  }
}
