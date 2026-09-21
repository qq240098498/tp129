// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  groups: [],
  ungrouped: { id: '', name: '未归组', count: 0, zones: [] },
  activeGroup: '', // 空串表示默认组「未归组」
  groupLimit: 50,
  groupFormMode: '', // '' | 'create' | 'rename'
  editingId: '',
  lastConvert: null,
};

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.matches('input, select, textarea') ? target : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTH_LABEL = Object.fromEntries(MONTHS);
const WEEK_LABEL = Object.fromEntries(WEEKS);
const WEEKDAY_LABEL = Object.fromEntries(WEEKDAYS);

function ruleText(part) {
  if (!part) return '—';
  const hour = String(part.hour).padStart(2, '0');
  const minute = String(part.minute).padStart(2, '0');
  return `${MONTH_LABEL[String(part.month)] || part.month}${WEEK_LABEL[part.week] || part.week}${WEEKDAY_LABEL[String(part.weekday)] || part.weekday} ${hour}:${minute}`;
}

const OPERATOR_KEY = 'zone-clock-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

function fillOptions() {
  const monthOptions = MONTHS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekOptions = WEEKS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekdayOptions = WEEKDAYS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  ['zone-start-month', 'zone-end-month'].forEach((id) => { el(id).innerHTML = monthOptions; });
  ['zone-start-week', 'zone-end-week'].forEach((id) => { el(id).innerHTML = weekOptions; });
  ['zone-start-weekday', 'zone-end-weekday'].forEach((id) => { el(id).innerHTML = weekdayOptions; });
}

async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderZones();
  renderConvertZoneOptions();
}

async function loadGroups() {
  const payload = await request('/api/groups');
  state.groups = payload.groups || [];
  state.ungrouped = payload.ungrouped || { id: '', name: '未归组', count: 0, zones: [] };
  state.groupLimit = payload.limit || 50;
  // 当前查看的组若已被删掉，回到默认组，避免对着一个空壳页面
  if (state.activeGroup && !state.groups.some((group) => group.id === state.activeGroup)) {
    state.activeGroup = '';
  }
  renderGroupTabs();
  renderZones();
}

function activeGroupObj() {
  if (state.activeGroup === '') return null;
  return state.groups.find((group) => group.id === state.activeGroup) || null;
}

// 表格只列当前组的档案；筛选条件在组内继续生效，组内顺序按服务端给的 zoneIds
function visibleZones() {
  const group = activeGroupObj();
  const source = group ? group.zones : state.ungrouped.zones;
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim().toLowerCase();
  return source.filter((item) => {
    if (dst === 'yes' && !item.usesDst) return false;
    if (dst === 'no' && item.usesDst) return false;
    if (keyword && !(
      item.name.toLowerCase().includes(keyword)
      || item.displayName.toLowerCase().includes(keyword)
      || item.note.toLowerCase().includes(keyword)
    )) return false;
    return true;
  });
}

function renderGroupTabs() {
  const tabs = el('group-tabs');
  const makeTab = (id, name, count, active) => `<button type="button" role="tab"
      class="group-tab ${active ? 'active' : ''}"
      data-group-tab="${escapeHtml(id)}">
      ${escapeHtml(name)}<span class="group-count">${count}</span>
    </button>`;
  const html = [
    makeTab('', state.ungrouped.name, state.ungrouped.count, state.activeGroup === ''),
    ...state.groups.map((group) => makeTab(group.id, group.name, group.count, group.id === state.activeGroup)),
  ].join('');
  tabs.innerHTML = html;

  const group = activeGroupObj();
  el('group-rename').disabled = !group;
  el('group-delete').disabled = !group;
  el('group-sort-offset').disabled = !group || group.count === 0;
}

function groupMoveOptions(selectedId) {
  const options = [`<option value="">${escapeHtml(state.ungrouped.name)}</option>`];
  state.groups.forEach((group) => {
    options.push(`<option value="${escapeHtml(group.id)}"${group.id === selectedId ? ' selected' : ''}>${escapeHtml(group.name)}</option>`);
  });
  return options.join('');
}

