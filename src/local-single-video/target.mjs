import { createHash } from 'node:crypto';
import { normalizeClassroomUrl } from '../course.js';

export const LEGACY_TARGET = Object.freeze({ classroomId: 'SyntheticAcceptance', title: '模拟单视频', page: 1, index: 0 });
export function normalizeTarget(value) {
  if (!value || !/^[A-Za-z0-9_-]{1,80}$/.test(value.classroomId)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 1000
    || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 10000
    || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 5000) throw new Error('TARGET_INVALID');
  const target = { classroomId: value.classroomId, title: value.title.trim(), page: value.page, index: value.index };
  if (value.cardIdentity != null) {
    const url = new URL(value.cardIdentity);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || value.cardIdentity.length > 4096) throw new Error('TARGET_INVALID');
    target.cardIdentity = url.href;
  }
  return target;
}
export const targetUrl = target => `https://www.educoder.net/classrooms/${normalizeTarget(target).classroomId}/video`;
export function sameTarget(value, expected = LEGACY_TARGET) {
  return value?.classroomId === expected.classroomId && value?.title === expected.title
    && value?.page === expected.page && value?.index === expected.index
    && (!expected.cardIdentity || value?.cardIdentity === expected.cardIdentity);
}
export function targetKey(value) {
  const target = normalizeTarget(value);
  return createHash('sha256').update(JSON.stringify([target.classroomId, target.page, target.index, target.title])).digest('hex');
}
export function resolveScannedSelection(snapshot, selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || Object.keys(selection).some(key => !['courseUrl', 'page', 'index', 'title', 'cardIdentity'].includes(key))) throw new Error('TARGET_INVALID');
  const courseUrl = normalizeClassroomUrl(selection.courseUrl);
  if (selection.courseUrl !== courseUrl || snapshot?.courseUrl !== courseUrl || !Array.isArray(snapshot.items)) throw new Error('SCAN_CHANGED');
  const classroomId = new URL(courseUrl).pathname.split('/')[2];
  const requested = normalizeTarget({ ...selection, classroomId });
  const matches = snapshot.items.filter(item => item.page === requested.page && item.index === requested.index);
  if (matches.length !== 1 || matches[0].title !== requested.title
    || (matches[0].cardIdentity ?? null) !== (requested.cardIdentity ?? null)) throw new Error('SCAN_CHANGED');
  const pageLayout = snapshot.items.filter(item => item.page === requested.page).sort((a, b) => a.index - b.index)
    .map((item, index) => {
      if (item.index !== index || typeof item.title !== 'string' || !item.title.trim()) throw new Error('SCAN_CHANGED');
      return { index, title: item.title, ...(item.cardIdentity ? { cardIdentity: item.cardIdentity } : {}) };
    });
  return { ...requested, courseTitle: typeof snapshot.courseTitle === 'string' ? snapshot.courseTitle.slice(0, 500) : '所选课堂', pageLayout };
}
export function verifyPageSelection(target, pageNumber, cards, expectedLayout) {
  const card = cards[target.index];
  if (pageNumber !== target.page || !card || card.title !== target.title
    || (target.cardIdentity && target.cardIdentity !== card.cardIdentity)) throw new Error('TARGET_CHANGED');
  if (expectedLayout && (cards.length !== expectedLayout.length || cards.some((item, index) =>
    item.index !== index || item.title !== expectedLayout[index].title
    || (expectedLayout[index].cardIdentity && item.cardIdentity !== expectedLayout[index].cardIdentity)))) throw new Error('TARGET_CHANGED');
  return card;
}
export function playerIdentity(urlValue, target) {
  const url = new URL(urlValue);
  if (url.origin !== 'https://www.educoder.net' || url.username || url.password) throw new Error('PLAYER_CHANGED');
  const identifiers = {};
  for (const name of ['video_id', 'new_video_id', 'videoId', 'course_id', 'classroom_id', 'classroomId']) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1 || (values.length && !/^[A-Za-z0-9_-]{1,80}$/.test(values[0]))) throw new Error('PLAYER_CHANGED');
    if (values.length) identifiers[name] = values[0];
  }
  const inPath = url.pathname.match(/^\/classrooms\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
  if (inPath && inPath !== target.classroomId) throw new Error('PLAYER_CHANGED');
  return { pathname: url.pathname, identifiers };
}
