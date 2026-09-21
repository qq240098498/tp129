// 常用组：把档案放进自己取名的几个组里，组内可手工调顺序，也可以整体按偏移重排。
// 一条档案至多属于一个组；没有归组的档案不属于任何组，由页面摆在默认组「未归组」里。
const crypto = require('crypto');
const {
  load,
  save,
  MAX_GROUP_NAME_LENGTH,
  MAX_ZONES_PER_GROUP,
} = require('./store');
const { ApiError, pickText } = require('./errors');
const { withOffsetText } = require('./zones');

const UNGROUPED_NAME = '未归组';

function findGroup(data, id) {
  const group = data.groups.find((item) => item.id === id);
  if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', '这个分组不存在或已被删除', 'groupId');
  return group;
}

function findZone(data, id) {
  const zone = data.zones.find((item) => item.id === id);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', 'zoneId');
  return zone;
}

// 档案当前落在哪个组里；不在任何组时返回 null，表示它在默认组「未归组」
function locateGroup(data, zoneId) {
  return data.groups.find((group) => group.zoneIds.includes(zoneId)) || null;
}

// 组名自己取，但不能为空、不能超长、不能跟别的组重名（大小写不敏感）
function validateGroupName(value, data, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'GROUP_NAME_REQUIRED', '请填写分组名称', 'groupName');
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    throw new ApiError(400, 'GROUP_NAME_TOO_LONG', `分组名称不能超过 ${MAX_GROUP_NAME_LENGTH} 个字符`, 'groupName');
  }
  const hit = data.groups.find((item) => item.id !== selfId && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'GROUP_NAME_DUPLICATED', `已经有叫「${hit.name}」的分组了，分组名称不能重复`, 'groupName');
  return name;
}

function groupView(data, group) {
  const byId = new Map(data.zones.map((zone) => [zone.id, zone]));
  const zones = group.zoneIds
    .map((zoneId) => byId.get(zoneId))
    .filter(Boolean)
    .map(withOffsetText);
  return {
    id: group.id,
    name: group.name,
    count: zones.length,
    zoneIds: zones.map((zone) => zone.id),
    zones,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

// 分组清单：自定义组按创建顺序给出，未归组作为默认组单独附在末尾，计数都当场算清
function listGroups() {
  const data = load();
  const grouped = new Set();
  data.groups.forEach((group) => group.zoneIds.forEach((zoneId) => grouped.add(zoneId)));
  const ungroupedZones = data.zones
    .filter((zone) => !grouped.has(zone.id))
    .map(withOffsetText)
    .sort((a, b) => {
      if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
      return a.name < b.name ? -1 : 1;
    });

  return {
    groups: data.groups.map((group) => groupView(data, group)),
    ungrouped: {
      id: '',
      name: UNGROUPED_NAME,
      count: ungroupedZones.length,
      zoneIds: ungroupedZones.map((zone) => zone.id),
      zones: ungroupedZones,
    },
    total: data.zones.length,
    limit: MAX_ZONES_PER_GROUP,
  };
}

// 新建组时可以直接带上一批档案；带了就要保证每条都存在且不超上限
function resolveInitialZoneIds(data, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, 'GROUP_ZONES_INVALID', '初始档案要按清单提交', 'zoneIds');
  }
  const seen = new Set();
  const zoneIds = [];
  value.forEach((raw) => {
    const zoneId = pickText(raw);
    if (!zoneId || seen.has(zoneId)) return;
    findZone(data, zoneId);
    seen.add(zoneId);
    zoneIds.push(zoneId);
  });
  if (zoneIds.length > MAX_ZONES_PER_GROUP) {
    throw new ApiError(
      409,
      'GROUP_FULL',
      `单个分组最多放 ${MAX_ZONES_PER_GROUP} 条档案，新分组一次放了 ${zoneIds.length} 条`,
      'zoneIds',
    );
  }
  return zoneIds;
}

function createGroup(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const name = validateGroupName(input.name, data, '');
  const zoneIds = resolveInitialZoneIds(data, input.zoneIds);
  const now = new Date().toISOString();
  const group = {
    id: crypto.randomUUID(),
    name,
    zoneIds,
    createdAt: now,
    updatedAt: now,
  };
  data.groups.push(group);
  save(data);
  return groupView(data, group);
}

function renameGroup(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const group = findGroup(data, id);
  group.name = validateGroupName(input.name, data, group.id);
  group.updatedAt = new Date().toISOString();
  save(data);
  return groupView(data, group);
}

