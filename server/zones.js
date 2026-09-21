const crypto = require('crypto');
const { load, save, MIN_OFFSET, MAX_OFFSET, MIN_YEAR, MAX_YEAR, MAX_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH, MAX_NOTE_LENGTH, DEFAULT_GROUP_ID } = require('./store');
const { ApiError, pickText } = require('./errors');
const { removeZoneFromGroups } = require('./groups');

// 时区名固定成地区加城市的写法，UTC 单独允许
const NAME_PATTERN = /^([A-Za-z_]+(\/[A-Za-z_]+)+|UTC)$/;
const WEEK_TOKENS = ['1', '2', '3', '4', 'last'];

function validateName(value, data, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写时区名称', 'name');
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `时区名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'NAME_INVALID', '时区名称要写成地区加城市，例如 Asia/Shanghai，基准时可以写 UTC', 'name');
  }
  const hit = data.zones.find((item) => item.id !== selfId && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'NAME_DUPLICATED', `${hit.name} 已经登记过了`, 'name');
  return name;
}

function validateDisplayName(value) {
  const displayName = pickText(value);
  if (!displayName) throw new ApiError(400, 'DISPLAY_NAME_REQUIRED', '请填写显示名称', 'displayName');
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ApiError(400, 'DISPLAY_NAME_TOO_LONG', `显示名称不能超过 ${MAX_DISPLAY_NAME_LENGTH} 个字符`, 'displayName');
  }
  return displayName;
}

// 偏移一律按分钟存，允许半小时与三刻这样的写法
function validateOffset(value, field) {
  const raw = typeof value === 'number' ? value : Number(pickText(String(value === undefined || value === null ? '' : value)));
  if (!Number.isInteger(raw)) {
    throw new ApiError(400, 'OFFSET_INVALID', '偏移要写成整数分钟，例如东八区写 480', field);
  }
  if (raw < MIN_OFFSET || raw > MAX_OFFSET) {
    throw new ApiError(400, 'OFFSET_OUT_OF_RANGE', `偏移要在 ${MIN_OFFSET} 到 ${MAX_OFFSET} 分钟之间`, field);
  }
  return raw;
}

// 夏令时规则里的一段：第几个星期几的几点几分
function validateRulePart(value, field) {
  const source = value && typeof value === 'object' ? value : {};
  const month = Number(source.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'DST_MONTH_INVALID', '切换月份要填一到十二', field);
  }
  const week = String(source.week);
  if (!WEEK_TOKENS.includes(week)) {
    throw new ApiError(400, 'DST_WEEK_INVALID', '第几个星期只能填一到四，或者填最后一个', field);
  }
  const weekday = Number(source.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ApiError(400, 'DST_WEEKDAY_INVALID', '星期要填零到六，零表示周日', field);
  }
  const hour = Number(source.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(400, 'DST_HOUR_INVALID', '切换时刻的小时要填零到二十三', field);
  }
  const minute = Number(source.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ApiError(400, 'DST_MINUTE_INVALID', '切换时刻的分钟要填零到五十九', field);
  }
  return { month, week, weekday, hour, minute };
}

function sameRulePart(a, b) {
  if (!a || !b) return false;
  return a.month === b.month && a.week === b.week && a.weekday === b.weekday
    && a.hour === b.hour && a.minute === b.minute;
}

function validateYear(value, field, label) {
  if (value === undefined || value === null || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `${label}要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, field);
  }
  return year;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 一整条档案的校验：偏移、夏令时三段与生效年份要能对得上
function validatePayload(input, data, selfId) {
  const name = validateName(input.name, data, selfId);
  const displayName = validateDisplayName(input.displayName);
  const offsetMinutes = validateOffset(input.offsetMinutes, 'offsetMinutes');
  const usesDst = input.usesDst === true || input.usesDst === 'true';
  const fromYear = validateYear(input.fromYear, 'fromYear', '开始年份');
  const toYear = validateYear(input.toYear, 'toYear', '结束年份');

  if (fromYear !== null && toYear !== null && toYear < fromYear) {
    throw new ApiError(400, 'YEAR_RANGE_INVALID', '结束年份不能早于开始年份', 'toYear');
  }

  let dstOffsetMinutes = null;
  let dstStart = null;
  let dstEnd = null;

  if (usesDst) {
    dstOffsetMinutes = validateOffset(input.dstOffsetMinutes, 'dstOffsetMinutes');
    if (dstOffsetMinutes <= offsetMinutes) {
      throw new ApiError(400, 'DST_OFFSET_INVALID', '夏令时偏移要比标准偏移更靠前，也就是数值更大', 'dstOffsetMinutes');
    }
    if (!input.dstStart || !input.dstEnd) {
      throw new ApiError(400, 'DST_RULE_REQUIRED', '实行夏令时的时区要把开始与结束两段规则都填上', 'dstStart');
    }
    dstStart = validateRulePart(input.dstStart, 'dstStart');
    dstEnd = validateRulePart(input.dstEnd, 'dstEnd');
    if (sameRulePart(dstStart, dstEnd)) {
      throw new ApiError(400, 'DST_RULE_SAME', '开始与结束两段规则不能完全相同，否则推算不出切换区间', 'dstEnd');
    }
  }

  return {
    name,
    displayName,
    offsetMinutes,
    usesDst,
    dstOffsetMinutes,
    dstStart,
    dstEnd,
    fromYear: fromYear === null ? MIN_YEAR : fromYear,
    toYear,
    note: validateNote(input.note),
  };
}

