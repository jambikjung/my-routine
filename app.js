(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const main = $('#appMain');
  const modal = $('#modal');
  const toast = $('#toast');
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const COLOR_SKINS = [
    { id: 'green', name: '초록', primary: '#17665b' },
    { id: 'blue', name: '하늘', primary: '#4f739f' },
    { id: 'purple', name: '라벤더', primary: '#78649a' },
    { id: 'rose', name: '분홍', primary: '#ad6478' },
    { id: 'amber', name: '살구', primary: '#a87835' }
  ];
  const STORE_KEY = 'routine-state-v1';
  const today = () => dateKey(new Date());
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const freshState = () => ({
    version: 1, routines: [], entries: [], templates: [], onboardingDone: false,
    settings: { colorSkin: 'green', summaryEnabled: false, summaryTime: '07:00', lastExternalBackup: null, lastNotifiedDate: null }
  });
  let state = freshState();
  let currentView = 'today';
  let selectedDate = today();
  let weekOffset = 0;
  let chartMode = 'summary';
  let toastTimer;
  let db;
  let installPrompt = null;

  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function fromKey(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 12); }
  function addDays(key, count) { const d = fromKey(key); d.setDate(d.getDate() + count); return dateKey(d); }
  function dayDiff(a, b) { return Math.round((fromKey(b) - fromKey(a)) / 86400000); }
  function startOfWeek(key) { const d = fromKey(key); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateKey(d); }
  function fmtDate(key, options = {}) {
    return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', ...options }).format(fromKey(key));
  }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  }
  function save() {
    state.savedAt = new Date().toISOString();
    try {
      if (db) {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(state, STORE_KEY);
      } else localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (error) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
      catch { showToast('저장 공간이 부족해요. 백업 파일을 내려받아 주세요.'); }
    }
    try {
      const backupKey = 'routine-state-backups-v1';
      const history = JSON.parse(localStorage.getItem(backupKey) || '[]');
      history.unshift({ savedAt: state.savedAt, data: JSON.stringify(state) });
      localStorage.setItem(backupKey, JSON.stringify(history.slice(0, 3)));
    } catch { /* 브라우저 저장 공간이 부족하면 내부 복구 사본을 생략합니다. */ }
  }
  function loadState() {
    return new Promise(resolve => {
      if (!('indexedDB' in window)) {
        try { state = { ...freshState(), ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch { state = freshState(); }
        return resolve();
      }
      const req = indexedDB.open('my-routine-local', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => {
        try { state = { ...freshState(), ...JSON.parse(localStorage.getItem(STORE_KEY) || backupState() || '{}') }; } catch { state = freshState(); }
        resolve();
      };
      req.onsuccess = () => {
        db = req.result;
        const get = db.transaction('kv', 'readonly').objectStore('kv').get(STORE_KEY);
        get.onerror = () => resolve();
        get.onsuccess = () => {
          const recovered = get.result || (backupState() ? JSON.parse(backupState()) : null);
          state = recovered ? { ...freshState(), ...recovered, settings: { ...freshState().settings, ...(recovered.settings || {}) } } : freshState();
          resolve();
        };
      };
    });
  }
  function applySkin() {
    const skin = COLOR_SKINS.find(item => item.id === state.settings?.colorSkin) || COLOR_SKINS[0];
    document.documentElement.dataset.skin = skin.id;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = skin.primary;
  }
  function backupState() {
    try { return JSON.parse(localStorage.getItem('routine-state-backups-v1') || '[]')[0]?.data || null; }
    catch { return null; }
  }

  function isScheduled(routine, key) {
    if (key < (routine.startDate || '0000-01-01') || (routine.endDate && key > routine.endDate)) return false;
    if (routine.retiredOn && key >= routine.retiredOn) return false;
    if ((routine.exceptions || []).includes(key)) return false;
    const day = fromKey(key).getDay();
    if ((routine.restWeekdays || []).includes(day)) return false;
    const start = routine.startDate || key;
    const diff = dayDiff(start, key);
    if (diff < 0) return false;
    const rule = routine.rule || { type: 'daily', every: 1 };
    if (rule.type === 'weekly') return ((rule.weekdays || []).includes(day)) && Math.floor(diff / 7) % (rule.every || 1) === 0;
    if (rule.type === 'monthly') {
      const a = fromKey(start), b = fromKey(key);
      const months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
      if (months < 0 || months % (rule.every || 1) !== 0) return false;
      const target = Math.min(a.getDate(), new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate());
      return b.getDate() === target;
    }
    const interval = Math.max(1, Number(rule.every || 1)) * (rule.type === 'weeks' ? 7 : 1);
    return diff % interval === 0;
  }
  function entryForRoutine(routine, key) {
    return state.entries.find(e => e.kind === 'routine' && e.routineId === routine.id && e.date === key);
  }
  function ensureRange(startKey, endKey) {
    let changed = false;
    for (const routine of state.routines) {
      if (!routine.startDate) routine.startDate = today();
      const start = startKey < routine.startDate ? routine.startDate : startKey;
      for (let key = start; key <= endKey; key = addDays(key, 1)) {
        if (!isScheduled(routine, key) || entryForRoutine(routine, key)) continue;
        state.entries.push({ id: uid(), kind: 'routine', routineId: routine.id, date: key, name: routine.name, done: false, order: routine.order || 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        changed = true;
      }
    }
    if (changed) save();
  }
  function entriesFor(key) {
    ensureRange(key, key);
    return state.entries.filter(e => e.date === key).sort((a, b) => Number(a.done) - Number(b.done) || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ko'));
  }
  function getEntry(id) { return state.entries.find(e => e.id === id); }

  function openModal(html, onOpen) {
    modal.innerHTML = `<div class="modal-content">${html}</div>`;
    modal.showModal();
    onOpen?.();
  }
  function closeModal() { if (modal.open) modal.close(); }
  function modalFooter(primaryText = '저장') {
    return `<div class="modal-footer"><button class="button-secondary" type="button" data-action="close-modal">취소</button><button class="button" type="submit">${primaryText}</button></div>`;
  }
  function dayChecks(name, selected = []) {
    return `<div class="weekday-picks">${DAYS.map((d, i) => `<label><input type="checkbox" name="${name}" value="${i}" ${selected.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>`;
  }
  function render() {
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === currentView));
    if (currentView === 'today') renderToday();
    else if (currentView === 'weekly') renderWeekly();
    else if (currentView === 'manage') renderManage();
    else renderSettings();
  }
  function backupDue() {
    const last = state.settings.lastExternalBackup;
    if (!last) return true;
    return Date.now() - new Date(last).getTime() >= 7 * 86400000;
  }
  function backupBanner() {
    return backupDue() ? `<div class="backup-banner"><span aria-hidden="true">↗</span><span>외부 백업을 한 지 7일이 지났어요.</span><button type="button" data-action="go-backup">백업하기</button></div>` : '';
  }
  function renderToday() {
    const key = today(); selectedDate = key;
    const rows = entriesFor(key);
    const undone = rows.filter(e => !e.done), done = rows.filter(e => e.done);
    const countLabel = `<div class="progress-summary"><strong>완료 ${done.length}개 / 전체 ${rows.length}개</strong><span>${rows.length ? `${done.length}개 완료` : '오늘의 기록'}</span></div>`;
    const rowHtml = e => `<div class="task-row ${e.done ? 'done' : ''}" draggable="true" data-entry="${esc(e.id)}">
      <span class="drag-handle" title="끌어서 순서 변경" aria-label="순서 변경">⠿</span>
      <input class="task-check" type="checkbox" data-action="toggle-entry" data-id="${esc(e.id)}" ${e.done ? 'checked' : ''} aria-label="${esc(e.name)} 완료">
      <span class="task-name">${esc(e.name)}</span><span class="task-kind">${e.kind === 'routine' ? '반복 일과' : '개인 할 일'}</span>
      <button class="order-button" data-action="move-entry" data-id="${esc(e.id)}" data-direction="-1" type="button" aria-label="위로 이동">↑</button><button class="order-button" data-action="move-entry" data-id="${esc(e.id)}" data-direction="1" type="button" aria-label="아래로 이동">↓</button>
      <button class="small-button" data-action="edit-entry" data-id="${esc(e.id)}" type="button" aria-label="${esc(e.name)} 수정">수정</button>
    </div>`;
    main.innerHTML = `${backupBanner()}<div class="page-heading"><div><p class="eyebrow">오늘의 성장</p><h1>오늘의 할 일</h1><p class="date-label">${fmtDate(key)}</p></div></div>
      ${countLabel}
      ${rows.length ? `<p class="task-section-label">아직 남은 일 ${undone.length}</p><div class="task-list" data-group="open">${undone.map(rowHtml).join('') || '<p class="muted">남은 일이 없어요.</p>'}
      </div>${done.length ? `<p class="task-section-label">완료한 일 ${done.length}</p><div class="task-list" data-group="done">${done.map(rowHtml).join('')}</div>` : ''}
      ${undone.length === 0 ? `<div class="card" style="margin-top:18px;text-align:center;color:var(--green)"><strong>오늘의 할 일을 모두 완료했습니다! 🌱</strong></div>` : ''}`
      : `<div class="card empty-state"><div class="sprout">🌱</div><strong>오늘 예정된 할 일이 없습니다.</strong><span class="muted">작은 일부터 하나씩 시작해 보세요.</span><div style="margin-top:15px"><button class="button" data-action="add-task" type="button">할 일 추가</button></div></div>`}
      <button class="add-fab" data-action="add-task" type="button" aria-label="할 일 추가">+</button>`;
    if (!state.onboardingDone) setTimeout(showOnboarding, 0);
  }
  function weekKeys(offset = 0) {
    const start = addDays(startOfWeek(today()), offset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  function weeklyStats(keys) {
    ensureRange(keys[0], keys[6]);
    const entries = state.entries.filter(e => e.date >= keys[0] && e.date <= keys[6]);
    const done = entries.filter(e => e.done).length;
    return { entries, done, total: entries.length, missed: entries.length - done, rate: entries.length ? Math.round(done / entries.length * 100) : null };
  }
  function renderCalendar(monthDate, selected) {
    const y = monthDate.getFullYear(), m = monthDate.getMonth();
    const first = new Date(y, m, 1, 12), days = new Date(y, m + 1, 0).getDate();
    const offset = (first.getDay() + 6) % 7;
    const start = dateKey(new Date(y, m, 1 - offset, 12));
    const total = Math.ceil((offset + days) / 7) * 7;
    const recordDates = new Set(state.entries.map(e => e.date));
    for (let i = 0; i < total; i++) {
      const key = addDays(start, i);
      if (key >= state.routines.reduce((min, r) => !min || r.startDate < min ? r.startDate : min, today())) ensureRange(key, key);
    }
    for (const e of state.entries) recordDates.add(e.date);
    return `<div class="calendar-head"><button class="small-button" data-action="month-prev" type="button" aria-label="이전 달">‹</button><strong>${y}년 ${m + 1}월</strong><button class="small-button" data-action="month-next" type="button" aria-label="다음 달">›</button></div>
      <div class="calendar-grid">${['월','화','수','목','금','토','일'].map(d => `<span class="weekday">${d}</span>`).join('')}
      ${Array.from({ length: total }, (_, i) => {
        const key = addDays(start, i), d = fromKey(key), inMonth = d.getMonth() === m;
        return `<button class="calendar-day ${inMonth ? '' : 'outside'} ${key === selected ? 'selected' : ''} ${key === today() ? 'today' : ''} ${recordDates.has(key) ? 'has-record' : ''}" data-action="select-date" data-date="${key}" type="button" ${inMonth ? '' : 'style="opacity:.32"'} aria-label="${fmtDate(key)}">${d.getDate()}</button>`;
      }).join('')}</div>`;
  }
  function routineStreak(routine) {
    let run = 0, cursor = today();
    ensureRange(routine.startDate, today());
    while (cursor >= routine.startDate && cursor >= (routine.retiredOn || '0000-00-00')) {
      if (isScheduled(routine, cursor)) {
        const entry = entryForRoutine(routine, cursor);
        if (entry?.done) run++; else break;
      }
      cursor = addDays(cursor, -1);
    }
    return run;
  }
  function chartSvg() {
    const end = addDays(startOfWeek(today()), 6), start = addDays(end, -25 * 7 - 6);
    ensureRange(start, end);
    const points = [];
    for (let i = 0; i < 26; i++) {
      const weekStart = addDays(startOfWeek(start), i * 7), weekEnd = addDays(weekStart, 6);
      const rows = state.entries.filter(e => e.date >= weekStart && e.date <= weekEnd);
      if (rows.length) points.push({ weekStart, rate: Math.round(rows.filter(e => e.done).length / rows.length * 100) });
    }
    if (!points.length) return `<div class="empty-chart">기록이 쌓이면 최근 26주의 변화가 여기에 보여요.</div>`;
    const w = 600, h = 190, pad = 24;
    const coords = points.map((p, i) => ({ ...p, x: points.length === 1 ? w / 2 : pad + i * (w - pad * 2) / (points.length - 1), y: h - pad - p.rate * (h - pad * 2) / 100 }));
    const line = coords.map(p => `${p.x},${p.y}`).join(' ');
    const grid = [0, 25, 50, 75, 100].map(v => { const y = h - pad - v * (h - pad * 2) / 100; return `<line x1="${pad}" x2="${w-pad}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="1" y="${y+4}" fill="var(--muted)" font-size="11">${v}%</text>`; }).join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="최근 ${points.length}주 완료율 추이">${grid}<polyline points="${line}" fill="none" stroke="var(--green)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${coords.map(p => `<circle class="chart-point" cx="${p.x}" cy="${p.y}" r="6" fill="var(--green)" data-action="chart-week" data-date="${p.weekStart}" tabindex="0"><title>${fmtDate(p.weekStart)} 주 ${p.rate}%</title></circle>`).join('')}</svg><div class="chart-labels"><span>${fmtDate(points[0].weekStart, { month: 'short', day: 'numeric' })}</span><span>최근 26주 · 점을 누르면 해당 주 확인</span><span>${fmtDate(points.at(-1).weekStart, { month: 'short', day: 'numeric' })}</span></div>`;
  }
  function renderWeekly() {
    const keys = weekKeys(weekOffset), stats = weeklyStats(keys);
    const previous = weeklyStats(keys.map(k => addDays(k, -7)));
    const delta = stats.rate == null || previous.rate == null ? '—' : `${stats.rate - previous.rate > 0 ? '+' : ''}${stats.rate - previous.rate}%p`;
    const month = fromKey(selectedDate);
    const selectedEntries = entriesFor(selectedDate);
    const recurring = state.routines.filter(r => !r.retiredOn || r.retiredOn > today());
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">꾸준함을 돌아봐요</p><h1>주간 분석</h1><p class="date-label">월요일부터 일요일까지</p></div></div>
      <div class="tab-strip"><button data-action="chart-mode" data-mode="summary" class="${chartMode === 'summary' ? 'active' : ''}" type="button">요약</button><button data-action="chart-mode" data-mode="detail" class="${chartMode === 'detail' ? 'active' : ''}" type="button">상세 분석</button></div>
      ${chartMode === 'summary' ? `<section class="card"><div class="week-nav"><button class="small-button" data-action="week-prev" type="button" aria-label="이전 주">‹</button><strong>${fmtDate(keys[0], { month: 'short', day: 'numeric' })} – ${fmtDate(keys[6], { month: 'short', day: 'numeric' })}</strong><button class="small-button" data-action="week-next" type="button" aria-label="다음 주">›</button></div><div class="stat-grid" style="margin-top:18px"><div class="stat"><span>이번 주 완료율</span><strong>${stats.rate == null ? '—' : `${stats.rate}%`}</strong></div><div class="stat"><span>전주 대비</span><strong>${delta}</strong></div><div class="stat"><span>완료한 작업</span><strong>${stats.done}</strong></div><div class="stat"><span>미완료 작업</span><strong>${stats.missed}</strong></div></div><p class="muted" style="margin:13px 0 0">이번 주의 미래 일정도 전체 예정 수에 포함됩니다.</p></section>` : `<section class="card chart-wrap"><h2>최근 26주 완료율</h2>${chartSvg()}</section>`}
      <section class="card"><h2>날짜별 기록</h2>${renderCalendar(month, selectedDate)}<div class="record-detail"><h3>${fmtDate(selectedDate)}</h3>${selectedEntries.length ? `<div class="task-list">${selectedEntries.map(e => `<div class="task-row ${e.done ? 'done' : ''}"><input class="task-check" type="checkbox" data-action="toggle-entry" data-id="${esc(e.id)}" ${e.done ? 'checked' : ''} aria-label="${esc(e.name)} 완료"><span class="task-name">${esc(e.name)}</span><button class="small-button" type="button" data-action="edit-entry" data-id="${esc(e.id)}">수정</button></div>`).join('')}</div>` : '<p class="muted">이 날짜에 기록된 작업이 없어요.</p>'}</div></section>
      ${recurring.length ? `<section class="card"><h2>연속 달성 기록</h2>${recurring.map(r => `<div class="streak-line"><span>🌱</span><span>${esc(r.name)}</span><span>· ${routineStreak(r)}일</span></div>`).join('')}</section>` : ''}`;
  }
  function describeRule(r) {
    const rule = r.rule || { type: 'daily' };
    if (rule.type === 'weekly') return `${(rule.weekdays || []).map(i => DAYS[i]).join('·')}요일${rule.every > 1 ? ` · ${rule.every}주마다` : ''}`;
    if (rule.type === 'monthly') return `${rule.every > 1 ? `${rule.every}개월마다` : '매월'} ${fromKey(r.startDate).getDate()}일`;
    if (rule.type === 'weeks') return `${rule.every}주마다`;
    if (rule.every > 1) return `${rule.every}일마다`;
    return '매일';
  }
  function renderManage() {
    const live = state.routines.filter(r => !r.retiredOn || r.retiredOn > today());
    const archived = state.routines.filter(r => r.retiredOn && r.retiredOn <= today());
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">나에게 맞게 정리해요</p><h1>관리</h1><p class="date-label">반복 일과와 개인 할 일 템플릿</p></div><button class="button" data-action="add-routine" type="button">일과 추가</button></div>
      <section class="card"><div class="section-head" style="margin-top:0"><h2>반복 일과</h2><span class="muted">${live.length}개</span></div>${live.length ? live.map(r => `<div class="routine-card"><div><strong>${esc(r.name)}</strong><p>${esc(describeRule(r))} · ${r.active === false ? '중단됨' : '진행 중'}</p></div><div class="routine-actions"><button class="small-button" data-action="edit-routine" data-id="${esc(r.id)}" type="button">수정</button><button class="small-button" data-action="skip-date" data-id="${esc(r.id)}" type="button">쉬는 날</button><button class="small-button" data-action="delete-routine" data-id="${esc(r.id)}" type="button">삭제</button></div></div>`).join('') : `<p class="muted">아직 반복 일과가 없어요. 일과를 추가해 시작해 보세요.</p>`}${archived.length ? `<details style="margin-top:14px"><summary class="muted">중단한 일과 ${archived.length}개</summary>${archived.map(r => `<div class="routine-card"><div><strong>${esc(r.name)}</strong><p>중단됨</p></div><button class="small-button" data-action="resume-routine" data-id="${esc(r.id)}" type="button">다시 시작</button></div>`).join('')}</details>` : ''}</section>
      <section class="card"><div class="section-head" style="margin-top:0"><h2>개인 할 일 템플릿</h2><button class="small-button" data-action="add-template" type="button">템플릿 추가</button></div>${state.templates.length ? state.templates.map(t => `<div class="routine-card"><div><strong>${esc(t.name)}</strong><p>필요할 때 새 할 일로 추가</p></div><div class="routine-actions"><button class="small-button" data-action="use-template" data-id="${esc(t.id)}" type="button">오늘 추가</button><button class="small-button" data-action="delete-template" data-id="${esc(t.id)}" type="button">삭제</button></div></div>`).join('') : '<p class="muted">자주 쓰는 할 일을 템플릿으로 저장할 수 있어요.</p>'}</section>
      <section class="card"><h2>최근 개인 할 일</h2>${state.entries.filter(e => e.kind === 'task').sort((a,b) => b.date.localeCompare(a.date)).slice(0,8).map(e => `<div class="routine-card"><div><strong>${esc(e.name)}</strong><p>${fmtDate(e.date)} · ${e.done ? '완료' : '미완료'}</p></div><div class="routine-actions"><button class="small-button" data-action="edit-entry" data-id="${esc(e.id)}" type="button">수정</button><button class="small-button" data-action="remove-entry" data-id="${esc(e.id)}" type="button">삭제</button></div></div>`).join('') || '<p class="muted">등록된 개인 할 일이 없어요.</p>'}</section>`;
  }
  function renderSettings() {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    const reminderText = permission === 'granted' ? '알림 권한이 허용되어 있어요.' : permission === 'denied' ? '브라우저 설정에서 알림 권한을 다시 허용해 주세요.' : permission === 'unsupported' ? '이 브라우저에서는 알림을 지원하지 않아요.' : '알림을 켜면 권한을 요청합니다.';
    const selectedSkin = state.settings.colorSkin || 'green';
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">내 방식대로 사용해요</p><h1>설정</h1></div></div>
      <section class="card"><h2>색상 스킨</h2><p class="muted">파스텔 색상 중 원하는 화면 색을 선택하세요.</p><div class="skin-picker" role="group" aria-label="색상 스킨">${COLOR_SKINS.map(skin => `<button class="skin-choice ${selectedSkin === skin.id ? 'selected' : ''}" data-action="choose-skin" data-skin="${skin.id}" type="button" aria-pressed="${selectedSkin === skin.id}"><span class="skin-swatch" style="--swatch:${skin.primary}"></span><span>${skin.name}</span></button>`).join('')}</div></section>
      <section class="card"><h2>매일 요약 알림</h2><div class="setting-row"><div><strong>하루 한 번 알림</strong><p>${esc(reminderText)} 앱이 닫혀 있으면 정해진 시각 알림을 보장할 수 없어요.</p></div><input type="checkbox" id="summaryEnabled" ${state.settings.summaryEnabled ? 'checked' : ''} aria-label="매일 요약 알림 사용"></div><div class="setting-row"><div><strong>알림 시각</strong><p>오늘 예정된 루틴과 할 일을 함께 안내해요.</p></div><input type="time" id="summaryTime" value="${esc(state.settings.summaryTime || '07:00')}" aria-label="알림 시각"></div><div class="inline-note">iPhone·iPad에서는 홈 화면에 설치한 웹앱과 브라우저 권한이 필요할 수 있습니다. 서버를 사용하지 않으므로 앱이 닫힌 동안의 알림은 제공되지 않을 수 있어요.</div></section>
      <section class="card"><h2>백업과 복원</h2><p class="muted">모든 기록은 이 기기에 저장돼요. 기기 간 자동 동기화는 하지 않습니다.</p><div class="button-row"><button class="button" data-action="export-backup" type="button">전체 백업 내려받기</button><button class="button-secondary" data-action="choose-import" type="button">백업 파일 복원</button><button class="button-secondary" data-action="export-csv" type="button">CSV 내보내기</button><input type="file" id="importFile" accept="application/json,.json" hidden></div><p class="muted" style="margin:12px 0 0">마지막 외부 백업: ${state.settings.lastExternalBackup ? fmtDate(dateKey(new Date(state.settings.lastExternalBackup))) : '기록 없음'}</p></section>
      <section class="card"><h2>홈 화면에 설치</h2><p class="muted">Safari의 공유 메뉴에서 ‘홈 화면에 추가’를 선택하면 앱처럼 실행할 수 있습니다. 오프라인 기능은 앱을 한 번 연 뒤 사용할 수 있도록 준비됩니다.</p><div class="install-hint">홈 화면 추가 안내 · Safari에서 공유 버튼을 누른 뒤 <strong>홈 화면에 추가</strong>를 선택하세요.</div></section>
      <section class="card"><h2>데이터 저장 안내</h2><p class="muted">데이터는 이 브라우저 저장 공간에 보관됩니다. 브라우저 데이터 삭제나 기기 교체에 대비해 7일마다 전체 백업 파일을 안전한 위치에 저장해 주세요.</p></section>
      <section class="card danger-zone"><h2>데이터 관리</h2><p class="muted">앱을 초기화하면 기기에 저장된 루틴과 기록이 모두 삭제됩니다.</p><button class="button-danger" data-action="reset-app" type="button">모든 데이터 초기화</button></section>`;
  }

  function showOnboarding() {
    if (modal.open || state.onboardingDone) return;
    openModal(`<p class="eyebrow">처음 오셨군요</p><h2>나만의 루틴을 시작해 볼까요?</h2><p class="intro">짧은 안내를 살펴보거나, 예시 할 일을 불러와 앱을 먼저 사용해 볼 수 있어요. 모두 건너뛸 수 있습니다.</p><div class="inline-note">루틴은 기기에 저장되며, 원할 때 백업 파일로 옮길 수 있어요.</div><div class="modal-footer"><button class="button-secondary" data-action="onboard-skip" type="button">건너뛰기</button><button class="button-secondary" data-action="onboard-examples" type="button">예시 할 일 불러오기</button><button class="button" data-action="onboard-next" type="button">안내 보기</button></div>`);
  }
  function finishOnboarding(withExamples = false) {
    if (withExamples) {
      const names = ['물을 한 잔 마시기', '가볍게 몸 풀기', '오늘 할 일 확인하기'];
      for (const name of names) state.entries.push({ id: uid(), kind: 'task', date: today(), name, done: false, order: state.entries.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), example: true });
    }
    state.onboardingDone = true; save(); closeModal(); render();
  }
  function taskForm(existing = null, defaultDate = today()) {
    const title = existing ? '할 일 수정' : '새 할 일';
    openModal(`<form id="taskForm"><p class="eyebrow">개인 할 일</p><h2>${title}</h2><div class="field"><label for="taskName">할 일 이름</label><input id="taskName" name="name" required maxlength="100" value="${esc(existing?.name || '')}" placeholder="예: 책 10쪽 읽기"></div><div class="field"><label for="taskDate">날짜</label><input id="taskDate" name="date" type="date" required value="${esc(existing?.date || defaultDate)}"></div>${existing ? `<input type="hidden" name="id" value="${esc(existing.id)}">` : ''}${modalFooter(existing ? '수정 저장' : '추가')}</form>`, () => $('#taskName', modal)?.focus());
  }
  function routineForm(existing = null) {
    const rule = existing?.rule || { type: 'daily', every: 1, weekdays: [1,2,3,4,5,6,0] };
    const selected = rule.type === 'weekly' ? rule.weekdays || [] : [];
    openModal(`<form id="routineForm"><p class="eyebrow">반복 일과</p><h2>${existing ? '일과 수정' : '새 일과'}</h2>
      <div class="field"><label for="routineName">이름</label><input id="routineName" name="name" required maxlength="100" value="${esc(existing?.name || '')}" placeholder="예: 아침 스트레칭"></div>
      <div class="form-grid"><div class="field"><label for="ruleType">반복 주기</label><select id="ruleType" name="type"><option value="daily" ${rule.type === 'daily' ? 'selected' : ''}>매일</option><option value="weekly" ${rule.type === 'weekly' ? 'selected' : ''}>매주 요일 선택</option><option value="weeks" ${rule.type === 'weeks' ? 'selected' : ''}>몇 주마다</option><option value="days" ${rule.type === 'days' ? 'selected' : ''}>몇 일마다</option><option value="monthly" ${rule.type === 'monthly' ? 'selected' : ''}>매월</option></select></div><div class="field" id="everyField"><label for="every">간격</label><input id="every" name="every" type="number" min="1" max="365" value="${esc(rule.every || 1)}"></div>
      <div class="field full" id="weekdayField" ${rule.type === 'weekly' ? '' : 'hidden'}><span class="field-label">반복할 요일</span>${dayChecks('weekdays', selected)}</div>
      <div class="field full"><span class="field-label">쉬는 요일 (선택)</span>${dayChecks('restWeekdays', existing?.restWeekdays || [])}</div>
      <div class="field"><label for="startDate">시작일</label><input id="startDate" name="startDate" type="date" required value="${esc(existing?.startDate || today())}"></div><div class="field"><label for="endDate">종료일 (선택)</label><input id="endDate" name="endDate" type="date" value="${esc(existing?.endDate || '')}"></div></div>
      ${existing ? `<input type="hidden" name="id" value="${esc(existing.id)}">` : ''}<div class="inline-note">주간 반복은 선택한 요일에만 등록돼요. 격주·매월 반복은 시작일을 기준으로 계산합니다.</div>${modalFooter(existing ? '수정 저장' : '일과 추가')}</form>`, () => {
        $('#routineName', modal)?.focus();
        $('#ruleType', modal).addEventListener('change', () => $('#weekdayField', modal).hidden = $('#ruleType', modal).value !== 'weekly');
      });
  }
  function templateForm() {
    openModal(`<form id="templateForm"><p class="eyebrow">재사용 템플릿</p><h2>템플릿 추가</h2><div class="field"><label for="templateName">할 일 이름</label><input id="templateName" name="name" required maxlength="100" placeholder="예: 장보기"></div>${modalFooter('저장')}</form>`, () => $('#templateName', modal)?.focus());
  }
  function deleteRoutineDialog(id) {
    const routine = state.routines.find(r => r.id === id); if (!routine) return;
    openModal(`<p class="eyebrow">일과 삭제</p><h2>${esc(routine.name)}</h2><p class="intro">오늘 이후의 반복을 중단합니다. 과거 기록은 어떻게 할까요?</p><div class="modal-footer" style="justify-content:stretch"><button class="button-secondary" data-action="confirm-delete-routine" data-id="${esc(id)}" data-history="keep" type="button">과거 기록 보존</button><button class="button-danger" data-action="confirm-delete-routine" data-id="${esc(id)}" data-history="erase" type="button">과거 기록도 삭제</button></div>`);
  }
  function skipDateDialog(id) {
    const routine = state.routines.find(r => r.id === id); if (!routine) return;
    openModal(`<form id="skipForm"><p class="eyebrow">쉬는 날</p><h2>${esc(routine.name)}</h2><p class="intro">이 반복 일과를 쉬는 요일이나 특정 날짜를 설정합니다.</p><div class="field"><span class="field-label">매주 쉬는 요일</span>${dayChecks('restWeekdays', routine.restWeekdays || [])}</div><div class="field"><label for="skipDate">한 번만 쉬는 날짜 추가</label><input id="skipDate" name="date" type="date" value="${today()}"></div><p class="muted">이미 추가한 날짜: ${(routine.exceptions || []).map(d => `<button class="small-button" data-action="remove-skip" data-id="${esc(id)}" data-date="${esc(d)}" type="button">${fmtDate(d)} ×</button>`).join(' ') || '없음'}</p><input type="hidden" name="id" value="${esc(id)}">${modalFooter('저장')}</form>`);
  }
  function editEntry(id) { const e = getEntry(id); if (e) taskForm(e, e.date); }

  function setEntryDone(id, done) {
    const e = getEntry(id); if (!e) return;
    e.done = done; e.updatedAt = new Date().toISOString(); save(); render();
  }
  function addTask(name, date, example = false) {
    const duplicate = state.entries.find(e => e.date === date && e.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase());
    if (duplicate && !confirm('같은 날짜에 이름이 같은 할 일이 있어요. 그래도 추가할까요?')) return;
    state.entries.push({ id: uid(), kind: 'task', date, name: name.trim(), done: false, order: state.entries.filter(e => e.date === date).length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(example ? { example: true } : {}) });
    save(); closeModal(); selectedDate = date; render(); showToast('할 일을 저장했어요.');
  }
  function orderEntry(dragId, targetId, group) {
    const entries = entriesFor(today()).filter(e => group === 'done' ? e.done : !e.done);
    const ids = entries.map(e => e.id); const from = ids.indexOf(dragId), to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    ids.forEach((id, index) => { const e = getEntry(id); e.order = index; e.updatedAt = new Date().toISOString(); });
    save(); render();
  }
  function moveEntry(id, direction) {
    const entry = getEntry(id); if (!entry) return;
    const group = entriesFor(today()).filter(e => e.done === entry.done);
    const index = group.findIndex(e => e.id === id), next = index + direction;
    if (next < 0 || next >= group.length) return;
    [group[index], group[next]] = [group[next], group[index]];
    group.forEach((e, i) => { e.order = i; e.updatedAt = new Date().toISOString(); });
    save(); render();
  }
  function createRoutine(formData) {
    const id = formData.get('id'), name = String(formData.get('name')).trim();
    const type = formData.get('type'), every = Math.max(1, Number(formData.get('every') || 1));
    const weekdays = formData.getAll('weekdays').map(Number);
    if (type === 'weekly' && !weekdays.length) { showToast('반복할 요일을 하나 이상 선택해 주세요.'); return; }
    const startDate = String(formData.get('startDate') || today()), endDate = String(formData.get('endDate') || '');
    if (endDate && endDate < startDate) { showToast('종료일은 시작일 이후로 선택해 주세요.'); return; }
    const rule = { type, every, weekdays };
    if (id) {
      const r = state.routines.find(item => item.id === id); if (!r) return;
      r.name = name; r.rule = rule; r.startDate = startDate; r.endDate = endDate || null; r.restWeekdays = formData.getAll('restWeekdays').map(Number); r.updatedAt = new Date().toISOString();
      state.entries.filter(e => e.kind === 'routine' && e.routineId === id && e.date >= today()).forEach(e => state.entries.splice(state.entries.indexOf(e), 1));
    } else state.routines.push({ id: uid(), name, rule, startDate, endDate: endDate || null, restWeekdays: formData.getAll('restWeekdays').map(Number), exceptions: [], active: true, order: state.routines.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    save(); closeModal(); render(); showToast(id ? '일과를 수정했어요.' : '반복 일과를 추가했어요.');
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function exportBackup() {
    const snapshot = { ...state, exportedAt: new Date().toISOString(), app: '나만의 루틴' };
    download(`나만의-루틴-백업-${today()}.json`, JSON.stringify(snapshot, null, 2), 'application/json');
    state.settings.lastExternalBackup = new Date().toISOString(); save(); render(); showToast('전체 백업 파일을 저장했어요.');
  }
  function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }
  function exportCsv() {
    const rows = [['날짜', '할 일', '종류', '완료 여부'], ...state.entries.slice().sort((a,b) => a.date.localeCompare(b.date)).map(e => [e.date, e.name, e.kind === 'routine' ? '반복 일과' : '개인 할 일', e.done ? '완료' : '미완료'])];
    download(`나만의-루틴-기록-${today()}.csv`, '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    showToast('CSV 파일을 저장했어요.');
  }
  async function importBackup(file) {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.entries) || !Array.isArray(parsed.routines)) throw new Error('지원하지 않는 백업 형식입니다.');
      openModal(`<p class="eyebrow">백업 복원</p><h2>현재 데이터 처리</h2><p class="intro">기기 데이터 ${state.entries.length}개와 백업 기록 ${parsed.entries.length}개가 있습니다.</p><div class="button-row"><button class="button-danger" data-action="restore-backup" data-mode="replace" type="button">현재 데이터 교체</button><button class="button" data-action="restore-backup" data-mode="merge" type="button">기존 데이터와 병합</button></div><p class="muted" style="margin-top:12px">교체는 되돌릴 수 없어요. 필요하면 먼저 현재 데이터를 백업해 주세요.</p>`, () => { modal.dataset.importJson = JSON.stringify(parsed); });
    } catch (error) { showToast(error.message || '백업 파일을 읽지 못했어요.'); }
  }
  function restoreBackup(mode) {
    const parsed = JSON.parse(modal.dataset.importJson || '{}');
    if (mode === 'replace') {
      if (!confirm('현재 기기의 데이터가 백업 파일 내용으로 대체됩니다. 계속할까요?')) return;
      state = { ...freshState(), ...parsed, settings: { ...freshState().settings, ...(parsed.settings || {}), lastExternalBackup: new Date().toISOString() } };
    } else {
      const localById = new Map(state.entries.map(e => [e.id, e]));
      let unresolved = [];
      for (const incoming of parsed.entries || []) {
        const current = localById.get(incoming.id);
        if (!current) { state.entries.push(incoming); continue; }
        const a = Date.parse(current.updatedAt || current.createdAt || 0), b = Date.parse(incoming.updatedAt || incoming.createdAt || 0);
        if (b > a) Object.assign(current, incoming);
        else if (a === b && JSON.stringify(current) !== JSON.stringify(incoming)) unresolved.push(incoming);
      }
      for (const routine of parsed.routines || []) if (!state.routines.some(r => r.id === routine.id)) state.routines.push(routine);
      for (const template of parsed.templates || []) if (!state.templates.some(t => t.id === template.id)) state.templates.push(template);
      if (unresolved.length) {
        if (!confirm(`${unresolved.length}개 기록의 수정 시각이 같거나 비교되지 않아요. 백업 쪽 기록을 사용해 병합할까요? 취소하면 현재 기록을 유지합니다.`)) {}
        else for (const incoming of unresolved) Object.assign(localById.get(incoming.id), incoming);
      }
      state.settings.lastExternalBackup = new Date().toISOString();
    }
    save(); closeModal(); render(); showToast('백업을 복원했어요.');
  }
  function enableSummary() {
    if (!state.settings.summaryEnabled) { save(); return; }
    if (!('Notification' in window)) { state.settings.summaryEnabled = false; save(); render(); showToast('이 브라우저에서는 알림을 지원하지 않아요.'); return; }
    if (Notification.permission === 'granted') { save(); showToast('요약 알림을 켰어요. 앱이 열려 있을 때 알림을 확인할 수 있어요.'); return; }
    if (Notification.permission === 'denied') { state.settings.summaryEnabled = false; save(); render(); showToast('브라우저 설정에서 알림 권한을 허용해 주세요.'); return; }
    Notification.requestPermission().then(permission => {
      state.settings.summaryEnabled = permission === 'granted'; save(); render();
      showToast(state.settings.summaryEnabled ? '요약 알림을 켰어요.' : '알림 권한을 허용하지 않았어요.');
    });
  }
  function checkReminder() {
    if (!state.settings.summaryEnabled || !('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState !== 'visible') return;
    const [hour, minute] = (state.settings.summaryTime || '07:00').split(':').map(Number), now = new Date();
    if (now.getHours() !== hour || now.getMinutes() !== minute || state.settings.lastNotifiedDate === today()) return;
    const names = entriesFor(today()).map(e => e.name);
    if (!names.length) return;
    try {
      const n = new Notification('오늘의 나만의 루틴', { body: names.join(' · ').slice(0, 230), tag: `routine-${today()}` });
      n.onclick = () => { window.focus(); currentView = 'today'; render(); n.close(); };
      state.settings.lastNotifiedDate = today(); save();
    } catch { /* 브라우저가 앱 내 알림을 허용하지 않을 수 있습니다. */ }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const { action, id, date } = button.dataset;
    if (action === 'add-task') taskForm(null, today());
    else if (action === 'add-routine') routineForm();
    else if (action === 'edit-routine') routineForm(state.routines.find(r => r.id === id));
    else if (action === 'delete-routine') deleteRoutineDialog(id);
    else if (action === 'skip-date') skipDateDialog(id);
    else if (action === 'resume-routine') { const r = state.routines.find(x => x.id === id); r.retiredOn = null; r.startDate = today(); r.active = true; save(); render(); showToast('오늘부터 다시 시작해요.'); }
    else if (action === 'toggle-entry') { /* input change is handled below */ }
    else if (action === 'edit-entry') editEntry(id);
    else if (action === 'move-entry') moveEntry(id, Number(button.dataset.direction));
    else if (action === 'remove-entry') { if (confirm('이 개인 할 일을 삭제할까요?')) { state.entries = state.entries.filter(e => e.id !== id); save(); render(); } }
    else if (action === 'add-template') templateForm();
    else if (action === 'use-template') { const t = state.templates.find(x => x.id === id); if (t) addTask(t.name, today()); }
    else if (action === 'delete-template') { state.templates = state.templates.filter(t => t.id !== id); save(); render(); }
    else if (action === 'confirm-delete-routine') {
      const r = state.routines.find(x => x.id === id); if (!r) return;
      if (!confirm(`“${r.name}”의 오늘과 미래 반복을 중단할까요?`)) return;
      r.retiredOn = today(); r.active = false; r.updatedAt = new Date().toISOString();
      state.entries = state.entries.filter(e => e.routineId !== id || e.date < today() && button.dataset.history === 'keep');
      save(); closeModal(); render(); showToast(button.dataset.history === 'keep' ? '과거 기록을 보존하고 일과를 중단했어요.' : '일과와 과거 기록을 삭제했어요.');
    }
    else if (action === 'remove-skip') { const r = state.routines.find(x => x.id === id); r.exceptions = (r.exceptions || []).filter(d => d !== date); save(); skipDateDialog(id); }
    else if (action === 'go-backup') { currentView = 'settings'; render(); }
    else if (action === 'week-prev') { weekOffset--; render(); }
    else if (action === 'week-next') { weekOffset++; render(); }
    else if (action === 'month-prev' || action === 'month-next') { const d = fromKey(selectedDate); d.setMonth(d.getMonth() + (action === 'month-prev' ? -1 : 1)); selectedDate = dateKey(new Date(d.getFullYear(), d.getMonth(), 1, 12)); render(); }
    else if (action === 'select-date') { selectedDate = date; render(); }
    else if (action === 'chart-mode') { chartMode = button.dataset.mode; render(); }
    else if (action === 'choose-skin') { state.settings.colorSkin = button.dataset.skin; applySkin(); save(); render(); showToast(`${COLOR_SKINS.find(skin => skin.id === state.settings.colorSkin)?.name || '초록'} 스킨을 적용했어요.`); }
    else if (action === 'chart-week') { const start = startOfWeek(date); selectedDate = start; weekOffset = Math.round(dayDiff(startOfWeek(today()), start) / 7); chartMode = 'summary'; render(); }
    else if (action === 'close-modal') closeModal();
    else if (action === 'onboard-skip' || action === 'onboard-next') finishOnboarding(false);
    else if (action === 'onboard-examples') finishOnboarding(true);
    else if (action === 'export-backup') exportBackup();
    else if (action === 'export-csv') exportCsv();
    else if (action === 'choose-import') $('#importFile')?.click();
    else if (action === 'restore-backup') restoreBackup(button.dataset.mode);
    else if (action === 'reset-app') {
      if (!confirm('모든 루틴과 기록을 영구 삭제할까요? 먼저 백업 파일을 내려받는 것을 권장합니다.')) return;
      state = freshState(); save(); render(); showToast('데이터를 초기화했어요.');
    }
  });
  main.addEventListener('change', event => {
    if (event.target.matches('[data-action="toggle-entry"]')) setEntryDone(event.target.dataset.id, event.target.checked);
  });
  main.addEventListener('dragstart', event => {
    const row = event.target.closest('.task-row[data-entry]'); if (!row) return;
    event.dataTransfer.setData('text/plain', row.dataset.entry); event.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging');
  });
  main.addEventListener('dragend', event => event.target.closest('.task-row')?.classList.remove('dragging'));
  main.addEventListener('dragover', event => { if (event.target.closest('.task-row[data-entry]')) { event.preventDefault(); event.target.closest('.task-row').classList.add('drag-over'); } });
  main.addEventListener('dragleave', event => event.target.closest('.task-row')?.classList.remove('drag-over'));
  main.addEventListener('drop', event => {
    const row = event.target.closest('.task-row[data-entry]'); if (!row) return;
    event.preventDefault(); row.classList.remove('drag-over'); const source = event.dataTransfer.getData('text/plain');
    orderEntry(source, row.dataset.entry, row.closest('.task-list')?.dataset.group || (getEntry(row.dataset.entry)?.done ? 'done' : 'open'));
  });
  modal.addEventListener('click', event => {
    if (event.target.matches('[data-action="close-modal"]')) closeModal();
    if (event.target === modal) closeModal();
  });
  modal.addEventListener('submit', event => {
    event.preventDefault(); const form = event.target, fd = new FormData(form);
    if (form.id === 'taskForm') {
      const id = fd.get('id'), name = String(fd.get('name')).trim(), date = String(fd.get('date'));
      if (id) { const e = getEntry(id); if (e) { e.name = name; e.date = date; e.updatedAt = new Date().toISOString(); save(); closeModal(); selectedDate = date; render(); showToast('기록을 수정했어요.'); } }
      else addTask(name, date);
    } else if (form.id === 'routineForm') createRoutine(fd);
    else if (form.id === 'templateForm') { state.templates.push({ id: uid(), name: String(fd.get('name')).trim(), createdAt: new Date().toISOString() }); save(); closeModal(); render(); }
    else if (form.id === 'skipForm') { const r = state.routines.find(x => x.id === fd.get('id')); if (r) { r.restWeekdays = fd.getAll('restWeekdays').map(Number); const skip = String(fd.get('date') || ''); if (skip && !(r.exceptions || []).includes(skip)) r.exceptions = [...(r.exceptions || []), skip]; save(); closeModal(); render(); showToast('쉬는 날을 저장했어요.'); } }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'summaryEnabled') { state.settings.summaryEnabled = event.target.checked; enableSummary(); }
    if (event.target.id === 'summaryTime') { state.settings.summaryTime = event.target.value || '07:00'; save(); showToast('알림 시각을 저장했어요.'); }
    if (event.target.id === 'importFile' && event.target.files?.[0]) { importBackup(event.target.files[0]); event.target.value = ''; }
  });
  $$('.nav-item').forEach(button => button.addEventListener('click', () => { currentView = button.dataset.view; if (currentView === 'today') selectedDate = today(); render(); main.focus({ preventScroll: true }); }));
  $('#installButton').addEventListener('click', async () => {
    if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#installButton').hidden = true; }
    else showToast('Safari의 공유 메뉴에서 ‘홈 화면에 추가’를 선택해 주세요.');
  });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('#installButton').hidden = false; });
  window.addEventListener('appinstalled', () => { $('#installButton').hidden = true; showToast('홈 화면 설치가 완료됐어요.'); });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(() => {});
  window.addEventListener('online', () => showToast('온라인 상태로 돌아왔어요.'));
  window.addEventListener('offline', () => showToast('오프라인 상태예요. 저장된 기능을 계속 사용할 수 있어요.'));

  loadState().then(() => {
    applySkin();
    ensureRange(today(), today());
    render();
    setInterval(checkReminder, 15000);
  });
})();
