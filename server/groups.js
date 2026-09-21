// 分组这一层只管常用组本身：建组、改名、删组、跨组移动、组内上下移与按偏移整体重排。
// 组与档案的归属只存在分组的 zoneIds 里，删掉组不会删掉档案，它们自动回到「未分组」。
const crypto = require('crypto');
const {
  load,
  save,
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  MAX_GROUP_NAME_LENGTH,
  MAX_GROUPS,
  MAX_ZONES_PER_GROUP,
} = require('./store');
const { ApiError, pickText } = require('./errors');

// 已经被任何自定义组收走的档案编号
function claimedZoneSet(data) {
  const claimed = new Set();
  data.groups.forEach((group) => {
    group.zoneIds.forEach((id) => claimed.add(id));
  });
  return claimed;
}

// 默认组是虚拟的：不在数据里落记录，内容按档案表实时算，顺序跟随档案表
function defaultGroupView(data) {
  const claimed = claimedZoneSet(data);
  const zoneIds = data.zones.filter((zone) => !claimed.has(zone.id)).map((zone) => zone.id);
  return {
    id: DEFAULT_GROUP_ID,
    name: DEFAULT_GROUP_NAME,
    isDefault: true,
    zoneIds,
    count: zoneIds.length,
    createdAt: null,
    updatedAt: null,
  };
}

function groupView(group) {
  return {
    id: group.id,
    name: group.name,
    isDefault: false,
    zoneIds: group.zoneIds.slice(),
    count: group.zoneIds.length,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

// 对外的分组清单：默认组永远在第一个，后面按建组顺序排自定义组
function listGroups() {
  const data = load();
  return {
    groups: [defaultGroupView(data), ...data.groups.map(groupView)],
    totalZones: data.zones.length,
    limit: MAX_ZONES_PER_GROUP,
  };
}

function validateGroupName(value, data, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'GROUP_NAME_REQUIRED', '请填写分组名称', 'name');
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    throw new ApiError(400, 'GROUP_NAME_TOO_LONG', `分组名称不能超过 ${MAX_GROUP_NAME_LENGTH} 个字符`, 'name');
  }
  const hit = data.groups.find((group) => group.id !== selfId && group.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'GROUP_NAME_DUPLICATED', `已经有一个叫「${hit.name}」的分组了，分组名称不能重复`, 'name');
  return name;
}

function findCustomGroup(data, id) {
  return data.groups.find((group) => group.id === id) || null;
}

// 默认组只能看，不能改名、删除或整体重排，操作它时直接挡回去
function ensureCustomGroup(data, id) {
  if (id === DEFAULT_GROUP_ID) {
    throw new ApiError(400, 'DEFAULT_GROUP_PROTECTED', '「未分组」是系统默认组，不能改名、删除或重排', 'groupId');
  }
  const group = findCustomGroup(data, id);
  if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', '这个分组不存在，可能已被删除', 'groupId');
  return group;
}

function createGroup(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  if (data.groups.length >= MAX_GROUPS) {
    throw new ApiError(400, 'GROUP_LIMIT_REACHED', `最多只能建 ${MAX_GROUPS} 个分组`, 'name');
  }
  const name = validateGroupName(input.name, data, '');
  const now = new Date().toISOString();
  const group = { id: crypto.randomUUID(), name, zoneIds: [], createdAt: now, updatedAt: now };
  data.groups.push(group);
  save(data);
  return groupView(group);
}

function renameGroup(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const group = ensureCustomGroup(data, id);
  group.name = validateGroupName(input.name, data, group.id);
  group.updatedAt = new Date().toISOString();
  save(data);
  return groupView(group);
}

// 删组只删组本身：组里档案的归属随 zoneIds 一起消失，页面刷新后它们出现在未分组里
function deleteGroup(id) {
  const data = load();
  const group = ensureCustomGroup(data, id);
  const index = data.groups.findIndex((item) => item.id === id);
  data.groups.splice(index, 1);
  save(data);
  return { id: group.id, name: group.name, releasedCount: group.zoneIds.length };
}

function locateZone(data, zoneId) {
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', 'zoneId');
  const owner = data.groups.find((group) => group.zoneIds.includes(zoneId));
  return { zone, owner: owner || null };
}

