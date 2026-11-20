const elements = {
  localSingleVideoState: document.querySelector('#home-viewing-state'),
  version: document.querySelector('#app-version'),
  connection: document.querySelector('#local-connection'),
  browserInstruction: document.querySelector('#browser-instruction'),
  open: document.querySelector('#open'),
  loadClassrooms: document.querySelector('#load-classrooms'),
  classroomSelect: document.querySelector('#classroom-select'),
  classroomCurrent: document.querySelector('#classroom-current'),
  scan: document.querySelector('#scan'),
  stop: document.querySelector('#stop'),
  url: document.querySelector('#classroom-url'),
  formError: document.querySelector('#form-error'),
  courseMismatch: document.querySelector('#course-mismatch'),
  mismatchText: document.querySelector('#mismatch-text'),
  useSnapshotCourse: document.querySelector('#use-snapshot-course'),
  phase: document.querySelector('#phase'),
  page: document.querySelector('#page'),
  completed: document.querySelector('#completed'),
  error: document.querySelector('#error'),
  copyDiagnostic: document.querySelector('#copy-diagnostic'),
  inventoryEmpty: document.querySelector('#inventory-empty'),
  inventoryContent: document.querySelector('#inventory-content'),
  inventoryTitle: document.querySelector('#inventory-title'),
  inventoryUpdated: document.querySelector('#inventory-updated'),
  inventoryScope: document.querySelector('#inventory-scope'),
  inventoryCompleted: document.querySelector('#inventory-completed'),
  inventoryTotal: document.querySelector('#inventory-total'),
  inventoryPending: document.querySelector('#inventory-pending'),
  inventoryDone: document.querySelector('#inventory-done'),
  inventoryPages: document.querySelector('#inventory-pages'),
  inventoryRate: document.querySelector('#inventory-rate'),
  inventoryProgress: document.querySelector('#inventory-progress'),
  inventoryWarning: document.querySelector('#inventory-warning'),
  heatmapGrid: document.querySelector('#heatmap-grid'),
  heatmapTooltip: document.querySelector('#heatmap-tooltip'),
  heatmapTooltipTitle: document.querySelector('#heatmap-tooltip-title'),
  heatmapTooltipMeta: document.querySelector('#heatmap-tooltip-meta'),
};

let inventory = null;
function setControlLabel(button, fullName, shortName) {
  const full = button.querySelector('.control-full-name'), short = button.querySelector('.control-short-name');
  if (full && short) { full.textContent = fullName; short.textContent = shortName; }
  else button.textContent = fullName;
  button.setAttribute('aria-label', fullName);
}
let heatmapKey = '';
let selectedHeatCell = null;
let viewingSession = null;
let connectionEpoch = 0;
let activeHeatCell = null;
let activeHeatItem = null;
let hasSavedDraft = false;
let bootstrapPromise = null;
let latestStatus = null;
let loadingClassrooms = false;
let openingBrowser = false;
let localConnected = true;
let refreshing = false;
let bootstrapConfigured = false;
const DRAFT_KEY = 'educoder.study-control.draft.v1';
const currentCourseUrl = () => {
  const id = classroomId(elements.url.value.trim());
  return id ? `https://www.educoder.net/classrooms/${id}/video` : null;
};
function renderViewingSelection() {
  const selection = viewingSession?.selection;
  const active = selection?.courseUrl === inventory?.courseUrl && selection?.courseUrl === currentCourseUrl();
  for (const cell of elements.heatmapGrid.querySelectorAll('.heatmap-cell')) {
    const selected = active && Number(cell.dataset.page) === selection.page && Number(cell.dataset.index) === selection.index;
    cell.classList.toggle('is-current-selection', Boolean(selected));
    cell.setAttribute('aria-pressed', String(Boolean(selected)));
  }
}
if (typeof window.localManualVideo?.open === 'function') {
  window.localManualVideo.onClosed?.(result => {
    elements.localSingleVideoState.textContent = result?.discarded ? '本次未保存位置已放弃，原文件或较新记录保留。可重新选择观看。'
      : '本次播放已结束，位置已保存。';
  });
  window.localManualVideo.onSessionChanged?.(acceptViewingSession);
}