// 删除组不会删掉档案：组里的档案一律退回默认组「未归组」
function deleteGroup(id) {
  const data = load();
  const index = data.groups.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'GROUP_NOT_FOUND', '这个分组不存在或已被删除', 'groupId');
  const [removed] = data.groups.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name, movedToUngrouped: removed.zoneIds.length };
}

// 把一条档案放进某个组；目标给空串表示退回未归组。
// 档案原先在别的组里会先从原组摘出，返回里写清从哪个组移到哪个组
function assignZone(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择要移动的档案', 'zoneId');
  const targetId = pickText(input.groupId);

  const data = load();
  const zone = findZone(data, zoneId);
  const from = locateGroup(data, zoneId);

  // 目标组不存在直接 404；空串表示默认组，不需要查找
  let target = null;
  if (targetId) target = findGroup(data, targetId);

  if (from && from.id === (target ? target.id : '')) {
    return {
      moved: false,
      zone: { id: zone.id, name: zone.name, displayName: zone.displayName },
      fromGroupId: from ? from.id : '',
      fromGroupName: from ? from.name : UNGROUPED_NAME,
      toGroupId: target ? target.id : '',
      toGroupName: target ? target.name : UNGROUPED_NAME,
    };
  }

  // 上限按目标组眼下的条数当场核对，超出就拒绝并指出是哪个组
  if (target && target.zoneIds.length >= MAX_ZONES_PER_GROUP) {
    throw new ApiError(
      409,
      'GROUP_FULL',
      `分组「${target.name}」最多放 ${MAX_ZONES_PER_GROUP} 条档案，眼下已经满了，没法再移入`,
      'groupId',
    );
  }

  if (from) from.zoneIds = from.zoneIds.filter((item) => item !== zoneId);
  if (target) target.zoneIds.push(zoneId);
  const now = new Date().toISOString();
  if (from) from.updatedAt = now;
  if (target) target.updatedAt = now;
  save(data);

  return {
    moved: true,
    zone: { id: zone.id, name: zone.name, displayName: zone.displayName },
    fromGroupId: from ? from.id : '',
    fromGroupName: from ? from.name : UNGROUPED_NAME,
    toGroupId: target ? target.id : '',
    toGroupName: target ? target.name : UNGROUPED_NAME,
  };
}

// 组内手工上移下移：跟相邻的档案换位。已经到边时明确拒绝，避免页面按钮失效时静默没反应
function reorderZone(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const zoneId = pickText(input.zoneId);
  const direction = pickText(input.direction);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择要调整顺序的档案', 'zoneId');
  if (direction !== 'up' && direction !== 'down') {
    throw new ApiError(400, 'REORDER_DIRECTION_INVALID', '调整方向只能是 up 或 down', 'direction');
  }

  const data = load();
  const group = findGroup(data, id);
  const index = group.zoneIds.indexOf(zoneId);
  if (index === -1) {
    throw new ApiError(400, 'ZONE_NOT_IN_GROUP', `这条档案不在分组「${group.name}」里，没法在组内调整顺序`, 'zoneId');
  }
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0) {
    throw new ApiError(400, 'REORDER_AT_EDGE', `「${group.name}」里这条档案已经在最上面了`, 'zoneId');
  }
  if (swapWith >= group.zoneIds.length) {
    throw new ApiError(400, 'REORDER_AT_EDGE', `「${group.name}」里这条档案已经在最下面了`, 'zoneId');
  }
  const [zone] = group.zoneIds.splice(index, 1);
  group.zoneIds.splice(swapWith, 0, zone);
  group.updatedAt = new Date().toISOString();
  save(data);
  return groupView(data, group);
}

// 整体按标准偏移从小到大重排，偏移相同按时区名排；这一遍会盖掉组内原来的手工顺序
function sortGroupByOffset(id) {
  const data = load();
  const group = findGroup(data, id);
  const byId = new Map(data.zones.map((zone) => [zone.id, zone]));
  group.zoneIds = group.zoneIds
    .map((zoneId) => byId.get(zoneId))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
      return a.name < b.name ? -1 : 1;
    })
    .map((zone) => zone.id);
  group.updatedAt = new Date().toISOString();
  save(data);
  return groupView(data, group);
}

module.exports = {
  UNGROUPED_NAME,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  assignZone,
  reorderZone,
  sortGroupByOffset,
};