// 把一条档案从原来的组挪到另一个组；默认组用固定编号 default 表示
function setZoneGroup(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择要移动的档案', 'zoneId');
  const targetId = pickText(input.groupId) || DEFAULT_GROUP_ID;

  const data = load();
  const { zone, owner } = locateZone(data, zoneId);
  const fromGroupId = owner ? owner.id : DEFAULT_GROUP_ID;
  const fromGroupName = owner ? owner.name : DEFAULT_GROUP_NAME;
  const target = targetId === DEFAULT_GROUP_ID ? null : ensureCustomGroup(data, targetId);
  const toGroupId = target ? target.id : DEFAULT_GROUP_ID;
  const toGroupName = target ? target.name : DEFAULT_GROUP_NAME;

  if (fromGroupId === toGroupId) {
    // 已经在目标组里，什么都不用动，但把来处与去处照常写清楚
    return {
      zone: { id: zone.id, name: zone.name, displayName: zone.displayName },
      fromGroupId, fromGroupName, toGroupId, toGroupName, moved: false,
    };
  }

  // 上限在真正写入之前拦：目标组已满时当场拒绝，并指出是哪个组
  if (target && target.zoneIds.length >= MAX_ZONES_PER_GROUP) {
    throw new ApiError(
      400,
      'GROUP_FULL',
      `分组「${target.name}」最多容纳 ${MAX_ZONES_PER_GROUP} 条档案，眼下已经满了，不能再移入`,
      'groupId',
    );
  }

  if (owner) owner.zoneIds = owner.zoneIds.filter((id) => id !== zoneId);
  if (target) {
    target.zoneIds.push(zoneId);
    target.updatedAt = new Date().toISOString();
  }
  save(data);

  return {
    zone: { id: zone.id, name: zone.name, displayName: zone.displayName },
    fromGroupId, fromGroupName, toGroupId, toGroupName, moved: true,
  };
}

// 组内手工顺序：上移与前移一位、下移与后移一位，到边了就拒绝而不是静默
function shiftZoneOrder(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择要调整顺序的档案', 'zoneId');
  const direction = pickText(input.direction);
  if (direction !== 'up' && direction !== 'down') {
    throw new ApiError(400, 'ORDER_DIRECTION_INVALID', '调整方向只能是 up 或 down', 'direction');
  }

  const data = load();
  const group = data.groups.find((item) => item.zoneIds.includes(zoneId));
  if (!group) {
    throw new ApiError(400, 'ORDER_NOT_MANUAL', '「未分组」按偏移自动排列，不支持手工上下移；先把档案移进常用组', 'zoneId');
  }
  const index = group.zoneIds.indexOf(zoneId);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= group.zoneIds.length) {
    throw new ApiError(400, 'ORDER_AT_EDGE', direction === 'up' ? '这条档案已经在组内最前面' : '这条档案已经在组内最后面', 'zoneId');
  }
  [group.zoneIds[index], group.zoneIds[swapWith]] = [group.zoneIds[swapWith], group.zoneIds[index]];
  group.updatedAt = new Date().toISOString();
  save(data);
  return groupView(group);
}

// 整个组按偏移从小到大重排一遍，会盖掉组内原来的手工顺序；
// 调用方必须显式带上 confirm: true，表示页面已经就这件事提示过用户
function sortGroupByOffset(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const groupId = pickText(input.groupId);
  if (!groupId) throw new ApiError(400, 'GROUP_REQUIRED', '请选择要重排的分组', 'groupId');
  if (input.confirm !== true) {
    throw new ApiError(
      400,
      'GROUP_SORT_NEEDS_CONFIRM',
      '按偏移重排会盖掉这个组原来的手工顺序，请先在页面上确认',
      'groupId',
    );
  }

  const data = load();
  const group = ensureCustomGroup(data, groupId);
  const byId = new Map(data.zones.map((zone) => [zone.id, zone]));
  group.zoneIds.sort((a, b) => {
    const left = byId.get(a);
    const right = byId.get(b);
    if (!left || !right) return 0;
    if (left.offsetMinutes !== right.offsetMinutes) return left.offsetMinutes - right.offsetMinutes;
    return left.name < right.name ? -1 : 1;
  });
  group.updatedAt = new Date().toISOString();
  save(data);
  return groupView(group);
}

// 删除档案时调用：把它从所有分组的顺序里摘掉，归属自然回到不存在（即未分组）
function removeZoneFromGroups(data, zoneId) {
  data.groups.forEach((group) => {
    group.zoneIds = group.zoneIds.filter((id) => id !== zoneId);
  });
}

module.exports = {
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setZoneGroup,
  shiftZoneOrder,
  sortGroupByOffset,
  removeZoneFromGroups,
  defaultGroupView,
  groupView,
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  MAX_ZONES_PER_GROUP,
};
