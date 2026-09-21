// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const DEFAULT_GROUP_ID = 'default';

const state = {
  zones: [],
  allZones: [],
  groups: [],
  groupLimit: 50,
  activeGroupId: DEFAULT_GROUP_ID,
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  groupEditingId: '',
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
  const targets = Array.from(document.querySelectorAll(`[data-field="${field}"]`));
  // 档案表单与分组表单里都有叫 name 的字段，只标当前看得见的那一个
  const target = targets.find((node) => node.offsetParent !== null) || targets[0];
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

// 分组清单与档案清单是两份数据：标签栏与各组的条数按分组清单画，表格只拉当前组里的档案
async function loadGroups() {
  const payload = await request('/api/groups');
  state.groups = payload.groups || [];
  state.groupLimit = payload.limit || 50;
  // 当前选中的组已经被删掉时，退回未分组，档案不会跟着丢
  if (!state.groups.some((group) => group.id === state.activeGroupId)) {
    state.activeGroupId = DEFAULT_GROUP_ID;
  }
}

async function loadAllZonesForConvert() {
  const payload = await request('/api/zones');
  state.allZones = payload.zones || [];
}

async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword', keyword);
  if (state.activeGroupId) params.set('groupId', state.activeGroupId);
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderGroups();
  renderZones();
}

// 初次加载与分组增删改之后都要同时刷新两份清单
async function refreshAll() {
  await loadGroups();
  await Promise.all([loadZones(), loadAllZonesForConvert()]);
  renderConvertZoneOptions();
}

function activeGroup() {
  return state.groups.find((group) => group.id === state.activeGroupId) || state.groups[0] || null;
}

function renderGroups() {
  const tabs = el('group-tabs');
  tabs.querySelectorAll('.group-tab').forEach((node) => node.remove());
  const addButton = el('group-new');
  state.groups.forEach((group) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `group-tab${group.id === state.activeGroupId ? ' active' : ''}`;
    tab.dataset.groupTab = group.id;
    tab.textContent = `${group.isDefault ? '未分组' : group.name}（${group.count}）`;
    tab.title = group.isDefault ? '没有归到任何常用组的档案都摆在这里' : `组内眼下有 ${group.count} 条档案`;
    tabs.insertBefore(tab, addButton);
  });

  const bar = el('group-bar');
  const group = activeGroup();
  if (!group) {
    bar.innerHTML = '';
    return;
  }
  const limitTip = `单组最多 ${state.groupLimit} 条`;
  if (group.isDefault) {
    bar.innerHTML = `<span class="group-bar-info">未归组的 ${group.count} 条档案单独摆在这个默认组里；把档案移进某个常用组后，它就从这里离开</span>`;
  } else {
    bar.innerHTML = `
      <span class="group-bar-name">${escapeHtml(group.name)}</span>
      <span class="group-bar-info">组内眼下有 <strong>${group.count}</strong> 条档案，${limitTip}</span>
      <button type="button" class="ghost" data-group-rename="${escapeHtml(group.id)}">重命名</button>
      <button type="button" class="ghost danger-text" data-group-delete="${escapeHtml(group.id)}">删除分组</button>
      <button type="button" class="ghost" data-group-sort="${escapeHtml(group.id)}">按偏移重排</button>
      <span class="group-bar-warn">按偏移重排会把这个组整体按标准偏移从小到大重排一遍，<strong>盖掉组内原来的手工顺序</strong></span>`;
  }
}

