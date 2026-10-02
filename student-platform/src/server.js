import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, HttpError, fail, requireRole, text, now, id } from './store.js';
import { token, digest, passwordMatches, passwordHash, validPassword, secretMatches, strictJSON } from './security.js';

const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
export function createApp({ store = new Store(process.env.PLATFORM_DB || 'data/platform.sqlite'),
  origin = process.env.PLATFORM_ORIGIN || 'http://127.0.0.1:8787',
  serviceKey = process.env.LESSONFOLD_SERVICE_KEY || '', lessonfoldUrl = process.env.LESSONFOLD_URL || '' } = {}) {
  const secure = new URL(origin).protocol === 'https:';
  const limits = new Map();
  if (new URL(origin).origin !== origin) throw new Error('PLATFORM_ORIGIN must be an origin without a trailing slash or path');
  if (!secure && !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)) throw new Error('PLATFORM_ORIGIN must use HTTPS outside loopback');
  if (serviceKey && serviceKey.length < 32) throw new Error('LESSONFOLD_SERVICE_KEY must contain at least 32 characters');
  if (lessonfoldUrl) {
    const url = new URL(lessonfoldUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('LESSONFOLD_URL must use HTTPS');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid LESSONFOLD_URL');
  }
  function send(res, status, body, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...extra });
    res.end(JSON.stringify(body));
  }
  function body(req, maximum = 250000) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(400, 'JSON_REQUIRED', '请求须使用 application/json。');
    if (Number(req.headers['content-length']) > maximum) { req.resume(); fail(413, 'PAYLOAD_TOO_LARGE', '请求超过 250,000 字节，请拆分材料。'); }
    return new Promise((resolveBody, reject) => {
      const chunks = []; let size = 0, exceeded = false;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > maximum) {
          if (!exceeded) reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求超过大小限制，请拆分材料。'));
          exceeded = true; chunks.length = 0;
        } else if (!exceeded) chunks.push(chunk);
      });
      req.on('end', () => {
        if (exceeded) return;
        try {
          const raw = Buffer.concat(chunks);
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
          const value = strictJSON(decoded);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          resolveBody(value);
        } catch { reject(new HttpError(400, 'INVALID_JSON', '请求不是有效的 UTF-8 JSON 对象。')); }
      });
      req.on('error', reject);
    });
  }
  function session(req, mutation = false) {
    const raw = /(?:^|;\s*)platform_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const found = raw && store.one(`SELECT s.csrf,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, digest(raw), now());
    if (!found) fail(401, 'LOGIN_REQUIRED', '请先登录。');
    if (mutation && (req.headers.origin !== origin || !secretMatches(req.headers['x-csrf-token'], found.csrf)))
      fail(403, 'CSRF_REJECTED', '请求验证失败，请刷新页面。');
    return found;
  }
  function service(req) {
    if (!serviceKey || !secretMatches(req.headers.authorization, `Bearer ${serviceKey}`)) fail(401, 'INVALID_SERVICE', '服务身份验证失败。');
  }
  async function userBody(req, maximum) {
    const data = await body(req, maximum);
    // Recheck after reading a streamed body: another request may revoke access.
    session(req, true);
    return data;
  }
  function delegated(req, lessonId) {
    service(req);
    const raw = req.headers['x-lessonfold-delegation'];
    const grant = typeof raw === 'string' && store.one('SELECT * FROM delegations WHERE token_hash=? AND expires_at>?', digest(raw), now());
    if (!grant || grant.lesson_id !== lessonId) fail(401, 'INVALID_DELEGATION', '课次委托无效或已过期，请重新进入备课。');
    const binding = store.one('SELECT * FROM account_bindings WHERE tenant_id=? AND teacher_id=? AND lessonfold_user_id=? AND active=1',
      grant.tenant_id, grant.teacher_id, grant.lessonfold_user_id);
    const teacher = store.one("SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1 AND role='teacher'", grant.teacher_id, grant.tenant_id);
    if (!binding || !teacher) fail(403, 'ACCESS_REVOKED', '老师授权已撤销。');
    store.lessonFor(teacher, lessonId, true); return teacher;
  }
  function cleanUser(u) { return { id: u.id, tenant_id: u.tenant_id, username: u.username, display_name: u.display_name, role: u.role, student_id: u.student_id }; }
  function cookie(raw, maxAge = 28800) { return `platform_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`; }
  const server = createServer(async (req, res) => {
    const requestId = id('req');
    try {
      const url = new URL(req.url, origin), method = req.method;
      let path; try { path = decodeURIComponent(url.pathname); } catch { fail(400, 'INVALID_PATH', '请求路径无效。'); }
      if (path === '/health' && method === 'GET') {
        store.one('SELECT 1'); send(res, 200, { status: 'ok' }); return;
      }
      if (method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path]; const contents = readFileSync(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        res.end(contents); return;
      }
      if (path === '/api/login' && method === 'POST') {
        if (req.headers.origin !== origin) fail(403, 'CSRF_REJECTED', '登录来源验证失败。');
        const data = await body(req, 2000);
        const username = text(data.username, '用户名', 80), password = data.password;
        if (typeof password !== 'string' || !password.length || password.length > 200) fail(400, 'INVALID_FIELD', '密码格式错误。');
        const key = `${req.socket.remoteAddress}:${username}`;
        const recent = limits.get(key);
        if (recent && recent.until > Date.now() && recent.count >= 8) fail(429, 'LOGIN_RATE_LIMIT', '尝试过多，请 15 分钟后重试。');
        const attempts = recent && recent.until > Date.now() ? recent : { until: Date.now() + 900000, count: 0 };
        if (limits.size > 10000) for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k);
        if (limits.size > 10000) fail(429, 'LOGIN_RATE_LIMIT', '登录繁忙，请稍后再试。');
        attempts.count++; limits.set(key, attempts);
        const user = store.one('SELECT * FROM users WHERE username=? AND active=1', username);
        // Run scrypt for unknown users as well to reduce username timing signals.
        const matched = passwordMatches(password, user?.password || dummyPassword);
        if (!user || !matched) fail(401, 'INVALID_LOGIN', '用户名或密码错误。');
        limits.delete(key); store.run('DELETE FROM sessions WHERE expires_at<=?', now());
        const raw = token(), csrf = token();
        store.run('INSERT INTO sessions VALUES (?,?,?,?)', digest(raw), user.id, csrf, new Date(Date.now() + 28800000).toISOString());
        send(res, 200, { user: cleanUser(user), csrf }, { 'Set-Cookie': cookie(raw) }); return;
      }
      if (path === '/integrations/v1/lessonfold/launches/exchange' && method === 'POST') {
        service(req); const data = await body(req, 4000);
        const launch = text(data.launch_code, '入口码', 200), externalUser = text(data.lessonfold_user_id, 'Lessonfold 用户 ID');
        const result = store.transaction(() => {
          const row = store.one('SELECT * FROM launches WHERE token_hash=?', digest(launch));
          if (!row || row.expires_at <= now()) fail(401, 'LAUNCH_EXPIRED', '入口码无效或已过期。');
          if (row.consumed_at) fail(409, 'LAUNCH_CONSUMED', '入口码已消费。');
          const binding = store.one('SELECT * FROM account_bindings WHERE tenant_id=? AND teacher_id=? AND lessonfold_user_id=? AND active=1', row.tenant_id, row.teacher_id, externalUser);
          const user = store.one("SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1 AND role='teacher'", row.teacher_id, row.tenant_id);
          if (!binding || !user) fail(403, 'ACCOUNT_MISMATCH', '双方老师账号尚未核验或不匹配。');
          store.lessonFor(user, row.lesson_id, true); const raw = token();
          const expires = new Date(Date.now() + 28800000).toISOString();
          store.run('INSERT INTO delegations VALUES (?,?,?,?,?,?)', digest(raw), row.tenant_id, user.id, row.lesson_id, externalUser, expires);
          store.run('UPDATE launches SET consumed_at=? WHERE token_hash=?', now(), row.token_hash);
          store.audit(user, 'launch.exchanged', row.lesson_id);
          return { delegation_token: raw, expires_at: expires, tenant_id: row.tenant_id, teacher_id: user.id, lesson_id: row.lesson_id };
        }); send(res, 200, result); return;
      }
      const integration = /^\/integrations\/v1\/lessons\/([^/]+)\/(teaching-context|materials\/([^/]+))$/.exec(path);
      if (integration) {
        const user = delegated(req, integration[1]);
        if (method === 'GET' && integration[2] === 'teaching-context') { send(res, 200, store.context(user, integration[1])); return; }
        if (method === 'PUT' && integration[3]) {
          const publication = await body(req);
          const currentUser = delegated(req, integration[1]);
          const result = store.receivePublication(currentUser, integration[1], integration[3], publication);
          send(res, result.status, result.receipt); return;
        }
        fail(404, 'NOT_FOUND', '接口不存在。');
      }
      const user = session(req, !['GET', 'HEAD'].includes(method));
      if (path === '/api/me' && method === 'GET') { send(res, 200, { user: cleanUser(user), csrf: user.csrf }); return; }
      if (path === '/api/logout' && method === 'POST') {
        const raw = /platform_session=([^;]+)/.exec(req.headers.cookie)?.[1]; store.run('DELETE FROM sessions WHERE token_hash=?', digest(raw));
        send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return;
      }
      if (path === '/api/me/password' && method === 'POST') {
        const data = await userBody(req, 2000);
        const current = store.one('SELECT * FROM users WHERE id=?', user.id);
        if (typeof data.current_password !== 'string' || data.current_password.length > 200 || !passwordMatches(data.current_password, current.password))
          fail(403, 'INVALID_PASSWORD', '当前密码不正确。');
        if (!validPassword(data.new_password)) fail(400, 'WEAK_PASSWORD', '新密码需 12–200 个字符。');
        store.transaction(() => {
          store.run('UPDATE users SET password=? WHERE id=?', passwordHash(data.new_password), user.id);
          store.run('DELETE FROM sessions WHERE user_id=?', user.id);
          store.audit(user, 'user.password_changed', user.id);
        });
        send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return;
      }
      const resetPassword = /^\/api\/users\/([^/]+)\/password$/.exec(path);
      if (resetPassword && method === 'POST') {
        requireRole(user, 'admin'); const data = await userBody(req, 2000);
        const target = store.one('SELECT * FROM users WHERE id=? AND tenant_id=?', resetPassword[1], user.tenant_id);
        if (!target) fail(404, 'NOT_FOUND', '账号不存在。');
        if (!validPassword(data.new_password)) fail(400, 'WEAK_PASSWORD', '新密码需 12–200 个字符。');
        store.transaction(() => {
          store.run('UPDATE users SET password=? WHERE id=?', passwordHash(data.new_password), target.id);
          store.run('DELETE FROM sessions WHERE user_id=?', target.id);
          for (const table of ['launches', 'delegations']) store.run(`DELETE FROM ${table} WHERE teacher_id=?`, target.id);
          store.audit(user, 'user.password_reset', target.id);
        });
        send(res, 200, { ok: true }); return;
      }
      if (path === '/api/dashboard' && method === 'GET') {
        const classes = user.role === 'student' ? [] : store.all(`SELECT c.*,u.display_name teacher_name FROM classes c JOIN users u ON u.id=c.teacher_id
          WHERE c.tenant_id=?${user.role === 'teacher' ? ' AND c.teacher_id=?' : ''} ORDER BY c.name`, ...[user.tenant_id, ...(user.role === 'teacher' ? [user.id] : [])]).map(c => ({ ...c, curriculum: JSON.parse(c.curriculum) }));
        const students = user.role === 'student' ? [] : store.all('SELECT * FROM students WHERE tenant_id=? ORDER BY display_name,id', user.tenant_id).filter(s => {
          try { store.studentFor(user, s.id); return true; } catch { return false; }
        });
        const lessons = store.all('SELECT id FROM lessons WHERE tenant_id=? ORDER BY starts_at DESC', user.tenant_id).flatMap(l => {
          try { const row = store.lessonFor(user, l.id); return [{ ...row, material_count: store.publicationsFor(user, l.id).length,
            pending_observation_count: user.role === 'student' ? 0 : store.one("SELECT count(*) n FROM observations WHERE lesson_id=? AND status='draft'", l.id).n }]; } catch { return []; }
        });
        const followups = user.role === 'teacher' ? store.all("SELECT f.*,s.display_name student_name FROM follow_ups f JOIN students s ON s.id=f.student_id WHERE f.tenant_id=? AND f.status='open' ORDER BY f.due_at,f.id", user.tenant_id).filter(f => {
          try { store.lessonFor(user, f.lesson_id, true); store.studentFor(user, f.student_id); return true; } catch { return false; }
        }) : [];
        send(res, 200, { classes, students, lessons, follow_ups: followups, integration_configured: !!(serviceKey && lessonfoldUrl) }); return;
      }
      if (path === '/api/users' && method === 'GET') {
        requireRole(user, 'admin'); send(res, 200, store.all('SELECT id,display_name,username,role,student_id,active FROM users WHERE tenant_id=? ORDER BY role,display_name', user.tenant_id)); return;
      }
      if (path === '/api/users' && method === 'POST') {
        requireRole(user, 'admin'); const data = await userBody(req, 4000);
        const created = store.addUser({ ...data, tenant_id: user.tenant_id }); store.audit(user, 'user.created', created.id);
        send(res, 201, cleanUser(created)); return;
      }
      const accountUser = /^\/api\/users\/([^/]+)$/.exec(path);
      if (accountUser && method === 'PATCH') {
        requireRole(user, 'admin'); const data = await userBody(req, 2000);
        const target = store.one('SELECT * FROM users WHERE id=? AND tenant_id=?', accountUser[1], user.tenant_id);
        if (!target) fail(404, 'NOT_FOUND', '账号不存在。');
        if (typeof data.active !== 'boolean' || target.id === user.id) fail(400, 'INVALID_USER_UPDATE', '不能停用自己，active 须为布尔值。');
        store.run('UPDATE users SET active=? WHERE id=?', Number(data.active), target.id);
        store.run('DELETE FROM sessions WHERE user_id=?', target.id); store.audit(user, 'user.access_changed', target.id);
        for (const table of ['launches', 'delegations']) store.run(`DELETE FROM ${table} WHERE teacher_id=?`, target.id);
        send(res, 200, { id: target.id, active: data.active }); return;
      }
      if (path === '/api/students' && method === 'POST') { send(res, 201, store.createStudent(user, await userBody(req))); return; }
      const student = /^\/api\/students\/([^/]+)$/.exec(path);
      if (student && method === 'PATCH') { send(res, 200, store.updateStudent(user, student[1], await userBody(req))); return; }
      if (student && method === 'GET') { send(res, 200, store.studentProfile(user, student[1])); return; }
      if (path === '/api/classes' && method === 'POST') { send(res, 201, store.createClass(user, await userBody(req))); return; }
      const cls = /^\/api\/classes\/([^/]+)$/.exec(path);
      if (cls && method === 'PATCH') { send(res, 200, store.updateClass(user, cls[1], await userBody(req))); return; }
      if (cls && method === 'GET') {
        const row = store.classFor(user, cls[1]); send(res, 200, { ...row,
          memberships: store.all('SELECT m.*,s.display_name FROM memberships m JOIN students s ON s.id=m.student_id WHERE m.class_id=? ORDER BY m.valid_from', row.id)
            .filter(m => user.role === 'admin' || store.isMember(row.id, m.student_id, now())) }); return;
      }
      const enroll = /^\/api\/classes\/([^/]+)\/memberships$/.exec(path);
      if (enroll && method === 'POST') { send(res, 201, store.enroll(user, enroll[1], await userBody(req))); return; }
      const member = /^\/api\/memberships\/([^/]+)$/.exec(path);
      if (member && method === 'PATCH') { send(res, 200, store.endMembership(user, member[1], await userBody(req))); return; }
      if (path === '/api/lessons' && method === 'POST') { send(res, 201, store.createLesson(user, await userBody(req))); return; }
      const lesson = /^\/api\/lessons\/([^/]+)$/.exec(path);
      if (lesson && method === 'PATCH') { send(res, 200, store.updateLesson(user, lesson[1], await userBody(req))); return; }
      if (lesson && method === 'GET') {
        const row = store.lessonFor(user, lesson[1]);
        send(res, 200, { ...row, students: user.role === 'student' ? [] : store.roster(user, row),
          observations: user.role === 'teacher' ? store.all('SELECT * FROM observations WHERE lesson_id=? AND tenant_id=? ORDER BY observed_at DESC', row.id, user.tenant_id)
            .filter(o => store.roster(user, row).some(s => s.id === o.student_id)) : [], publications: store.publicationsFor(user, row.id),
          attendance: store.all(`SELECT * FROM attendance WHERE lesson_id=?${user.role === 'student' ? ' AND student_id=?' : ''}`,
            row.id, ...user.role === 'student' ? [user.student_id] : []).filter(a => user.role === 'student' || store.roster(user, row).some(s => s.id === a.student_id)) }); return;
      }
      const attendance = /^\/api\/lessons\/([^/]+)\/attendance$/.exec(path);
      if (attendance && method === 'PUT') { send(res, 200, store.recordAttendance(user, attendance[1], await userBody(req))); return; }
      const context = /^\/api\/lessons\/([^/]+)\/teaching-context$/.exec(path);
      if (context && method === 'GET') { send(res, 200, store.context(user, context[1])); return; }
      const observation = /^\/api\/lessons\/([^/]+)\/observations$/.exec(path);
      if (observation && method === 'POST') { send(res, 201, store.createObservation(user, observation[1], await userBody(req))); return; }
      const confirmation = /^\/api\/observations\/([^/]+)\/confirm$/.exec(path);
      if (confirmation && method === 'POST') { send(res, 200, store.confirmObservation(user, confirmation[1], await userBody(req))); return; }
      const editObservation = /^\/api\/observations\/([^/]+)$/.exec(path);
      if (editObservation && method === 'PATCH') { send(res, 200, store.updateObservation(user, editObservation[1], await userBody(req))); return; }
      const followup = /^\/api\/lessons\/([^/]+)\/follow-ups$/.exec(path);
      if (followup && method === 'POST') { send(res, 201, store.createFollowUp(user, followup[1], await userBody(req))); return; }
      const completed = /^\/api\/follow-ups\/([^/]+)\/complete$/.exec(path);
      if (completed && method === 'POST') { send(res, 200, store.completeFollowUp(user, completed[1], await userBody(req))); return; }
      if (path === '/api/account-bindings' && method === 'GET') {
        requireRole(user, 'admin'); send(res, 200, store.all('SELECT * FROM account_bindings WHERE tenant_id=?', user.tenant_id)); return;
      }
      if (path === '/api/audit-events' && method === 'GET') {
        requireRole(user, 'admin'); send(res, 200, store.all(`SELECT a.*,u.display_name actor_name FROM audit_events a
          LEFT JOIN users u ON u.id=a.actor_id WHERE a.tenant_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 200`, user.tenant_id)); return;
      }
      if (path === '/api/account-bindings' && method === 'POST') { send(res, 201, store.bindAccount(user, await userBody(req))); return; }
      if (path === '/api/account-bindings' && method === 'PATCH') {
        requireRole(user, 'admin'); const data = await userBody(req); store.teacher(user, data.teacher_id);
        store.run('UPDATE account_bindings SET active=0 WHERE tenant_id=? AND teacher_id=?', user.tenant_id, data.teacher_id);
        for (const table of ['launches', 'delegations']) store.run(`DELETE FROM ${table} WHERE teacher_id=? AND tenant_id=?`, data.teacher_id, user.tenant_id);
        store.audit(user, 'account.revoked', data.teacher_id); send(res, 200, { ok: true }); return;
      }
      if (path === '/integrations/v1/lessonfold/launches' && method === 'POST') {
        if (!serviceKey || !lessonfoldUrl) fail(503, 'INTEGRATION_NOT_CONFIGURED', '管理员尚未配置 Lessonfold 连接。');
        const data = await userBody(req, 2000); store.lessonFor(user, data.lesson_id, true);
        if (!store.one('SELECT teacher_id FROM account_bindings WHERE teacher_id=? AND tenant_id=? AND active=1', user.id, user.tenant_id))
          fail(422, 'ACCOUNT_NOT_BOUND', '请由管理员核验并绑定双方教师账号。');
        const raw = token(), expires = new Date(Date.now() + 300000).toISOString();
        store.run('DELETE FROM launches WHERE expires_at<=?', now()); store.run('DELETE FROM delegations WHERE expires_at<=?', now());
        store.run('INSERT INTO launches VALUES (?,?,?,?,?,NULL)', digest(raw), user.tenant_id, user.id, data.lesson_id, expires);
        const launchUrl = new URL(lessonfoldUrl); launchUrl.searchParams.set('launch', raw);
        store.audit(user, 'launch.created', data.lesson_id); send(res, 201, { launch_url: launchUrl.href, expires_at: expires }); return;
      }
      fail(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      const expected = error instanceof HttpError;
      if (!expected) console.error(JSON.stringify({ request_id: requestId, code: 'INTERNAL_ERROR' }));
      if (!res.headersSent) send(res, expected ? error.status : 500, { error: { code: expected ? error.code : 'INTERNAL_ERROR',
        message: expected ? error.message : '服务暂时不可用，请稍后重试。', request_id: requestId, retryable: !expected || error.status === 503 || error.status === 429 } });
    }
  });
  const dummyPassword = passwordHash('invalid-user-dummy-password');
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return { server, store };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787);
  if (!['localhost','127.0.0.1','::1'].includes(host) && !process.env.PLATFORM_ORIGIN?.startsWith('https://'))
    throw new Error('Non-loopback deployment requires an HTTPS PLATFORM_ORIGIN and a TLS reverse proxy');
  const { server, store } = createApp();
  server.listen(port, host, () => console.log(`Student platform listening on ${process.env.PLATFORM_ORIGIN || `http://${host}:${port}`}`));
  function stop() { server.close(() => { store.db.close(); process.exit(0); }); }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