function viewingLocked() { return Boolean(viewingSession?.active || viewingSession?.viewerOpen || viewingSession?.opening || viewingSession?.closing); }
function acceptViewingSession(summary) {
  if (!summary || (Number.isSafeInteger(viewingSession?.revision) && Number.isSafeInteger(summary.revision)
    && summary.revision < viewingSession.revision)) return;
  viewingSession = summary;
  if (summary.version) {
    elements.version.textContent = `${summary.version} 只看进度版`;
    document.title = `头歌学习助手 · ${summary.version} 只看进度版`;
  }
  if (latestStatus) render(latestStatus); else renderViewingSelection();
}

const names = {
  idle: '等待打开头歌',
  ready: '专用浏览器已打开，请在头歌登录',
  'inventory-scanning': '正在扫描课程视频',
  'inventory-complete': '课程进度扫描完成',
  'inventory-partial': '课程进度仅扫描了部分页面',
  'inventory-stopped': '课程进度扫描已停止',
  stopping: '正在停止扫描',
  failed: '扫描暂停，需要处理',
};

const errorHints = {
  LOGIN_REQUIRED: '头歌登录可能已失效，请在官方页面重新登录。',
  CDN_TIMEOUT: '头歌页面资源加载超时，请稍后检查网络再重试。',
  PAGE_LOAD_FAILED: '头歌视频列表加载失败，请检查网络后再试。',
  LIST_UNAVAILABLE: '头歌视频列表暂时不可读取，请检查登录和网络。',
  TARGET_CHANGED: '视频位置或标题已变化，请重新读取官方进度。',
  SCAN_CHANGED: '课堂清单已变化，请重新读取官方进度。',
  SCAN_BUSY: '请等只读扫描结束后再打开视频。',
};

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    if (typeof draft?.url === 'string' && draft.url) {
      elements.url.value = draft.url;
      hasSavedDraft = true;
    }
  } catch {
    // The page remains usable if browser storage is disabled.
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ url: elements.url.value.trim() }));
  } catch {
    // Browsers can deny local storage without blocking scans.
  }
}

function clearFormError() {
  elements.formError.textContent = '';
  elements.formError.hidden = true;
}