function renderZones() {
  const group = activeGroup();
  const scopeLabel = group ? `「${group.isDefault ? '未分组' : group.name}」里 ${state.zones.length} 条` : `当前筛选出 ${state.zones.length} 条`;
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；${scopeLabel}`;
  const body = el('zone-body');
  // 开着筛选时看到的是组内的子集，前后相邻关系不真实，顺序调整先关掉以免误操作
  const filterActive = !!(el('zone-filter-dst').value || el('zone-filter-keyword').value.trim());
  body.innerHTML = state.zones.map((item, index) => {
    const inCustomGroup = group && !group.isDefault;
    const orderDisabled = !inCustomGroup || filterActive;
    const upDisabled = orderDisabled || index === 0 ? ' disabled' : '';
    const downDisabled = orderDisabled || index === state.zones.length - 1 ? ' disabled' : '';
    const moveOptions = state.groups
      .filter((candidate) => candidate.id !== item.groupId)
      .map((candidate) => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.isDefault ? '未分组' : candidate.name)}</option>`)
      .join('');
    return `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="mono">${escapeHtml(item.yearRangeText)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions order-cell">
        <button type="button" class="link" data-zone-up="${escapeHtml(item.id)}"${upDisabled}>上移</button>
        <button type="button" class="link" data-zone-down="${escapeHtml(item.id)}"${downDisabled}>下移</button>
      </td>
      <td>
        <select class="move-select" data-zone-move="${escapeHtml(item.id)}">
          <option value="">移到…</option>${moveOptions}
        </select>
      </td>
      <td class="actions">
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  // 换算台的来源可选全部档案，不受当前正在查看哪个分组影响
  select.innerHTML = state.allZones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.allZones.some((item) => item.id === current)) select.value = current;
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

function openGroupForm(group) {
  state.groupEditingId = group ? group.id : '';
  el('group-form-title').textContent = group ? `重命名分组：${group.name}` : '新建分组';
  el('group-name-input').value = group ? group.name : '';
  el('group-form').classList.remove('hidden');
  el('group-name-input').focus();
  const submitButton = el('group-form').querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = group ? '保存新名字' : '保存分组';
  clearFieldMarks();
}

function closeGroupForm() {
  state.groupEditingId = '';
  el('group-form').classList.add('hidden');
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
    await refreshAll();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitGroup(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const name = el('group-name-input').value;
  const editing = state.groupEditingId;
  try {
    if (editing) {
      await request(`/api/groups/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      notify('分组已改名', 'ok');
    } else {
      const created = await request('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
      state.activeGroupId = created.id;
      notify(`分组「${created.name}」已建好`, 'ok');
    }
    closeGroupForm();
    await refreshAll();
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
  const data = node.dataset;

  if (data.groupTab) {
    clearNotice();
    state.activeGroupId = data.groupTab;
    loadZones().catch((err) => notify(err.message, 'error'));
    return;
  }

  if (node.id === 'group-new') {
    clearNotice();
    closeZoneForm();
    openGroupForm(null);
    return;
  }

  if (data.groupRename) {
    clearNotice();
    const found = state.groups.find((item) => item.id === data.groupRename);
    if (found) openGroupForm(found);
    return;
  }

  if (data.groupDelete) {
    clearNotice();
    const found = state.groups.find((item) => item.id === data.groupDelete);
    if (!found) return;
    const tip = found.count > 0
      ? `确定删除分组「${found.name}」吗？组内 ${found.count} 条档案不会被删除，会全部回到「未分组」里。`
      : `确定删除空分组「${found.name}」吗？`;
    if (!window.confirm(tip)) return;
    try {
      const result = await request(`/api/groups/${encodeURIComponent(found.id)}`, { method: 'DELETE' });
      state.activeGroupId = DEFAULT_GROUP_ID;
      notify(`分组「${result.name}」已删除，${result.releasedCount} 条档案回到了未分组`, 'ok');
      await refreshAll();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  // 重排前必须在页面上先提示：这一遍会盖掉组内的手工顺序
  if (data.groupSort) {
    clearNotice();
    const found = state.groups.find((item) => item.id === data.groupSort);
    if (!found) return;
    const confirmed = window.confirm(
      `将把分组「${found.name}」整体按标准偏移从小到大重排一遍。\n注意：重排会盖掉组内原来的手工上移下移顺序，确定继续吗？`,
    );
    if (!confirmed) return;
    try {
      await request('/api/groups/sort', {
        method: 'POST',
        body: JSON.stringify({ groupId: found.id, confirm: true }),
      });
      notify(`分组「${found.name}」已按偏移从小到大重排`, 'ok');
      await refreshAll();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (data.zoneUp || data.zoneDown) {
    clearNotice();
    const zoneId = data.zoneUp || data.zoneDown;
    const direction = data.zoneUp ? 'up' : 'down';
    try {
      await request('/api/groups/order', { method: 'POST', body: JSON.stringify({ zoneId, direction }) });
      await loadZones();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (data.zoneEdit) {
    clearNotice();
    const found = state.allZones.find((item) => item.id === data.zoneEdit)
      || state.zones.find((item) => item.id === data.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (data.zoneDelete) {
    clearNotice();
    const found = state.allZones.find((item) => item.id === data.zoneDelete)
      || state.zones.find((item) => item.id === data.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？`)) return;
    try {
      await request(`/api/zones/${encodeURIComponent(data.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === data.zoneDelete) closeZoneForm();
      notify('时区档案已删除', 'ok');
      await refreshAll();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

// 行内的「移到分组」下拉：选中目标组即发起移动，结果里写清从哪个组移到了哪个组
document.addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-zone-move]');
  if (!select) return;
  const zoneId = select.dataset.zoneMove;
  const groupId = select.value;
  select.value = '';
  if (!groupId) return;
  clearNotice();
  try {
    const result = await request('/api/groups/assign', {
      method: 'POST',
      body: JSON.stringify({ zoneId, groupId }),
    });
    if (result.moved) {
      notify(`已把「${result.zone.name}」从「${result.fromGroupName}」移到「${result.toGroupName}」`, 'ok');
    } else {
      notify(`「${result.zone.name}」本来就在「${result.toGroupName}」里`, 'ok');
    }
    // 档案离开了当前查看的组，标签仍停在本组，列表自然少一条；目标组的条数同步更新
    await refreshAll();
  } catch (err) {
    notify(err.message, 'error');
  }
});

el('zone-form').addEventListener('submit', submitZone);
el('group-form').addEventListener('submit', submitGroup);
el('group-cancel').addEventListener('click', closeGroupForm);
el('zone-new').addEventListener('click', () => {
  clearNotice();
  closeGroupForm();
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
  refreshAll().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-dst').addEventListener('change', () => {
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-keyword').addEventListener('keyup', (event) => {
  if (event.key === 'Enter') loadZones().catch((err) => notify(err.message, 'error'));
});
el('convert-run').addEventListener('click', runConvert);
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把分组与档案拉一遍，换算台的来源时区下拉按全量档案填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
refreshAll().catch((err) => notify(err.message, 'error'));