function renderZones() {
  const group = activeGroupObj();
  const groupName = group ? group.name : state.ungrouped.name;
  const list = visibleZones();
  const totalInGroup = group ? group.count : state.ungrouped.count;
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；正在查看「${groupName}」组，组里眼下有 ${totalInGroup} 条，当前筛选出 ${list.length} 条`;

  // 组内顺序按这份清单里的下标判断是否到边；未归组没有手工顺序，不显示上下移
  const orderCell = (item) => {
    if (!group) return '<span class="muted">—</span>';
    const index = group.zones.findIndex((zone) => zone.id === item.id);
    return `<span class="order-btns">
        <button type="button" class="link" data-zone-up="${escapeHtml(item.id)}"${index === 0 ? ' disabled title="已经在最上面"' : ''}>上移</button>
        <button type="button" class="link" data-zone-down="${escapeHtml(item.id)}"${index === group.zones.length - 1 ? ' disabled title="已经在最下面"' : ''}>下移</button>
      </span>`;
  };

  const body = el('zone-body');
  body.innerHTML = list.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="mono">${escapeHtml(item.yearRangeText)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions">${orderCell(item)}</td>
      <td><select class="group-move" data-zone-move="${escapeHtml(item.id)}" title="移动到其他分组">${groupMoveOptions(group ? group.id : '')}</select></td>
      <td class="actions">
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', list.length > 0);
  el('zone-empty').textContent = totalInGroup === 0
    ? `「${groupName}」组里眼下没有档案`
    : '当前筛选条件下没有时区档案';
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.zones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.zones.some((item) => item.id === current)) select.value = current;
}

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
  el('zone-form-title').textContent = zone ? `编辑档案：${zone.name}` : '新建档案';
  el('zone-name').value = zone ? zone.name : '';
  el('zone-display').value = zone ? zone.displayName : '';
  el('zone-offset').value = zone ? String(zone.offsetMinutes) : '';
  el('zone-uses-dst').checked = zone ? zone.usesDst : false;
  el('zone-dst-offset').value = zone && zone.dstOffsetMinutes !== null ? String(zone.dstOffsetMinutes) : '';
  const start = zone && zone.dstStart ? zone.dstStart : { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 };
  const end = zone && zone.dstEnd ? zone.dstEnd : { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 };
  el('zone-start-month').value = String(start.month);
  el('zone-start-week').value = start.week;
  el('zone-start-weekday').value = String(start.weekday);
  el('zone-start-hour').value = String(start.hour);
  el('zone-start-minute').value = String(start.minute);
  el('zone-end-month').value = String(end.month);
  el('zone-end-week').value = end.week;
  el('zone-end-weekday').value = String(end.weekday);
  el('zone-end-hour').value = String(end.hour);
  el('zone-end-minute').value = String(end.minute);
  el('zone-from-year').value = zone ? String(zone.fromYear) : '';
  el('zone-to-year').value = zone && zone.toYear !== null ? String(zone.toYear) : '';
  el('zone-note').value = zone ? zone.note : '';
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function closeZoneForm() {
  state.editingId = '';
  el('zone-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitZone(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('zone-name').value,
    displayName: el('zone-display').value,
    offsetMinutes: el('zone-offset').value,
    usesDst: el('zone-uses-dst').checked,
    dstOffsetMinutes: el('zone-dst-offset').value === '' ? null : el('zone-dst-offset').value,
    dstStart: {
      month: el('zone-start-month').value,
      week: el('zone-start-week').value,
      weekday: el('zone-start-weekday').value,
      hour: el('zone-start-hour').value,
      minute: el('zone-start-minute').value,
    },
    dstEnd: {
      month: el('zone-end-month').value,
      week: el('zone-end-week').value,
      weekday: el('zone-end-weekday').value,
      hour: el('zone-end-hour').value,
      minute: el('zone-end-minute').value,
    },
    fromYear: el('zone-from-year').value,
    toYear: el('zone-to-year').value === '' ? null : el('zone-to-year').value,
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
  }
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/zones/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('时区档案已保存', 'ok');
    } else {
      await request('/api/zones', { method: 'POST', body: JSON.stringify(payload) });
      notify('时区档案已新增', 'ok');
    }
    closeZoneForm();
    await Promise.all([loadZones(), loadGroups()]);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function runConvert() {
  clearNotice();
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
  };
  try {
    const result = await request('/api/convert', { method: 'POST', body: JSON.stringify(payload) });
    state.lastConvert = result;
    renderConvert(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

function renderConvert(result) {
  el('convert-meta').textContent = `来源 ${result.input.zoneName}（${result.input.zoneDisplayName}，${result.input.offsetText}）的 ${result.input.date} ${result.input.time}，换算时刻 ${formatTime(result.convertedAt)}；参与换算的档案 ${result.zonesInScope} 条，与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${Math.floor(result.maxDiffMinutes / 60)} 小时 ${result.maxDiffMinutes % 60} 分`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.localDate)}</td>
      <td class="mono">${escapeHtml(item.localTime)}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${item.usesDst ? '有规则' : '—'}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.groupTab !== undefined) {
    clearNotice();
    state.activeGroup = node.dataset.groupTab;
    renderGroupTabs();
    renderZones();
    return;
  }

  if (node.dataset.zoneUp !== undefined || node.dataset.zoneDown !== undefined) {
    const group = activeGroupObj();
    if (!group) return;
    clearNotice();
    const zoneId = node.dataset.zoneUp !== undefined ? node.dataset.zoneUp : node.dataset.zoneDown;
    try {
      await request(`/api/groups/${encodeURIComponent(group.id)}/reorder`, {
        method: 'POST',
        body: JSON.stringify({ zoneId, direction: node.dataset.zoneUp !== undefined ? 'up' : 'down' }),
      });
      await loadGroups();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = allZonesFlat().find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneDelete) {
    clearNotice();
    const found = allZonesFlat().find((item) => item.id === node.dataset.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？删除后它也会从所在分组里消失。`)) return;
    try {
      await request(`/api/zones/${encodeURIComponent(node.dataset.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.zoneDelete) closeZoneForm();
      notify('时区档案已删除', 'ok');
      await Promise.all([loadZones(), loadGroups()]);
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

// 编辑按钮拿到的档案可能在任何一个组里，把所有组拍平成一份清单来找
function allZonesFlat() {
  const map = new Map();
  state.ungrouped.zones.forEach((zone) => map.set(zone.id, zone));
  state.groups.forEach((group) => group.zones.forEach((zone) => map.set(zone.id, zone)));
  return [...map.values()];
}

// 每行的「移动分组」下拉：一改就跨组移动，提示语写清从哪个组移到哪个组
document.addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-zone-move]');
  if (!select) return;
  const zoneId = select.dataset.zoneMove;
  const targetGroupId = select.value;
  try {
    const result = await request('/api/groups/assign', {
      method: 'POST',
      body: JSON.stringify({ zoneId, groupId: targetGroupId }),
    });
    if (result.moved) {
      notify(`已把 ${result.zone.name} 从「${result.fromGroupName}」移到「${result.toGroupName}」`, 'ok');
    }
    await Promise.all([loadZones(), loadGroups()]);
  } catch (err) {
    notify(err.message, 'error');
    // 移动没成（例如目标组满了）时把下拉还原到当前组
    renderZones();
  }
});

el('zone-form').addEventListener('submit', submitZone);

function openGroupForm(mode) {
  const group = activeGroupObj();
  state.groupFormMode = mode;
  el('group-name-caption').textContent = mode === 'rename' ? '新的分组名称' : '分组名称';
  el('group-name').value = mode === 'rename' && group ? group.name : '';
  el('group-form').classList.remove('hidden');
  el('group-name').focus();
}

function closeGroupForm() {
  state.groupFormMode = '';
  el('group-form').classList.add('hidden');
  el('group-name').value = '';
  clearFieldMarks();
}

async function submitGroupName(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const name = el('group-name').value;
  const group = activeGroupObj();
  try {
    if (state.groupFormMode === 'rename' && group) {
      await request(`/api/groups/${encodeURIComponent(group.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      notify('分组已重命名', 'ok');
    } else {
      await request('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
      notify('分组已新建，档案可以用行尾的「移动分组」挪进来', 'ok');
    }
    closeGroupForm();
    await loadGroups();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

el('group-form').addEventListener('submit', submitGroupName);
el('group-form-cancel').addEventListener('click', closeGroupForm);
el('group-new').addEventListener('click', () => {
  clearNotice();
  openGroupForm('create');
});
el('group-rename').addEventListener('click', () => {
  clearNotice();
  openGroupForm('rename');
});
el('group-delete').addEventListener('click', async () => {
  const group = activeGroupObj();
  if (!group) return;
  clearNotice();
  if (!window.confirm(`确定删除分组「${group.name}」吗？组里 ${group.count} 条档案不会被删，会全部回到「未归组」。`)) return;
  try {
    await request(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
    state.activeGroup = '';
    notify(`分组「${group.name}」已删除，组内档案已回到未归组`, 'ok');
    await Promise.all([loadZones(), loadGroups()]);
  } catch (err) {
    notify(err.message, 'error');
  }
});
el('group-sort-offset').addEventListener('click', async () => {
  const group = activeGroupObj();
  if (!group || group.count === 0) return;
  clearNotice();
  // 页面上一直挂着文字提示，点按钮时再用确认框把"会盖掉手工顺序"讲清楚一次
  const ok = window.confirm(`将把「${group.name}」组的 ${group.count} 条档案按标准偏移从小到大重排。这会盖掉组内原来的手工上移下移顺序，确定继续吗？`);
  if (!ok) return;
  try {
    await request(`/api/groups/${encodeURIComponent(group.id)}/sort-by-offset`, { method: 'POST' });
    notify(`「${group.name}」已按偏移从小到大重排`, 'ok');
    await loadGroups();
  } catch (err) {
    notify(err.message, 'error');
  }
});

el('zone-new').addEventListener('click', () => {
  clearNotice();
  openZoneForm(null);
});
el('zone-cancel').addEventListener('click', closeZoneForm);
el('zone-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-reset').addEventListener('click', () => {
  el('zone-filter-dst').value = '';
  el('zone-filter-keyword').value = '';
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-refresh').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-dst').addEventListener('change', () => {
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('convert-run').addEventListener('click', runConvert);
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把档案与分组各拉一遍，换算台的来源时区下拉按档案清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
loadZones().catch((err) => notify(err.message, 'error'));
loadGroups().catch((err) => notify(err.message, 'error'));