function classroomId(input) {
  try {
    const url = new URL(input);
    if (url.origin !== 'https://www.educoder.net' || url.username || url.password) return null;
    return url.pathname.match(/^\/classrooms\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function updateMismatch() {
  renderViewingSelection();
  const inputId = classroomId(elements.url.value.trim());
  const savedId = classroomId(inventory?.courseUrl ?? '');
  const different = Boolean(inputId && savedId && inputId !== savedId);
  elements.courseMismatch.hidden = !different;
  elements.mismatchText.textContent = different
    ? `当前展示的是「${inventory.courseTitle || '另一课堂'}」的上次清单；扫描输入链接会替换它。`
    : '';
  if (latestStatus) render(latestStatus);
}

function render(status) {
  latestStatus = status;
  const cachedClassroom = inventory?.courseUrl === currentCourseUrl() && elements.classroomSelect.hidden;
  elements.classroomCurrent.hidden = !cachedClassroom;
  elements.classroomCurrent.textContent = cachedClassroom ? inventory.courseTitle || '当前课堂' : '';
  elements.classroomCurrent.title = elements.classroomCurrent.textContent;
  renderViewingSelection();
  elements.phase.textContent = status.officialWindowClosed
    ? '官方窗口已关闭，点击打开后可继续。' : names[status.phase] ?? status.phase;
  elements.page.textContent = status.pagesScanned ?? 0;
  elements.completed.textContent = status.itemsScanned ?? 0;
  elements.error.textContent = status.errorCode
    ? errorHints[status.errorCode] ?? `运行遇到未分类问题（编号 ${status.errorCode}）。`
    : status.error ?? '';
  elements.error.hidden = !elements.error.textContent;
  elements.copyDiagnostic.hidden = !elements.error.textContent;
  const active = ['inventory-scanning', 'stopping'].includes(status.phase);
  const sessionChanging = loadingClassrooms || openingBrowser;
  const locked = viewingLocked();
  elements.open.disabled = !localConnected || sessionChanging || locked;
  elements.scan.disabled = !localConnected || locked || active || sessionChanging || status.officialSessionOpen === false || !elements.url.value.trim();
  elements.loadClassrooms.disabled = !localConnected || locked || active || sessionChanging || status.officialSessionOpen === false;
  elements.classroomSelect.disabled = !localConnected || locked || active || sessionChanging;
  elements.url.disabled = !localConnected || locked || active || sessionChanging;
  elements.useSnapshotCourse.disabled = !localConnected || locked || active || sessionChanging;
  setControlLabel(elements.scan, status.phase === 'inventory-scanning' ? '正在读取进度…' : '刷新官方进度', status.phase === 'inventory-scanning' ? '读取中…' : '刷新进度');
  elements.stop.disabled = !localConnected || !active;
  elements.stop.hidden = !active;
}


function progressValue(item) {
  return Number.isFinite(item.progress) && item.progress >= 0 && item.progress <= 100 ? item.progress : null;
}

function makeText(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function heatRgb(progress) {
  if (progress === 0) return [255, 255, 255];
  if (progress === 100) return [23, 60, 140];
  // Uniform Oklab interpolation from white to the existing #173c8c endpoint.
  const amount = progress / 100;
  const lightness = 1 + (0.38238862322267636 - 1) * amount;
  const a = -0.01736007712069071 * amount, b = -0.13884446322035315 * amount;
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(channel => {
    const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, encoded)) * 255);
  });
}

function heatColor(progress) {
  return progress === null ? 'var(--heat-unknown-bg)' : `rgb(${heatRgb(progress).join(', ')})`;
}

function heatInk(progress) {
  if (progress === null) return 'var(--heat-unknown-ink)';
  const channels = heatRgb(progress).map(channel => {
    const encoded = channel / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000' : '#fff';
}

const heatLegend = document.querySelector('.heatmap-legend-scale');
if (heatLegend) heatLegend.style.backgroundImage = `linear-gradient(to right, ${Array.from({ length: 101 },
  (_, progress) => `${heatColor(progress)} ${progress}%`).join(', ')})`;

function resetHeatTooltip() {
  selectedHeatCell?.classList.remove('is-selected');
  selectedHeatCell?.setAttribute('aria-expanded', 'false');
  activeHeatCell?.setAttribute('aria-expanded', 'false');
  selectedHeatCell = null;
  activeHeatCell = null;
  activeHeatItem = null;
  elements.heatmapTooltip.hidden = true;
}

function showHeatTooltip(cell, item) {
  if (activeHeatCell && activeHeatCell !== cell) activeHeatCell.setAttribute('aria-expanded', 'false');
  activeHeatCell = cell;
  activeHeatItem = item;
  cell.setAttribute('aria-expanded', 'true');
  const value = progressValue(item);
  const state = value === null ? '待确认' : value === 100 ? '已完成' : value > 0 ? '进行中' : '未开始';
  elements.heatmapTooltipTitle.textContent = String(item.title);
  elements.heatmapTooltipMeta.textContent = `第 ${item.page} 页 · 第 ${item.index + 1} 条 · ${value === null ? '进度未知' : `${value}%`} · ${state}${item.confirmedThisSession ? ' · 本次官方确认' : ''}`;
  elements.heatmapTooltip.hidden = false;
  const rect = cell.getBoundingClientRect();
  const width = elements.heatmapTooltip.offsetWidth;
  const height = elements.heatmapTooltip.offsetHeight;
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 12), window.innerWidth - width - 12);
  const preferredTop = rect.top - height - 10 >= 12 ? rect.top - height - 10 : rect.bottom + 10;
  const top = Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8));
  elements.heatmapTooltip.style.left = `${left}px`;
  elements.heatmapTooltip.style.top = `${top}px`;
}

