import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCards, normalizeClassroomUrl } from '../src/course.js';

function cardNode(title, progress) {
  return {
    querySelector(selector) {
      if (selector === '[class*="bottomTitle"]') return { textContent: title };
      if (selector === '[role="progressbar"]') return { getAttribute: () => String(progress) };
      return null;
    },
  };
}

test('reads card title, progress and stable position in visible order', () => {
  assert.deepEqual(extractCards([cardNode('已完成', 100), cardNode('待看', 0)]), [
    { title: '已完成', progress: 100, index: 0 },
    { title: '待看', progress: 0, index: 1 },
  ]);
});

test('rejects a card without a readable progress value', () => {
  assert.throws(() => extractCards([cardNode('异常视频', 'unknown')]), /progress/);
});

test('accepts only a head song classroom URL and normalizes it to the video list', () => {
  assert.equal(
    normalizeClassroomUrl('https://www.educoder.net/classrooms/demo8cls/announcement'),
    'https://www.educoder.net/classrooms/demo8cls/video',
  );
  assert.throws(() => normalizeClassroomUrl('https://example.org/classrooms/demo8cls/video'), /头歌课堂/);
  assert.throws(() => normalizeClassroomUrl('https://www.educoder.net/paths/abzg2tpe'), /头歌课堂/);
  assert.throws(() => normalizeClassroomUrl('https://user:secret@www.educoder.net/classrooms/demo8cls/video'), /头歌课堂/);
});
