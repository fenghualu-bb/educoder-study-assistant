import { normalizeClassroomUrl } from './course.js';
import { RunError } from './run-error.js';

const CLASSROOMS_URL = 'https://www.educoder.net/classrooms';

function mineResponse(response, pageNumber) {
  try {
    const url = new URL(response.url());
    return ['https://www.educoder.net', 'https://data.educoder.net'].includes(url.origin)
      && url.pathname === '/api/courses.json'
      && url.searchParams.get('order') === 'mine'
      && Number(url.searchParams.get('page')) === pageNumber;
  } catch { return false; }
}

function readCourses(data) {
  if (!data || !Array.isArray(data.courses) || !Number.isInteger(data.courses_count)
    || data.courses_count < 0) throw new RunError('LIST_UNAVAILABLE', '我的课堂列表返回了无效数据');
  return data;
}

export async function listMyClassrooms(page) {
  try {
    await page.goto(CLASSROOMS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    throw new RunError('PAGE_LOAD_FAILED', '头歌教学课堂页面加载失败');
  }
  if (/^\/(?:login|user\/login|users\/login|signin)(?:\/|$)/i.test(new URL(page.url()).pathname)) {
    throw new RunError('LOGIN_REQUIRED', '请先在头歌官方页面登录');
  }

  const mine = page.getByText('我的', { exact: true });
  try {
    await mine.waitFor({ state: 'visible', timeout: 45_000 });
    if (await mine.evaluate(node => String(node.className).includes('active'))) {
      await page.getByText('最新', { exact: true }).click();
    }
  } catch {
    throw new RunError('LIST_UNAVAILABLE', '找不到头歌的“我的课堂”入口');
  }

  const classrooms = [];
  const seen = new Set();
  let seenRaw = 0;
  let total = null;
  for (let pageNumber = 1; pageNumber <= 50; pageNumber++) {
    let response;
    const startedRequests = new Set();
    const onRequest = request => startedRequests.add(request);
    page.on('request', onRequest);
    try {
      const pending = page.waitForResponse(candidate => mineResponse(candidate, pageNumber)
        && startedRequests.has(candidate.request()), { timeout: 45_000 });
      const action = (async () => {
        if (pageNumber === 1) return mine.click();
        const next = page.locator('[class*="quickPager___"] > div').last();
        if (!await next.isVisible() || String(await next.getAttribute('class')).includes('disabled')) {
          throw new Error('没有下一页入口');
        }
        await next.click();
      })();
      [response] = await Promise.all([pending, action]);
    } catch {
      throw new RunError('LIST_UNAVAILABLE', '我的课堂列表加载超时或分页不可用');
    } finally {
      page.off('request', onRequest);
    }
    if ([401, 403].includes(response.status())) throw new RunError('LOGIN_REQUIRED', '请在头歌官方页面重新登录');
    if (response.status() !== 200) throw new RunError('LIST_UNAVAILABLE', '我的课堂列表暂时不可读取');
    let body;
    try { body = await response.json(); }
    catch { throw new RunError('LIST_UNAVAILABLE', '我的课堂列表返回了无法读取的数据'); }
    const data = readCourses(body);
    if (total === null) total = data.courses_count;
    if (total !== data.courses_count || (seenRaw < total && data.courses.length === 0)) {
      throw new RunError('LIST_UNAVAILABLE', '我的课堂列表在读取中发生变化');
    }
    seenRaw += data.courses.length;
    if (seenRaw > total) throw new RunError('LIST_UNAVAILABLE', '我的课堂列表数量与实际条目不一致');
    for (const course of data.courses) {
      const title = typeof course.name === 'string' ? course.name.trim() : '';
      const identifier = course.identifier;
      if (!title || typeof identifier !== 'string' || !/^[A-Za-z0-9_-]+$/.test(identifier)
        || seen.has(identifier)) throw new RunError('LIST_UNAVAILABLE', '我的课堂含有无效或重复的条目');
      seen.add(identifier);
      if (course.is_accessible === false) continue;
      classrooms.push({ title, url: normalizeClassroomUrl(`${CLASSROOMS_URL}/${identifier}/video`) });
    }
    if (seenRaw >= total) return classrooms;
  }
  throw new RunError('LIST_UNAVAILABLE', '我的课堂页数过多，请暂用课堂链接');
}
