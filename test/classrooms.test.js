import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMyClassrooms } from '../src/classrooms.js';

function course(name, identifier, accessible = true) {
  return { name, identifier, is_accessible: accessible };
}

function apiResponse(page, courses, total, status = 200) {
  const request = {};
  return {
    url: () => `https://data.educoder.net/api/courses.json?page=${page}&limit=1&order=mine`,
    status: () => status,
    request: () => request,
    json: async () => ({ courses, courses_count: total }),
  };
}

function classroomPage(responses, staleResponse = null) {
  const actions = [];
  const requestListeners = new Set();
  let waiter = null;
  async function click(label) {
    actions.push(label);
    const response = responses.shift();
    assert.ok(response, 'a classroom request was available');
    for (const listener of requestListeners) listener(response.request());
    if (waiter && waiter.predicate(response)) {
      waiter.resolve(response);
      waiter = null;
    }
  }
  return {
    actions,
    goto: async url => { actions.push(`goto:${url}`); },
    url: () => 'https://www.educoder.net/classrooms',
    on: (name, listener) => { if (name === 'request') requestListeners.add(listener); },
    off: (name, listener) => { if (name === 'request') requestListeners.delete(listener); },
    getByText(label) {
      return {
        waitFor: async () => {},
        click: async () => click(`tab:${label}`),
        evaluate: async () => false,
      };
    },
    waitForResponse: predicate => new Promise(resolve => {
      waiter = { predicate, resolve };
      if (staleResponse) {
        const prior = staleResponse;
        staleResponse = null;
        if (predicate(prior)) {
          waiter = null;
          resolve(prior);
        }
      }
    }),
    locator: () => ({ last: () => ({
      isVisible: async () => true,
      getAttribute: async () => '',
      click: async () => click('next-page'),
    }) }),
  };
}

test('reads only my accessible classrooms and produces validated official video URLs', async () => {
  const page = classroomPage([apiResponse(1, [
    course('离散数学', 'demo8cls'),
    course('无权访问', 'hidden', false),
  ], 2)]);
  const classrooms = await listMyClassrooms(page);
  assert.deepEqual(classrooms, [
    { title: '离散数学', url: 'https://www.educoder.net/classrooms/demo8cls/video' },
  ]);
  assert.deepEqual(page.actions, ['goto:https://www.educoder.net/classrooms', 'tab:我的']);
});

test('reads later mine pages rather than silently omitting joined classrooms', async () => {
  const page = classroomPage([
    apiResponse(1, [course('第一课', 'first')], 2),
    apiResponse(2, [course('第二课', 'second')], 2),
  ]);
  assert.deepEqual(await listMyClassrooms(page), [
    { title: '第一课', url: 'https://www.educoder.net/classrooms/first/video' },
    { title: '第二课', url: 'https://www.educoder.net/classrooms/second/video' },
  ]);
  assert.deepEqual(page.actions, ['goto:https://www.educoder.net/classrooms', 'tab:我的', 'next-page']);
});

test('rejects malformed classroom identifiers instead of offering an unsafe link', async () => {
  const page = classroomPage([apiResponse(1, [course('异常课', 'bad/../path')], 1)]);
  await assert.rejects(listMyClassrooms(page), error => error.code === 'LIST_UNAVAILABLE');
});

test('rejects a classroom response containing more items than the declared total', async () => {
  const page = classroomPage([apiResponse(1, [course('第一课', 'first'), course('第二课', 'second')], 1)]);
  await assert.rejects(listMyClassrooms(page), error => error.code === 'LIST_UNAVAILABLE');
});

test('reports an expired official session immediately when the mine request is unauthorized', async () => {
  const page = classroomPage([apiResponse(1, [], 0, 401)]);
  await assert.rejects(listMyClassrooms(page), error => error.code === 'LOGIN_REQUIRED');
});

test('a failed mine click does not leave an unhandled response wait', async () => {
  const page = classroomPage([]);
  page.getByText = () => ({
    waitFor: async () => {},
    evaluate: async () => false,
    click: async () => { throw new Error('click failed'); },
  });
  page.waitForResponse = () => new Promise((_, reject) => {
    setTimeout(() => reject(new Error('response wait timed out')), 10);
  });
  await assert.rejects(listMyClassrooms(page), error => error.code === 'LIST_UNAVAILABLE');
  await new Promise(resolve => setTimeout(resolve, 30));
});

test('ignores a matching response from a request started before the mine click', async () => {
  const stale = apiResponse(1, [course('过期课', 'old')], 1);
  const fresh = apiResponse(1, [course('当前课', 'current')], 1);
  const page = classroomPage([fresh], stale);
  assert.deepEqual(await listMyClassrooms(page), [
    { title: '当前课', url: 'https://www.educoder.net/classrooms/current/video' },
  ]);
});

test('reports invalid JSON from the official list as unavailable, without raw response text', async () => {
  const invalid = apiResponse(1, [], 0);
  invalid.json = async () => { throw new SyntaxError('private server response'); };
  await assert.rejects(listMyClassrooms(classroomPage([invalid])), error =>
    error.code === 'LIST_UNAVAILABLE' && !error.message.includes('private server response'));
});
