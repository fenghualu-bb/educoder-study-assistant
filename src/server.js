import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { normalizeClassroomUrl } from './course.js';
import { RunError } from './run-error.js';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/personal-home.js', ['personal-home.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8_192) throw new Error('请求内容过大');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('请求内容必须是 JSON');
  }
}

function exactBody(body, keys) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === keys.length
    && Object.keys(body).every(key => keys.includes(key));
}

export function createServer({ openBrowser, start, scan, stop, listClassrooms, getStatus, getInventory },
  { csrfToken = null, legacyRunnerDisabled = false } = {}) {
  if (legacyRunnerDisabled && (typeof csrfToken !== 'string' || !csrfToken)) throw new Error('CSRF_REQUIRED');
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'");
    const localOrigin = `http://127.0.0.1:${server.address()?.port}`;
    if (request.headers.host !== `127.0.0.1:${server.address()?.port}`) {
      sendJson(response, 403, { error: '只接受本机请求' });
      return;
    }

    try {
      const path = new URL(request.url, localOrigin).pathname;
      if (request.method === 'GET' && path === '/api/bootstrap') {
        sendJson(response, 200, { csrfToken, desktopMode: csrfToken !== null,
          ...(legacyRunnerDisabled ? { playbackAllowed: false } : {}) });
        return;
      }
      if (request.method === 'GET' && path === '/api/status') {
        sendJson(response, 200, getStatus());
        return;
      }
      if (request.method === 'GET' && path === '/api/inventory') {
        sendJson(response, 200, getInventory());
        return;
      }
      if (request.method === 'GET' && files.has(path)) {
        const [name, contentType] = files.get(path);
        const bytes = await readFile(new URL(`../public/${name}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        response.end(bytes);
        return;
      }
      if (request.method === 'POST') {
        if (request.headers.origin !== localOrigin) {
          sendJson(response, 403, { error: '请求来源不正确' });
          return;
        }
        if (csrfToken !== null && request.headers['x-study-token'] !== csrfToken) {
          sendJson(response, 403, { error: '本机操作令牌无效' });
          return;
        }
        if (path === '/api/open') {
          await openBrowser();
          sendJson(response, 200, { ok: true });
          return;
        }
        if (path === '/api/classrooms') {
          sendJson(response, 200, { classrooms: await listClassrooms() });
          return;
        }
        if (path === '/api/start') {
          if (legacyRunnerDisabled) {
            sendJson(response, 503, { errorCode: 'LEGACY_RUNNER_DISABLED' });
            return;
          }
          const { url, maxVideos = 1, maxPages = 1, startPage = 1,
            replaceInterrupted = false } = await readJson(request);
          const listUrl = normalizeClassroomUrl(url);
          if (!Number.isInteger(maxVideos) || maxVideos < 1 || maxVideos > 3) {
            const error = new Error('一次最多试运行 3 条，请选择 1 到 3 条');
            error.statusCode = 400;
            throw error;
          }
          if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2
            || !Number.isInteger(startPage) || startPage < 1 || startPage > 1_000) {
            const error = new Error('试运行只能选择课程页码和最多连续 2 页');
            error.statusCode = 400;
            throw error;
          }
          if (typeof replaceInterrupted !== 'boolean') {
            const error = new Error('中断记录确认参数无效');
            error.statusCode = 400;
            throw error;
          }
          await start(listUrl, { maxVideos, maxPages, startPage,
            ...(replaceInterrupted ? { replaceInterrupted: true } : {}) });
          sendJson(response, 202, { ok: true, listUrl });
          return;
        }
        if (path === '/api/scan') {
          const { url } = await readJson(request);
          const listUrl = normalizeClassroomUrl(url);
          await scan(listUrl);
          sendJson(response, 202, { ok: true, listUrl });
          return;
        }
        if (path === '/api/stop') {
          await stop();
          sendJson(response, 200, { ok: true });
          return;
        }
      }
      sendJson(response, 404, { error: '找不到页面' });
    } catch (error) {
      const status = error.statusCode ?? (error.message.includes('头歌课堂') || error.message.includes('JSON') ? 400 : 500);
      sendJson(response, status, { error: error.message, ...(error instanceof RunError ? { errorCode: error.code } : {}) });
    }
  });
  return server;
}