// 偏移的展示写法，半小时与三刻都要看得清
function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hour = String(Math.floor(abs / 60)).padStart(2, '0');
  const minute = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hour}:${minute}`;
}

function withOffsetText(zone, groupId) {
  return {
    ...zone,
    groupId: groupId || DEFAULT_GROUP_ID,
    offsetText: offsetText(zone.offsetMinutes),
    dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    yearRangeText: zone.toYear === null ? `${zone.fromYear} 年起` : `${zone.fromYear} 至 ${zone.toYear}`,
  };
}

function sortZones(list) {
  return list.slice().sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });
}

function matchesFilters(zone, dst, keyword) {
  if (dst === 'yes' && !zone.usesDst) return false;
  if (dst === 'no' && zone.usesDst) return false;
  if (keyword) {
    return zone.name.toLowerCase().includes(keyword)
      || zone.displayName.toLowerCase().includes(keyword)
      || zone.note.toLowerCase().includes(keyword);
  }
  return true;
}

// 档案清单：可限定在某个分组内查看。自定义组按组内手工顺序返回，默认组与全部视角按偏移排序
function listZones(options) {
  const input = options && typeof options === 'object' ? options : {};
  const dst = pickText(input.dst);
  const keyword = pickText(input.keyword).toLowerCase();
  const groupId = pickText(input.groupId);
  const data = load();

  let scoped;
  let scopeName = '';
  if (groupId) {
    if (groupId === DEFAULT_GROUP_ID) {
      const claimed = new Set();
      data.groups.forEach((group) => group.zoneIds.forEach((id) => claimed.add(id)));
      // 默认组没有手工顺序，统一按偏移从小到大排
      scoped = sortZones(data.zones.filter((zone) => !claimed.has(zone.id)));
      scopeName = '未分组';
    } else {
      const group = data.groups.find((item) => item.id === groupId);
      if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', '这个分组不存在，可能已被删除', 'groupId');
      const byId = new Map(data.zones.map((zone) => [zone.id, zone]));
      scoped = group.zoneIds.map((id) => byId.get(id)).filter(Boolean);
      scopeName = group.name;
    }
    scoped = scoped.filter((zone) => matchesFilters(zone, dst, keyword));
  } else {
    scoped = data.zones.filter((zone) => matchesFilters(zone, dst, keyword));
    scoped = sortZones(scoped);
  }

  const ownerOf = new Map();
  data.groups.forEach((group) => {
    group.zoneIds.forEach((id) => ownerOf.set(id, group.id));
  });

  return {
    zones: scoped.map((zone) => withOffsetText(zone, ownerOf.get(zone.id) || DEFAULT_GROUP_ID)),
    total: data.zones.length,
    dstCount: data.zones.filter((item) => item.usesDst).length,
    noDstCount: data.zones.filter((item) => !item.usesDst).length,
    groupId: groupId || '',
    groupName: scopeName,
  };
}

function getZone(id) {
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  const owner = data.groups.find((group) => group.zoneIds.includes(id));
  return withOffsetText(found, owner ? owner.id : DEFAULT_GROUP_ID);
}

function createZone(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const checked = validatePayload(input, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.zones.push(created);
  // 新档案默认不归属任何常用组，先出现在未分组里，不会凭空消失
  save(data);
  return withOffsetText(created, DEFAULT_GROUP_ID);
}

function updateZone(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');

  const merged = {
    name: input.name === undefined ? found.name : input.name,
    displayName: input.displayName === undefined ? found.displayName : input.displayName,
    offsetMinutes: input.offsetMinutes === undefined ? found.offsetMinutes : input.offsetMinutes,
    usesDst: input.usesDst === undefined ? found.usesDst : (input.usesDst === true || input.usesDst === 'true'),
    dstOffsetMinutes: input.dstOffsetMinutes === undefined ? found.dstOffsetMinutes : input.dstOffsetMinutes,
    dstStart: input.dstStart === undefined ? found.dstStart : input.dstStart,
    dstEnd: input.dstEnd === undefined ? found.dstEnd : input.dstEnd,
    fromYear: input.fromYear === undefined ? found.fromYear : input.fromYear,
    toYear: input.toYear === undefined ? found.toYear : input.toYear,
    note: input.note === undefined ? found.note : input.note,
  };

  const checked = validatePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  const owner = data.groups.find((group) => group.zoneIds.includes(id));
  return withOffsetText(found, owner ? owner.id : DEFAULT_GROUP_ID);
}

function deleteZone(id) {
  const data = load();
  const index = data.zones.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  const [removed] = data.zones.splice(index, 1);
  // 档案删掉的同时把它从所有组的顺序里摘掉，组内不会留下空编号
  removeZoneFromGroups(data, id);
  save(data);
  return { id: removed.id, name: removed.name, displayName: removed.displayName };
}

module.exports = {
  listZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  offsetText,
  withOffsetText,
};