function hideHeatTooltip() {
  activeHeatCell?.setAttribute('aria-expanded', 'false');
  activeHeatCell = null;
  activeHeatItem = null;
  elements.heatmapTooltip.hidden = true;
}

function renderHeatmap(courseUrl, items) {
    const key = JSON.stringify([courseUrl, items.map(item => [item.page, item.index, item.title, item.progress, item.cardIdentity ?? null])]);
  if (key === heatmapKey) return;
  const focused = document.activeElement?.classList?.contains('heatmap-cell')
    ? { page: document.activeElement.dataset.page, index: document.activeElement.dataset.index }
    : null;
  const pinned = selectedHeatCell
    ? { page: selectedHeatCell.dataset.page, index: selectedHeatCell.dataset.index }
    : null;
  heatmapKey = key;
  resetHeatTooltip();
  elements.heatmapGrid.replaceChildren();
  if (items.length === 0) {
    elements.heatmapGrid.append(makeText('p', 'inventory-no-results', '已扫描页面暂时没有视频。请在官方窗口确认登录和课堂内容，再重试扫描。'));
    return;
  }

  const groups = new Map();
  const sorted = [...items].sort((a, b) => a.page - b.page || a.index - b.index);
  const columns = Math.max(1, ...sorted.map(item => item.index + 1));
  for (const item of sorted) {
    if (!groups.has(item.page)) groups.set(item.page, []);
    groups.get(item.page).push(item);
  }

  for (const [page, pageItems] of groups) {
    const row = document.createElement('div');
    row.className = 'heatmap-row';
    row.append(makeText('span', 'heatmap-page-label', `第 ${page} 页`));
    const cells = document.createElement('div');
    cells.className = 'heatmap-cells';
    cells.style.setProperty('--heat-columns', String(columns));
    for (const item of pageItems) {
      const value = progressValue(item);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `heatmap-cell ${value === null ? 'is-unknown' : value === 0 ? 'is-empty' : value === 100 ? 'is-complete' : 'is-partial'}`;
      cell.style.backgroundColor = heatColor(value);
      cell.style.setProperty('--heat-ink', heatInk(value));
      cell.dataset.progress = value === null ? '?' : String(value);
      if (value === null) cell.textContent = '?';
      cell.tabIndex = item === sorted[0] ? 0 : -1;
      cell.style.gridColumn = String(item.index + 1);
      cell.dataset.page = String(item.page);
      cell.dataset.index = String(item.index);
      const state = value === null ? '进度未知' : value === 100 ? '已完成' : value > 0 ? '进行中' : '未开始';
      cell.setAttribute('aria-label', `${item.title}，第 ${item.page} 页第 ${item.index + 1} 条，${value === null ? state : `完成度 ${value}%，${state}`}`);
      cell.setAttribute('aria-controls', 'heatmap-tooltip');
      cell.setAttribute('aria-describedby', 'heatmap-tooltip');
      cell.setAttribute('aria-expanded', 'false');
      cell.addEventListener('mouseenter', () => { if (!selectedHeatCell) showHeatTooltip(cell, item); });
      cell.addEventListener('mouseleave', () => { if (!selectedHeatCell && document.activeElement !== cell) hideHeatTooltip(); });
      cell.addEventListener('focus', () => {
        for (const button of elements.heatmapGrid.querySelectorAll('.heatmap-cell')) button.tabIndex = button === cell ? 0 : -1;
        if (selectedHeatCell && selectedHeatCell !== cell) resetHeatTooltip();
        showHeatTooltip(cell, item);
      });
      cell.addEventListener('keydown', event => {
        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); cell.click(); return; }
        if (event.key === 'Escape') { event.preventDefault(); resetHeatTooltip(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const rowItems = sorted.filter(candidate => candidate.page === item.page);
        const at = rowItems.indexOf(item);
        let next = event.key === 'Home' ? rowItems[0] : event.key === 'End' ? rowItems.at(-1)
          : event.key === 'ArrowLeft' ? rowItems[Math.max(0, at - 1)] : event.key === 'ArrowRight' ? rowItems[Math.min(rowItems.length - 1, at + 1)] : null;
        if (!next) {
          const pages = [...groups.keys()], pageAt = pages.indexOf(item.page);
          const page = pages[Math.max(0, Math.min(pages.length - 1, pageAt + (event.key === 'ArrowUp' ? -1 : 1)))];
          const candidates = sorted.filter(candidate => candidate.page === page);
          next = candidates.find(candidate => candidate.index === item.index) ?? candidates.at(-1);
        }
        const square = elements.heatmapGrid.querySelector(`[data-page="${next.page}"][data-index="${next.index}"]`);
        square?.focus({ preventScroll: true }); square?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      cell.addEventListener('blur', () => {
        if (selectedHeatCell === cell) resetHeatTooltip();
        else hideHeatTooltip();
      });
      cell.addEventListener('click', event => {
        event.stopPropagation();
        if (!localConnected || ['inventory-scanning', 'stopping'].includes(latestStatus?.phase)) return;
        if (typeof window.localManualVideo?.open !== 'function' || inventory?.complete !== true || courseUrl !== currentCourseUrl()) {
          if (selectedHeatCell === cell) { resetHeatTooltip(); return; }
          resetHeatTooltip();selectedHeatCell=cell;cell.classList.add('is-selected');cell.setAttribute('aria-expanded','true');showHeatTooltip(cell,item);return;
        }
        resetHeatTooltip();
        const selection = { courseUrl, page: item.page, index: item.index, title: item.title,
          ...(item.cardIdentity ? { cardIdentity: item.cardIdentity } : {}) };
        elements.localSingleVideoState.textContent = '';
        window.localManualVideo.open(selection).catch(error => {
          elements.localSingleVideoState.textContent = operationHint(error);
        });
      });
      cells.append(cell);
    }
    row.append(cells, makeText('span', 'heatmap-row-count', `${pageItems.filter(item => progressValue(item) === 100).length}/${pageItems.length}`));
    elements.heatmapGrid.append(row);
  }

  const findCell = key => [...elements.heatmapGrid.querySelectorAll('.heatmap-cell')]
    .find(cell => cell.dataset.page === key.page && cell.dataset.index === key.index);
  if (focused) findCell(focused)?.focus({ preventScroll: true });
  if (pinned) {
    const cell = findCell(pinned);
    const item = sorted.find(candidate => String(candidate.page) === pinned.page && String(candidate.index) === pinned.index);
    if (cell && item) {
      selectedHeatCell = cell;
      cell.classList.add('is-selected');
      cell.setAttribute('aria-expanded', 'true');
      showHeatTooltip(cell, item);
    }
  }
}

function renderInventory(snapshot, status) {
  inventory = snapshot;
  elements.inventoryEmpty.hidden = Boolean(snapshot);
  elements.inventoryContent.hidden = !snapshot;
  if (!snapshot) {
    heatmapKey = '';
    resetHeatTooltip();
    elements.heatmapGrid.replaceChildren();
    updateMismatch();
    return;
  }

  if (!hasSavedDraft && !elements.url.value && snapshot.courseUrl) {
    elements.url.value = snapshot.courseUrl;
    hasSavedDraft = true;
    saveDraft();
  }

  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const completed = items.filter(item => progressValue(item) === 100).length;
  const pending = items.length - completed;
  const rate = items.length ? Math.round(completed / items.length * 100) : 0;
  elements.inventoryTitle.textContent = snapshot.courseTitle || snapshot.courseUrl || '未命名课堂';
  elements.inventoryUpdated.textContent = snapshot.scannedAt
    ? `更新于 ${new Date(snapshot.scannedAt).toLocaleString('zh-CN')}`
    : status.phase === 'inventory-scanning' ? '正在扫描，结果持续更新' : '已保留上次扫描结果；可重新扫描更新';
  elements.inventoryScope.textContent = snapshot.complete ? '全课程视频' : '仅已扫描视频';
  elements.inventoryScope.classList.toggle('is-partial', !snapshot.complete);
  elements.inventoryCompleted.textContent = completed;
  elements.inventoryTotal.textContent = items.length;
  elements.inventoryPending.textContent = pending;
  elements.inventoryDone.textContent = completed;
  elements.inventoryPages.textContent = snapshot.pagesScanned;
  elements.inventoryRate.textContent = `${rate}%`;
  elements.inventoryProgress.value = rate;
  const retained = snapshot.complete && status.retainedPrevious;
  const oldSnapshot = snapshot.complete &&
    ['inventory-scanning', 'inventory-partial', 'inventory-stopped'].includes(status.phase) &&
    status.itemsScanned === 0;
  elements.inventoryWarning.hidden = snapshot.complete && !oldSnapshot && !retained;
  elements.inventoryWarning.textContent = retained
    ? `本次扫描在 ${status.pagesScanned} 页后停止；仍显示上次完整清单。`
    : oldSnapshot
    ? `本次扫描尚未取得视频，以下仍是上次扫描结果。${status.error ?? '请等待本次扫描。'}`
    : snapshot.complete ? '' :
      `仅扫描了 ${snapshot.pagesScanned} 页，后续页面尚未确认。${snapshot.error ?? (snapshot.stopped ? '扫描已停止。' : '扫描进行中。')}`;
  renderHeatmap(snapshot.courseUrl, items);
  updateMismatch();
}

function loadBootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = fetch('/api/bootstrap', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('本机控制台连接异常，请刷新页面重试');
      return response.json();
    }).catch(error => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

function connectionLost() {
  ++connectionEpoch;
  localConnected = false;
  bootstrapPromise = null;
  bootstrapConfigured = false;
  elements.connection.hidden = false;
  elements.connection.textContent = '本机控制服务暂未连接。请等连接恢复，或关闭并重新打开主程序；已保存的位置保留，不会自动开始任务。';
  if (latestStatus) render(latestStatus);
  else for (const button of [elements.open, elements.loadClassrooms, elements.scan]) button.disabled = true;
}

async function localRead(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try { return await fetch(url, { cache: 'no-store', signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function operationHint(error) {
  return errorHints[error.message] ?? (error.name === 'TypeError' || error.name === 'AbortError'
    ? '本机连接暂不可用，请等连接恢复或重开主程序；已保存位置保留。'
    : error.message);
}

async function request(path, body = {}) {
  const { csrfToken } = await loadBootstrap();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-Study-Token': csrfToken } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.errorCode ?? data.error ?? '操作失败');
  return data;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const epoch = connectionEpoch;
  try {
    const [statusResponse, inventoryResponse, sessionSummary] = await Promise.all([
      localRead('/api/status'),
      localRead('/api/inventory'),
      window.localManualVideo?.session?.(),
    ]);
    if (!statusResponse.ok || !inventoryResponse.ok) throw new Error('无法读取状态');
    const status = await statusResponse.json(), snapshot = await inventoryResponse.json();
    if (epoch !== connectionEpoch) return;
    acceptViewingSession(sessionSummary ?? status.viewingSession);
    localConnected = true; elements.connection.hidden = true;
    render(status);
    renderInventory(snapshot, status);
    if (!bootstrapConfigured) configureBootstrap();
  } catch { if (epoch === connectionEpoch) connectionLost(); }
  finally { refreshing = false; }
}

async function runAction(path, body) {
  if (!localConnected || (viewingLocked() && path !== '/api/stop')) return;
  ++connectionEpoch;
  clearFormError();
  try {
    await request(path, body);
    await refresh();
  } catch (error) {
    elements.formError.textContent = operationHint(error);
    elements.formError.hidden = false;
    if (error.name === 'TypeError' || error.name === 'AbortError') connectionLost();
  }
}

elements.open.addEventListener('click', async () => {
  openingBrowser = true;
  if (latestStatus) render(latestStatus);
  else {
    elements.open.disabled = true;
    elements.scan.disabled = true;
    elements.loadClassrooms.disabled = true;
    elements.classroomSelect.disabled = true;
  }
  try { await runAction('/api/open'); }
  finally {
    openingBrowser = false;
    if (latestStatus) render(latestStatus);
  }
});
elements.loadClassrooms.addEventListener('click', async () => {
  clearFormError();
  loadingClassrooms = true;
  if (latestStatus) render(latestStatus);
  else {
    elements.loadClassrooms.disabled = true;
    elements.scan.disabled = true;
    elements.classroomSelect.disabled = true;
  }
  elements.loadClassrooms.textContent = '正在读取我的课堂…';
  try {
    const { classrooms } = await request('/api/classrooms');
    if (!Array.isArray(classrooms)) throw new Error('头歌课堂列表格式异常');
    elements.classroomSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '请选择已加入的课堂';
    elements.classroomSelect.append(placeholder);
    for (const classroom of classrooms) {
      if (typeof classroom.title !== 'string' || !classroomId(classroom.url)) {
        throw new Error('头歌课堂列表含有无效条目');
      }
      const option = document.createElement('option');
      option.value = classroom.url;
      option.textContent = classroom.title;
      elements.classroomSelect.append(option);
    }
    elements.classroomSelect.hidden = classrooms.length === 0;
    if (classrooms.length === 0) throw new Error('我的课堂暂无可选课程，可手动粘贴链接');
  } catch (error) {
    elements.classroomSelect.hidden = true;
    elements.formError.textContent = operationHint(error);
    elements.formError.hidden = false;
    if (error.name === 'TypeError' || error.name === 'AbortError') connectionLost();
  } finally {
    loadingClassrooms = false;
    elements.loadClassrooms.textContent = '读取我的课堂';
    if (latestStatus) render(latestStatus);
  }
});
elements.classroomSelect.addEventListener('change', async () => {
  const url = elements.classroomSelect.value;
  if (!url) return;
  elements.url.value = url;
  hasSavedDraft = true;
  saveDraft();
  updateMismatch();
  elements.localSingleVideoState.textContent = '';
  await runAction('/api/scan', { url });
});
elements.scan.addEventListener('click', () => runAction('/api/scan', { url: elements.url.value.trim() }));
elements.stop.addEventListener('click', () => runAction('/api/stop'));
elements.copyDiagnostic.addEventListener('click', async () => {
  const summary = {
    phase: latestStatus?.phase ?? 'unknown',
    errorCode: latestStatus?.errorCode ?? 'UNCLASSIFIED',
    checkedAt: new Date().toISOString(),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
    elements.copyDiagnostic.textContent = '已复制脱敏摘要';
  } catch {
    elements.copyDiagnostic.textContent = '复制失败，请检查剪贴板权限';
  }
});
elements.url.addEventListener('input', () => {
  hasSavedDraft = true;
  saveDraft();
  clearFormError();
  updateMismatch();
});
elements.useSnapshotCourse.addEventListener('click', () => {
  if (!inventory?.courseUrl) return;
  elements.url.value = inventory.courseUrl;
  hasSavedDraft = true;
  saveDraft();
  clearFormError();
  updateMismatch();
});
document.addEventListener('click', event => {
  if (!event.target.closest('.heatmap-cell')) resetHeatTooltip();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') resetHeatTooltip();
});
window.addEventListener('resize', resetHeatTooltip);
window.addEventListener('scroll', () => {
  if (!elements.heatmapTooltip.hidden && activeHeatCell?.isConnected && activeHeatItem) {
    showHeatTooltip(activeHeatCell, activeHeatItem);
  }
}, true);
restoreDraft();
function configureBootstrap() {
  return loadBootstrap().then(() => { bootstrapConfigured = true; }).catch(connectionLost);
}
configureBootstrap();
refresh();
setInterval(refresh, 2_000);
