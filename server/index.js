const path = require('path');
const express = require('express');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 5129;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 健康检查：页面右上角据此显示服务连接状态
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT });
});

app.get('/api/zones', (req, res) => {
  try {
    res.json(api.listZones({
      dst: api.readQuery(req.query, 'dst'),
      keyword: api.readQuery(req.query, 'keyword'),
      groupId: api.readQuery(req.query, 'groupId'),
    }));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/zones', (req, res) => {
  try {
    res.status(201).json(api.createZone(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/zones/:id', (req, res) => {
  try {
    res.json(api.getZone(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/zones/:id', (req, res) => {
  try {
    res.json(api.updateZone(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/zones/:id', (req, res) => {
  try {
    res.json(api.deleteZone(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// 常用分组：清单、建组、改名、删组
app.get('/api/groups', (_req, res) => {
  res.json(api.listGroups());
});

app.post('/api/groups', (req, res) => {
  try {
    res.status(201).json(api.createGroup(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/groups/:id', (req, res) => {
  try {
    res.json(api.renameGroup(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/groups/:id', (req, res) => {
  try {
    res.json(api.deleteGroup(req.params.id));
  }
  catch (err) {
    sendError(res, err);
  }
});

// 档案归属与组内顺序：跨组移动、上移下移、整组按偏移重排
app.post('/api/groups/assign', (req, res) => {
  try {
    res.json(api.setZoneGroup(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/groups/order', (req, res) => {
  try {
    res.json(api.shiftZoneOrder(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/groups/sort', (req, res) => {
  try {
    res.json(api.sortGroupByOffset(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// 换算：给一个时刻与来源时区，列出各时区对应的当地时刻
app.post('/api/convert', (req, res) => {
  try {
    res.json(api.convert(req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

// 未匹配到的接口路径统一返回说明，避免前端拿到一串页面内容
app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'API_NOT_FOUND', message: '接口不存在', field: '' } });
});

// 统一错误出口：业务异常按状态码与错误码返回，其余按服务异常处理
function sendError(res, err) {
  if (err instanceof api.ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, field: err.field },
    });
  }
  console.error('[tp129] 处理请求时出现未预期的问题：', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: '服务内部异常，请稍后重试', field: '' },
  });
}

// 请求体解析失败时给出明确说明
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'BODY_INVALID_JSON', message: '提交的内容不是合法的 JSON', field: '' },
    });
  }
  if (err) return sendError(res, err);
  return next();
});

app.listen(PORT, () => {
  console.log(`时区与时间换算工作台已启动：http://localhost:${PORT}`);
});
