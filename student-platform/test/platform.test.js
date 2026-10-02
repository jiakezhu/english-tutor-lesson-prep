import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, timestamp } from '../src/store.js';
import { createApp } from '../src/server.js';
import { seedDemo } from '../src/cli.js';
import { token, digest, publicationHash, canonicalJSON, strictJSON } from '../src/security.js';

const password = 'test-only-password-123';
const origin = 'http://127.0.0.1:8787';
const serviceKey = 'test-only-service-key-at-least-32-characters';
async function fixture(t, options = {}) {
  const store = new Store(options.path);
  const demo = seedDemo(store, password);
  const { server } = createApp({ store, origin, serviceKey, lessonfoldUrl: 'https://lessonfold.example/', ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.db.close(); });
  const auth = user => {
    const raw = token(), csrf = token();
    store.run('INSERT INTO sessions VALUES (?,?,?,?)', digest(raw), user.id, csrf, new Date(Date.now() + 3600000).toISOString());
    return { cookie: `platform_session=${raw}`, 'x-csrf-token': csrf };
  };
  const sessions = { admin: auth(demo.admin), teacher: auth(demo.teacher), second: auth(demo.second), student: auth(demo.studentUser) };
  async function request(path, { method = 'GET', data, user = 'teacher', headers = {}, raw } = {}) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin,
      ...(user ? sessions[user] : {}), ...headers }, ...(data === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(data) }) });
    const body = await response.json();
    return { status: response.status, body, headers: response.headers };
  }
  const publication = overrides => {
    const snapshot = JSON.parse(store.one('SELECT snapshot FROM publications WHERE id=?', 'pub_demo_001').snapshot);
    const p = { ...snapshot, publication_id: 'pub_test_002', lesson_id: demo.next.id,
      context_version_used: store.context(demo.teacher, demo.next.id).context_version, ...overrides };
    p.content_hash = publicationHash(p); return p;
  };
  async function delegate() {
    store.bindAccount(demo.admin, { teacher_id: demo.teacher.id, lessonfold_user_id: 'lf_verified_teacher', admin_verified: true });
    const launch = await request('/integrations/v1/lessonfold/launches', { method: 'POST', data: { lesson_id: demo.next.id } });
    assert.equal(launch.status, 201);
    const code = new URL(launch.body.launch_url).searchParams.get('launch');
    const grant = await request('/integrations/v1/lessonfold/launches/exchange', { user: null, method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}` }, data: { launch_code: code, lessonfold_user_id: 'lf_verified_teacher' } });
    assert.equal(grant.status, 200);
    return { code, headers: { authorization: `Bearer ${serviceKey}`, 'x-lessonfold-delegation': grant.body.delegation_token } };
  }
  return { store, server, demo, request, publication, delegate, sessions, base };
}
const contextPath = lesson => `/integrations/v1/lessons/${lesson.id}/teaching-context`;
const materialPath = (lesson, p) => `/integrations/v1/lessons/${lesson.id}/materials/${p.publication_id}`;
const expectError = (response, status, code) => { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.error.code, code); assert.ok(response.body.error.request_id); };

test('login uses HttpOnly sessions, rejects bad credentials, and preserves password whitespace', async t => {
  const f = await fixture(t);
  expectError(await f.request('/api/login', { user: null, method: 'POST', data: { username: 'teacher', password: 'wrong' } }), 401, 'INVALID_LOGIN');
  const signed = await f.request('/api/login', { user: null, method: 'POST', data: { username: 'teacher', password } });
  assert.equal(signed.status, 200); assert.match(signed.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(signed.body.user.password, undefined);
  f.store.addUser({ username: 'spaced', password: '  password-with-spaces  ', display_name: '测试' });
  assert.equal((await f.request('/api/login', { user: null, method: 'POST', data: { username: 'spaced', password: '  password-with-spaces  ' } })).status, 200);
});

test('anonymous reads and forged platform identity cannot authorize a user', async t => {
  const f = await fixture(t);
  expectError(await f.request('/api/dashboard', { user: null, headers: { 'oai-authenticated-user-id': f.demo.teacher.id } }), 401, 'LOGIN_REQUIRED');
});

test('mutations reject cross-origin requests and missing CSRF proof', async t => {
  const f = await fixture(t);
  const options = { user: 'admin', method: 'POST', data: { display_name: '测试', school_grade: 8 } };
  expectError(await f.request('/api/students', { ...options, headers: { origin: 'https://evil.example' } }), 403, 'CSRF_REJECTED');
  expectError(await f.request('/api/students', { ...options, headers: { 'x-csrf-token': '' } }), 403, 'CSRF_REJECTED');
});

test('same-name students stay separate and renaming preserves evidence IDs', async t => {
  const f = await fixture(t);
  const rename = s => f.store.updateStudent(f.demo.admin, s.id, { display_name: '同名测试学生', school_grade: 8, expected_revision: 1 });
  rename(f.demo.a); rename(f.demo.b);
  const ctx = f.store.context(f.demo.teacher, f.demo.next.id);
  assert.equal(new Set(ctx.students.map(s => s.student_id)).size, 2);
  assert.equal(ctx.students.find(s => s.student_id === f.demo.a.id).recent_confirmed_observations.length, 1);
  assert.equal(ctx.students.find(s => s.student_id === f.demo.b.id).recent_confirmed_observations.length, 0);
});

test('second teacher cannot enumerate, read, edit, confirm or launch the first teacher class', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/dashboard', { user: 'second' })).body.students, []);
  for (const path of [`/api/classes/${f.demo.cls.id}`, `/api/students/${f.demo.a.id}`, `/api/lessons/${f.demo.first.id}`, `/api/lessons/${f.demo.next.id}/teaching-context`]) {
    expectError(await f.request(path, { user: 'second' }), 404, 'NOT_FOUND');
  }
  expectError(await f.request('/integrations/v1/lessonfold/launches', { user: 'second', method: 'POST', data: { lesson_id: f.demo.next.id } }), 404, 'NOT_FOUND');
});

test('operators can schedule and record attendance but cannot read or confirm learning conclusions', async t => {
  const f = await fixture(t);
  const row = await f.request(`/api/lessons/${f.demo.first.id}`, { user: 'admin' });
  assert.deepEqual(row.body.observations, []);
  assert.ok(row.body.publications.every(p => p.assets.every(a => a.audience === 'student')));
  const draft = f.store.one("SELECT * FROM observations WHERE status='draft'");
  expectError(await f.request(`/api/observations/${draft.id}/confirm`, { user: 'admin', method: 'POST', data: { expected_revision: 1, teacher_confirmed: true } }), 403, 'FORBIDDEN');
  assert.equal((await f.request(`/api/lessons/${f.demo.first.id}/attendance`, { user: 'admin', method: 'PUT', data: { student_id: f.demo.a.id, status: 'present', expected_revision: 0 } })).status, 200);
});

test('student API strips teacher answers, peer observations, roster and nonrecipient publications', async t => {
  const f = await fixture(t);
  const privateP = f.publication({ lesson_id: f.demo.first.id, recipient_student_ids: [f.demo.b.id], publication_id: 'pub_only_b' });
  f.store.receivePublication(f.demo.teacher, f.demo.first.id, privateP.publication_id, privateP);
  const result = await f.request(`/api/lessons/${f.demo.first.id}`, { user: 'student' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.students, []); assert.deepEqual(result.body.observations, []);
  assert.equal(result.body.publications.length, 1);
  const json = JSON.stringify(result.body);
  assert.ok(!json.includes('答案：')); assert.ok(!json.includes(f.demo.b.id)); assert.ok(!json.includes('借书')); // personal response
  expectError(await f.request(`/api/lessons/${f.demo.next.id}/teaching-context`, { user: 'student' }), 403, 'FORBIDDEN');
});

test('draft confirmation changes next lesson context; drafts and current/future lessons are excluded', async t => {
  const f = await fixture(t);
  const before = f.store.context(f.demo.teacher, f.demo.next.id);
  const draft = f.store.one("SELECT * FROM observations WHERE status='draft'");
  expectError(await f.request(`/api/observations/${draft.id}/confirm`, { method: 'POST', data: { expected_revision: 1, teacher_confirmed: false } }), 422, 'REVIEW_REQUIRED');
  assert.equal((await f.request(`/api/observations/${draft.id}/confirm`, { method: 'POST', data: { expected_revision: 1, teacher_confirmed: true } })).status, 200);
  const after = f.store.context(f.demo.teacher, f.demo.next.id);
  assert.notEqual(after.context_version, before.context_version);
  assert.equal(after.students.find(s => s.student_id === f.demo.b.id).recent_confirmed_observations.length, 1);
  assert.equal(f.store.context(f.demo.teacher, f.demo.first.id).students[0].recent_confirmed_observations.length, 0);
  const current = f.store.createObservation(f.demo.teacher, f.demo.next.id, { student_id: f.demo.a.id, domain: 'grammar', knowledge_point: '时态', observed_response: '尚未测评', result: 'not_assessed' });
  f.store.confirmObservation(f.demo.teacher, current.id, { expected_revision: 1, teacher_confirmed: true });
  assert.equal(f.store.context(f.demo.teacher, f.demo.next.id).context_version, after.context_version);
});

test('confirmed evidence is immutable; concurrent draft edits are rejected without fake audit rows', async t => {
  const f = await fixture(t);
  const row = f.store.one("SELECT * FROM observations WHERE status='draft'");
  const data = { ...row, observed_response: '核对原文后修正的测试表现', expected_revision: row.revision };
  const edited = await f.request(`/api/observations/${row.id}`, { method: 'PATCH', data });
  assert.equal(edited.status, 200); assert.equal(edited.body.id, row.id); assert.equal(edited.body.revision, 2);
  expectError(await f.request(`/api/observations/${row.id}`, { method: 'PATCH', data }), 409, 'REVISION_CONFLICT');
  f.store.confirmObservation(f.demo.teacher, row.id, { expected_revision: 2, teacher_confirmed: true });
  expectError(await f.request(`/api/observations/${row.id}`, { method: 'PATCH', data: { ...data, expected_revision: 3 } }), 409, 'OBSERVATION_IMMUTABLE');
  assert.equal(f.store.one('SELECT count(*) n FROM observations').n, 2);
  assert.equal(f.store.one("SELECT count(*) n FROM audit_events WHERE action='observation.drafted'").n, 2);
});

test('not-assessed scores stay null and invalid dates, score ranges and membership overlap fail', async t => {
  const f = await fixture(t);
  const data = { student_id: f.demo.a.id, domain: 'reading', knowledge_point: '主旨', observed_response: '未测评', result: 'not_assessed', score: 0 };
  expectError(await f.request(`/api/lessons/${f.demo.first.id}/observations`, { method: 'POST', data }), 400, 'INVALID_SCORE');
  assert.throws(() => timestamp('2026-02-30T00:00:00Z', '时间'), /时间/);
  assert.throws(() => timestamp('2026-10-02T00:00:00+08:00', '时间'), /时间/);
  assert.throws(() => f.store.enroll(f.demo.admin, f.demo.cls.id, { student_id: f.demo.a.id, valid_from: new Date().toISOString() }), /重叠/);
});

test('follow-up completion updates context without fabricating mastery or completing the lesson', async t => {
  const f = await fixture(t);
  const before = f.store.context(f.demo.teacher, f.demo.next.id);
  const followup = f.store.one("SELECT * FROM follow_ups WHERE student_id=? AND status='open'", f.demo.a.id);
  assert.equal((await f.request(`/api/follow-ups/${followup.id}/complete`, { method: 'POST', data: { expected_revision: 1 } })).status, 200);
  const after = f.store.context(f.demo.teacher, f.demo.next.id);
  assert.notEqual(after.context_version, before.context_version);
  assert.equal(after.students.find(s => s.student_id === f.demo.a.id).follow_ups.length, 0);
  assert.equal(after.students.find(s => s.student_id === f.demo.a.id).recent_confirmed_observations[0].result, 'incorrect');
  assert.equal(after.lesson.status, 'scheduled');
});

test('context versions are deterministic, include progress and names, and exclude generation time', async t => {
  const f = await fixture(t);
  const before = f.store.context(f.demo.teacher, f.demo.next.id);
  assert.equal(f.store.context(f.demo.teacher, f.demo.next.id).context_version, before.context_version);
  f.store.updateLesson(f.demo.teacher, f.demo.next.id, { ...f.demo.next, expected_revision: 1, curriculum: { edition_id: 'demo', edition_name: '演示教材', book_id: 'book1', unit_id: 'unit2' } });
  assert.notEqual(f.store.context(f.demo.teacher, f.demo.next.id).context_version, before.context_version);
});

test('launch requires verified accounts; exchange is single-use and does not consume mismatched accounts', async t => {
  const f = await fixture(t);
  expectError(await f.request('/integrations/v1/lessonfold/launches', { method: 'POST', data: { lesson_id: f.demo.next.id } }), 422, 'ACCOUNT_NOT_BOUND');
  f.store.bindAccount(f.demo.admin, { teacher_id: f.demo.teacher.id, lessonfold_user_id: 'lf_verified_teacher', admin_verified: true });
  const launch = await f.request('/integrations/v1/lessonfold/launches', { method: 'POST', data: { lesson_id: f.demo.next.id } });
  const code = new URL(launch.body.launch_url).searchParams.get('launch');
  assert.ok(!launch.body.launch_url.includes(f.demo.a.id));
  const exchange = external => f.request('/integrations/v1/lessonfold/launches/exchange', { user: null, method: 'POST', headers: { authorization: `Bearer ${serviceKey}` }, data: { launch_code: code, lessonfold_user_id: external } });
  expectError(await exchange('someone_else'), 403, 'ACCOUNT_MISMATCH');
  assert.equal((await exchange('lf_verified_teacher')).status, 200);
  expectError(await exchange('lf_verified_teacher'), 409, 'LAUNCH_CONSUMED');
});

test('expired launch codes and delegations cannot read context', async t => {
  const f = await fixture(t); const grant = await f.delegate();
  f.store.run("UPDATE delegations SET expires_at='2000-01-01T00:00:00.000Z'");
  expectError(await f.request(contextPath(f.demo.next), { user: null, headers: grant.headers }), 401, 'INVALID_DELEGATION');
  f.store.run("UPDATE launches SET expires_at='2000-01-01T00:00:00.000Z'");
  expectError(await f.request('/integrations/v1/lessonfold/launches/exchange', { user: null, method: 'POST', headers: grant.headers, data: { launch_code: grant.code, lessonfold_user_id: 'lf_verified_teacher' } }), 401, 'LAUNCH_EXPIRED');
});

test('service key alone and a delegation for a different lesson cannot authorize integration', async t => {
  const f = await fixture(t); const grant = await f.delegate();
  expectError(await f.request(contextPath(f.demo.next), { user: null, headers: { authorization: `Bearer ${serviceKey}` } }), 401, 'INVALID_DELEGATION');
  expectError(await f.request(contextPath(f.demo.first), { user: null, headers: grant.headers }), 401, 'INVALID_DELEGATION');
  expectError(await f.request(contextPath(f.demo.next), { user: null, headers: { ...grant.headers, authorization: 'Bearer bad' } }), 401, 'INVALID_SERVICE');
});

test('revoking an account binding invalidates context and publication retries immediately', async t => {
  const f = await fixture(t); const grant = await f.delegate(); const p = f.publication();
  assert.equal((await f.request(materialPath(f.demo.next, p), { user: null, method: 'PUT', headers: grant.headers, data: p })).status, 201);
  await f.request('/api/account-bindings', { user: 'admin', method: 'PATCH', data: { teacher_id: f.demo.teacher.id } });
  expectError(await f.request(contextPath(f.demo.next), { user: null, headers: grant.headers }), 401, 'INVALID_DELEGATION');
  expectError(await f.request(materialPath(f.demo.next, p), { user: null, method: 'PUT', headers: grant.headers, data: p }), 401, 'INVALID_DELEGATION');
});

test('class handover removes prior teacher access and grants historical continuity to successor', async t => {
  const f = await fixture(t); const grant = await f.delegate();
  const result = await f.request(`/api/classes/${f.demo.cls.id}`, { user: 'admin', method: 'PATCH', data: { ...f.demo.cls, teacher_id: f.demo.second.id, expected_revision: 1 } });
  assert.equal(result.status, 200);
  expectError(await f.request(`/api/lessons/${f.demo.first.id}`), 404, 'NOT_FOUND');
  expectError(await f.request(contextPath(f.demo.next), { user: null, headers: grant.headers }), 401, 'INVALID_DELEGATION');
  assert.equal((await f.request(`/api/lessons/${f.demo.first.id}`, { user: 'second' })).status, 200);
  assert.equal(f.store.context(f.demo.second, f.demo.next.id).students.find(s => s.student_id === f.demo.a.id).recent_confirmed_observations.length, 1);
});

test('student withdrawal removes student materials and excludes learning records from next context', async t => {
  const f = await fixture(t); const before = f.store.context(f.demo.teacher, f.demo.next.id);
  const membership = f.store.one('SELECT * FROM memberships WHERE student_id=?', f.demo.a.id);
  f.store.endMembership(f.demo.admin, membership.id, { valid_until: new Date(Date.now() - 60000).toISOString() });
  expectError(await f.request(`/api/lessons/${f.demo.first.id}`, { user: 'student' }), 404, 'NOT_FOUND');
  assert.ok(!f.store.context(f.demo.teacher, f.demo.next.id).students.some(s => s.student_id === f.demo.a.id));
  assert.notEqual(f.store.context(f.demo.teacher, f.demo.next.id).context_version, before.context_version);
  assert.equal(f.store.one('SELECT count(*) n FROM publications').n, 1);
});

test('material retry returns original receipt after lost response and rejects changed immutable content', async t => {
  const f = await fixture(t); const grant = await f.delegate(); const p = f.publication();
  const send = data => f.request(materialPath(f.demo.next, p), { user: null, method: 'PUT', data, headers: grant.headers });
  const first = await send(p), retried = await send(p);
  assert.equal(first.status, 201); assert.equal(retried.status, 200); assert.deepEqual(first.body, retried.body);
  assert.equal(f.store.one('SELECT count(*) n FROM publications').n, 2);
  const changed = { ...p, title: '改变内容但复用 ID' }; changed.content_hash = publicationHash(changed);
  expectError(await send(changed), 409, 'PUBLICATION_CONFLICT');
  assert.equal(JSON.parse(f.store.one('SELECT snapshot FROM publications WHERE id=?', p.publication_id).snapshot).title, p.title);
});

test('publishing a new version retains prior snapshot and never completes lesson or records attendance', async t => {
  const f = await fixture(t); const first = f.publication();
  f.store.receivePublication(f.demo.teacher, f.demo.next.id, first.publication_id, first);
  const second = f.publication({ publication_id: 'pub_version_2', supersedes_publication_id: first.publication_id, content_revision: 2, title: '修订讲义' });
  f.store.receivePublication(f.demo.teacher, f.demo.next.id, second.publication_id, second);
  second.assets[0].body = '发布后的本地草稿修改';
  assert.notEqual(f.store.publicationsFor(f.demo.teacher, f.demo.next.id)[0].assets[0].body, second.assets[0].body);
  assert.equal(f.store.publicationsFor(f.demo.teacher, f.demo.next.id).length, 2);
  assert.equal(f.store.lessonFor(f.demo.teacher, f.demo.next.id).status, 'scheduled');
  assert.equal(f.store.one('SELECT count(*) n FROM attendance').n, 0);
});

test('publication rejects wrong scope, forged approval, invalid hash, brief modes and recipients', async t => {
  const f = await fixture(t); const grant = await f.delegate();
  const cases = [
    [{ tenant_id: 'another_org' }, 400, 'PUBLICATION_SCOPE_MISMATCH'],
    [{ approved_by: f.demo.second.id }, 400, 'PUBLICATION_SCOPE_MISMATCH'],
    [{ recipient_student_ids: ['student_unknown'] }, 403, 'INVALID_RECIPIENTS'],
    [{ provenance: { content_method: 'brief', teacher_reviewed: true } }, 422, 'REVIEW_REQUIRED'],
    [{ provenance: { content_method: 'teacher_authored', teacher_reviewed: false } }, 422, 'REVIEW_REQUIRED'],
    [{ assets: [{ asset_id: 'answers', audience: 'teacher', format: 'text/plain', body: '教师答案' }] }, 422, 'MATERIAL_REQUIRED']
  ];
  for (const [overrides, status, code] of cases) {
    const p = f.publication(overrides);
    expectError(await f.request(materialPath(f.demo.next, p), { user: null, method: 'PUT', data: p, headers: grant.headers }), status, code);
  }
  const p = f.publication(); p.content_hash = 'sha256:wrong';
  expectError(await f.request(materialPath(f.demo.next, p), { user: null, method: 'PUT', data: p, headers: grant.headers }), 400, 'HASH_MISMATCH');
});

test('oversized UTF-8 material, malformed JSON, duplicate keys and lone surrogates are rejected', async t => {
  const f = await fixture(t); const grant = await f.delegate(); const p = f.publication();
  p.assets[0].body = '中'.repeat(84000); p.content_hash = publicationHash(p);
  expectError(await f.request(materialPath(f.demo.next, p), { user: null, method: 'PUT', data: p, headers: grant.headers }), 413, 'PAYLOAD_TOO_LARGE');
  for (const raw of ['{', '{"display_name":"a","display_name":"b","school_grade":8}', '{"display_name":"\\ud800","school_grade":8}']) {
    expectError(await f.request('/api/students', { user: 'admin', method: 'POST', raw }), 400, 'INVALID_JSON');
  }
  assert.equal(f.store.one('SELECT count(*) n FROM publications').n, 1);
});

test('password changes invalidate all sessions; administrator reset cannot cross tenants', async t => {
  const f = await fixture(t);
  expectError(await f.request('/api/me/password', { method: 'POST', data: { current_password: 'wrong', new_password: 'new-test-password-123' } }), 403, 'INVALID_PASSWORD');
  assert.equal((await f.request('/api/me/password', { method: 'POST', data: { current_password: password, new_password: 'new-test-password-123' } })).status, 200);
  expectError(await f.request('/api/me'), 401, 'LOGIN_REQUIRED');
  const other = f.store.addUser({ username: 'other_org_teacher', password, display_name: '他机构老师', tenant_id: 'other_org' });
  expectError(await f.request(`/api/users/${other.id}/password`, { user: 'admin', method: 'POST', data: { new_password: 'new-test-password-123' } }), 404, 'NOT_FOUND');
});

test('disabling teacher invalidates login and delegation even if subsequently re-enabled', async t => {
  const f = await fixture(t); const grant = await f.delegate();
  assert.equal((await f.request(`/api/users/${f.demo.teacher.id}`, { user: 'admin', method: 'PATCH', data: { active: false } })).status, 200);
  expectError(await f.request('/api/me'), 401, 'LOGIN_REQUIRED');
  expectError(await f.request(contextPath(f.demo.next), { user: null, headers: grant.headers }), 401, 'INVALID_DELEGATION');
  await f.request(`/api/users/${f.demo.teacher.id}`, { user: 'admin', method: 'PATCH', data: { active: true } });
  expectError(await f.request(contextPath(f.demo.next), { user: null, headers: grant.headers }), 401, 'INVALID_DELEGATION');
});

test('persistent SQLite survives restart and demo seeding never replaces existing data', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'student-platform-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.sqlite'); const first = new Store(path); const demo = seedDemo(first, password);
  assert.throws(() => seedDemo(first, password), /empty database/); first.db.close();
  const reopened = new Store(path); t.after(() => reopened.db.close());
  assert.equal(reopened.one('SELECT display_name FROM students WHERE id=?', demo.a.id).display_name, '测试学生甲');
  assert.equal(reopened.one('SELECT count(*) n FROM publications').n, 1);
});

test('RFC 8785 sorts UTF-16 keys and serializes primitives; strict parser rejects ambiguity', () => {
  assert.equal(canonicalJSON({ b: 1, a: [true, null, -0, 1e30, 0.002] }), '{"a":[true,null,0,1e+30,0.002],"b":1}');
  const keys = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew', '1': 'One', '\ud83d\ude00': 'Emoji', '\u0080': 'Control', '\u00f6': 'Latin' };
  assert.deepEqual(Object.keys(JSON.parse(canonicalJSON(keys))).filter(k => k !== '1'), ['\r', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33']);
  assert.throws(() => canonicalJSON({ invalid: '\ud800' }), /Unicode/);
  assert.throws(() => canonicalJSON(Infinity), /Unsupported/);
  assert.throws(() => strictJSON('{"a":1,"\\u0061":2}'), /Duplicate/);
  assert.deepEqual(strictJSON('{"list":[{"a":1},{"a":2}],"a":3}'), { list: [{ a: 1 }, { a: 2 }], a: 3 });
});

test('only a teacher can explicitly confirm a complete curriculum', async t => {
  const f = await fixture(t);
  const curriculum = { edition_id: 'demo', edition_name: '测试教材', book_id: '1', unit_id: '2', confirmation_status: 'teacher_confirmed' };
  let row = f.store.updateLesson(f.demo.admin, f.demo.next.id, { ...f.demo.next, curriculum, expected_revision: 1 });
  assert.equal(row.curriculum.confirmation_status, 'pending_teacher_confirmation');
  row = f.store.updateLesson(f.demo.teacher, f.demo.next.id, { ...row, curriculum, expected_revision: 2 });
  assert.equal(row.curriculum.confirmation_status, 'teacher_confirmed');
  row = f.store.updateLesson(f.demo.teacher, f.demo.next.id, { ...row, curriculum: { ...curriculum, unit_id: null }, expected_revision: 3 });
  assert.equal(row.curriculum.confirmation_status, 'pending_teacher_confirmation');
});

test('login throttling, static security headers and health endpoint behave as documented', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) expectError(await f.request('/api/login', { user: null, method: 'POST', data: { username: 'teacher2', password: 'wrong' } }), 401, 'INVALID_LOGIN');
  expectError(await f.request('/api/login', { user: null, method: 'POST', data: { username: 'teacher2', password } }), 429, 'LOGIN_RATE_LIMIT');
  const html = await fetch(f.base + '/');
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await f.request('/health', { user: null })).body.status, 'ok');
});

test('permission revoked while a publication body is streaming is checked again before archiving', async t => {
  const f = await fixture(t); const grant = await f.delegate(); const p = f.publication();
  const wire = JSON.stringify(p);
  const received = once(f.server, 'request');
  let req;
  const response = new Promise((resolve, reject) => {
    req = httpRequest(f.base + materialPath(f.demo.next, p), { method: 'PUT', headers: { ...grant.headers, 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
  });
  req.write(wire.slice(0, 100)); await received;
  assert.equal((await f.request(`/api/users/${f.demo.teacher.id}`, { user: 'admin', method: 'PATCH', data: { active: false } })).status, 200);
  req.end(wire.slice(100));
  expectError(await response, 401, 'INVALID_DELEGATION');
  assert.equal(f.store.one('SELECT count(*) n FROM publications').n, 1);
});

test('long confirmed histories are bounded and explicitly marked as truncated', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 4; n++) {
    const start = new Date(Date.now() - (n + 1) * 3600000).toISOString();
    const lesson = f.store.createLesson(f.demo.admin, { class_id: f.demo.cls.id, title: '虚构历史课次', starts_at: start,
      ends_at: new Date(Date.parse(start) + 1800000).toISOString(), objectives: [] });
    for (let j = 0; j < (n === 0 ? 31 : 1); j++) {
      const draft = f.store.createObservation(f.demo.teacher, lesson.id, { student_id: f.demo.a.id, domain: 'reading',
        knowledge_point: `测试点${j}`, observed_response: '虚构表现', result: 'not_assessed', score: null });
      f.store.confirmObservation(f.demo.teacher, draft.id, { expected_revision: 1, teacher_confirmed: true });
    }
  }
  const student = f.store.context(f.demo.teacher, f.demo.next.id).students.find(s => s.student_id === f.demo.a.id);
  assert.equal(student.history_truncated, true); assert.equal(student.recent_confirmed_observations.length, 30);
  assert.ok(new Set(student.recent_confirmed_observations.map(o => o.source_lesson_id)).size <= 3);
});
