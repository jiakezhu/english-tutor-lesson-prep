import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { passwordHash, validPassword, digest, canonicalJSON, publicationHash } from './security.js';

export const now = () => new Date().toISOString();
export const id = prefix => `${prefix}_${randomUUID()}`;
export class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export function text(value, label, max = 200, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(400, 'INVALID_FIELD', `${label}格式错误或超出长度限制。`);
  return value.trim();
}
export function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== (value.length === 20 ? value.replace('Z', '.000Z') : value))
    fail(400, 'INVALID_TIME', `${label}必须为 ISO 8601 UTC 时间。`);
  return new Date(value).toISOString();
}
export function grade(value) {
  if (!Number.isInteger(value) || value < 1 || value > 12) fail(400, 'INVALID_GRADE', '年级须为 1–12。');
  return value;
}
export function curriculum(value, teacherConfirmation = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_CURRICULUM', '请提供教材信息。');
  const out = Object.fromEntries(['edition_id', 'edition_name', 'book_id', 'unit_id'].map(k => [k, text(value[k], k, 200, true)]));
  out.confirmation_status = teacherConfirmation && value.confirmation_status === 'teacher_confirmed' && Object.values(out).every(Boolean)
    ? 'teacher_confirmed' : 'pending_teacher_confirmation';
  return out;
}
export function objectives(value) {
  if (!Array.isArray(value) || value.length > 20) fail(400, 'INVALID_OBJECTIVES', '教学目标须为不超过 20 条的列表。');
  return value.map(v => text(v, '教学目标', 500));
}
export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) fail(403, 'FORBIDDEN', '当前账号无此操作权限。');
}
function revision(row, expected) {
  if (!Number.isInteger(expected) || row.revision !== expected) fail(409, 'REVISION_CONFLICT', '记录已更新，请刷新后重试。');
}

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    this.db.exec('PRAGMA busy_timeout = 5000');
  }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(user, action, object) {
    this.run('INSERT INTO audit_events VALUES (?,?,?,?,?,?)', id('audit'), user.tenant_id, user.id, action, object, now());
  }
  addUser({ username, password, display_name, role = 'teacher', tenant_id = 'org_local', student_id = null }) {
    username = text(username, '用户名', 80);
    if (!['admin', 'teacher', 'student'].includes(role)) fail(400, 'INVALID_ROLE', '账号角色错误。');
    if (!validPassword(password)) fail(400, 'WEAK_PASSWORD', '密码需 12–200 个字符。');
    if (this.one('SELECT id FROM users WHERE username=?', username)) fail(409, 'USERNAME_EXISTS', '用户名已存在。');
    if (role === 'student' && !this.one('SELECT id FROM students WHERE id=? AND tenant_id=?', student_id, tenant_id))
      fail(400, 'INVALID_STUDENT', '学生账号须关联本机构学生。');
    if (role !== 'student') student_id = null;
    const user = { id: id(role), username, display_name: text(display_name, '显示姓名'), role, tenant_id, student_id };
    this.run('INSERT INTO users(id,tenant_id,username,password,display_name,role,student_id) VALUES (?,?,?,?,?,?,?)',
      user.id, tenant_id, username, passwordHash(password), user.display_name, role, student_id);
    return user;
  }
  teacher(user, teacherId) {
    const t = this.one("SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1 AND role='teacher'", teacherId, user.tenant_id);
    if (!t) fail(400, 'INVALID_TEACHER', '授课老师不存在或已停用。');
    return t;
  }
  classFor(user, classId, manage = false) {
    const row = this.one('SELECT * FROM classes WHERE id=? AND tenant_id=?', classId, user.tenant_id);
    if (!row || (user.role === 'teacher' && row.teacher_id !== user.id) || user.role === 'student')
      fail(404, 'NOT_FOUND', '班级不存在或无权访问。');
    if (manage) requireRole(user, 'admin');
    return { ...row, curriculum: JSON.parse(row.curriculum) };
  }
  isMember(classId, studentId, at) {
    return !!this.one('SELECT id FROM memberships WHERE class_id=? AND student_id=? AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)',
      classId, studentId, at, at);
  }
  studentFor(user, studentId) {
    const row = this.one('SELECT * FROM students WHERE id=? AND tenant_id=?', studentId, user.tenant_id);
    const allowed = user.role === 'admin' || (user.role === 'teacher' && this.one(`SELECT m.id FROM memberships m
      JOIN classes c ON c.id=m.class_id WHERE m.student_id=? AND c.teacher_id=? AND c.tenant_id=?
      AND m.valid_from<=? AND (m.valid_until IS NULL OR m.valid_until>?)`, studentId, user.id, user.tenant_id, now(), now()));
    if (!row || !allowed) fail(404, 'NOT_FOUND', '学生不存在或无权访问。');
    return row;
  }
  lessonFor(user, lessonId, teaching = false) {
    const row = this.one(`SELECT l.*,c.name class_name,c.teacher_id current_teacher_id,c.school_grade
      FROM lessons l JOIN classes c ON c.id=l.class_id WHERE l.id=? AND l.tenant_id=?`, lessonId, user.tenant_id);
    const allowed = row && (user.role === 'admin' || (user.role === 'teacher' && row.current_teacher_id === user.id) ||
      (user.role === 'student' && this.isMember(row.class_id, user.student_id, row.starts_at) && this.isMember(row.class_id, user.student_id, now())));
    if (!allowed) fail(404, 'NOT_FOUND', '课次不存在或无权访问。');
    if (teaching) requireRole(user, 'teacher');
    return { ...row, objectives: JSON.parse(row.objectives), curriculum: JSON.parse(row.curriculum) };
  }
  roster(user, lesson) {
    return this.all(`SELECT DISTINCT s.* FROM students s JOIN memberships m ON m.student_id=s.id
      WHERE s.tenant_id=? AND m.class_id=? AND m.valid_from<=? AND (m.valid_until IS NULL OR m.valid_until>?)`,
      user.tenant_id, lesson.class_id, lesson.starts_at, lesson.starts_at).filter(s => this.isMember(lesson.class_id, s.id, now()));
  }
  studentProfile(user, studentId) {
    requireRole(user, 'teacher');
    const student = this.studentFor(user, studentId);
    const authorized = lessonId => {
      try { this.lessonFor(user, lessonId, true); return true; } catch { return false; }
    };
    return { ...student,
      observations: this.all('SELECT * FROM observations WHERE student_id=? AND tenant_id=? ORDER BY observed_at DESC,id', studentId, user.tenant_id)
        .filter(o => authorized(o.lesson_id)),
      follow_ups: this.all('SELECT * FROM follow_ups WHERE student_id=? AND tenant_id=? ORDER BY due_at,id', studentId, user.tenant_id)
        .filter(f => authorized(f.lesson_id)) };
  }
  createStudent(user, data) {
    requireRole(user, 'admin');
    const row = { id: id('student'), tenant_id: user.tenant_id, display_name: text(data.display_name, '姓名'), school_grade: grade(data.school_grade), revision: 1 };
    this.run('INSERT INTO students VALUES (?,?,?,?,?)', ...Object.values(row));
    this.audit(user, 'student.created', row.id);
    return row;
  }
  updateStudent(user, studentId, data) {
    requireRole(user, 'admin'); const old = this.studentFor(user, studentId); revision(old, data.expected_revision);
    this.run('UPDATE students SET display_name=?,school_grade=?,revision=revision+1 WHERE id=?', text(data.display_name, '姓名'), grade(data.school_grade), studentId);
    this.audit(user, 'student.updated', studentId); return this.studentFor(user, studentId);
  }
  createClass(user, data) {
    requireRole(user, 'admin'); this.teacher(user, data.teacher_id);
    const row = { id: id('class'), tenant_id: user.tenant_id, name: text(data.name, '班级'), teacher_id: data.teacher_id,
      school_grade: grade(data.school_grade), curriculum: curriculum(data.curriculum), revision: 1 };
    this.run('INSERT INTO classes VALUES (?,?,?,?,?,?,?)', row.id, row.tenant_id, row.name, row.teacher_id, row.school_grade, JSON.stringify(row.curriculum), 1);
    this.audit(user, 'class.created', row.id); return row;
  }
  updateClass(user, classId, data) {
    const row = this.classFor(user, classId, true); revision(row, data.expected_revision); this.teacher(user, data.teacher_id);
    this.run('UPDATE classes SET name=?,teacher_id=?,school_grade=?,curriculum=?,revision=revision+1 WHERE id=?',
      text(data.name, '班级'), data.teacher_id, grade(data.school_grade), JSON.stringify(curriculum(data.curriculum)), classId);
    if (row.teacher_id !== data.teacher_id) {
      for (const table of ['launches', 'delegations']) this.run(`DELETE FROM ${table} WHERE lesson_id IN (SELECT id FROM lessons WHERE class_id=?)`, classId);
    }
    this.audit(user, 'class.updated', classId); return this.classFor(user, classId);
  }
  enroll(user, classId, data) {
    this.classFor(user, classId, true); this.studentFor(user, data.student_id);
    const from = timestamp(data.valid_from, '在班开始时间'); const until = data.valid_until ? timestamp(data.valid_until, '在班结束时间') : null;
    if (until && until <= from) fail(400, 'INVALID_INTERVAL', '结束时间需晚于开始时间。');
    if (this.one(`SELECT id FROM memberships WHERE class_id=? AND student_id=?
      AND (valid_until IS NULL OR valid_until>?) AND (? IS NULL OR valid_from<?)`, classId, data.student_id, from, until, until))
      fail(409, 'MEMBERSHIP_OVERLAP', '在班时间与已有记录重叠。');
    const key = id('membership'); this.run('INSERT INTO memberships VALUES (?,?,?,?,?)', key, classId, data.student_id, from, until);
    this.audit(user, 'membership.created', key); return { id: key };
  }
  endMembership(user, membershipId, data) {
    requireRole(user, 'admin'); const row = this.one('SELECT * FROM memberships WHERE id=?', membershipId);
    if (!row) fail(404, 'NOT_FOUND', '在班记录不存在。'); this.classFor(user, row.class_id, true);
    if (row.valid_until) fail(409, 'MEMBERSHIP_ENDED', '在班记录已经结束。');
    const until = timestamp(data.valid_until, '退出时间'); if (until <= row.valid_from) fail(400, 'INVALID_INTERVAL', '退出时间需晚于加入时间。');
    this.run('UPDATE memberships SET valid_until=? WHERE id=?', until, membershipId); this.audit(user, 'membership.ended', membershipId);
    return { ...row, valid_until: until };
  }
  createLesson(user, data) {
    requireRole(user, 'admin'); const cls = this.classFor(user, data.class_id, true);
    const start = timestamp(data.starts_at, '开始时间'), end = timestamp(data.ends_at, '结束时间');
    if (end <= start) fail(400, 'INVALID_INTERVAL', '结束时间需晚于开始时间。');
    const key = id('lesson'); this.run('INSERT INTO lessons VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      key, user.tenant_id, cls.id, cls.teacher_id, text(data.title, '课次名称'), start, end, 'scheduled', JSON.stringify(objectives(data.objectives)), JSON.stringify(curriculum(data.curriculum || cls.curriculum)), 1);
    this.audit(user, 'lesson.created', key); return this.lessonFor(user, key);
  }
  updateLesson(user, lessonId, data) {
    const row = this.lessonFor(user, lessonId); requireRole(user, 'admin', 'teacher'); revision(row, data.expected_revision);
    const start = timestamp(data.starts_at, '开始时间'), end = timestamp(data.ends_at, '结束时间');
    if (end <= start || !['scheduled', 'completed', 'cancelled'].includes(data.status)) fail(400, 'INVALID_LESSON', '课次时间或状态无效。');
    // Schedule and completion are explicit operations, never material side effects.
    this.run('UPDATE lessons SET title=?,starts_at=?,ends_at=?,status=?,objectives=?,curriculum=?,revision=revision+1 WHERE id=?',
      text(data.title, '课次名称'), start, end, data.status, JSON.stringify(objectives(data.objectives)), JSON.stringify(curriculum(data.curriculum, user.role === 'teacher')), lessonId);
    this.audit(user, 'lesson.updated', lessonId); return this.lessonFor(user, lessonId);
  }
  createObservation(user, lessonId, data) {
    const lesson = this.lessonFor(user, lessonId, true); this.studentFor(user, data.student_id);
    if (!this.roster(user, lesson).some(s => s.id === data.student_id)) fail(400, 'INVALID_STUDENT', '学生不在本课次的授权名单中。');
    const fields = this.observationFields(data);
    const key = id('obs'); this.run(`INSERT INTO observations(id,tenant_id,lesson_id,student_id,author_id,domain,knowledge_point,
      observed_response,result,score,evidence_ref,next_action,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      key, user.tenant_id, lessonId, data.student_id, user.id, ...Object.values(fields), now());
    this.audit(user, 'observation.drafted', key); return this.one('SELECT * FROM observations WHERE id=?', key);
  }
  observationFields(data) {
    if (!['vocabulary','grammar','reading','listening','speaking','writing'].includes(data.domain) ||
      !['correct','incorrect','partially_correct','not_assessed'].includes(data.result)) fail(400, 'INVALID_OBSERVATION', '领域或结果错误。');
    if (data.score !== null && data.score !== undefined && (typeof data.score !== 'number' || !Number.isFinite(data.score) || data.score < 0 || data.score > 100))
      fail(400, 'INVALID_SCORE', '分数须为空或 0–100。');
    if (data.result === 'not_assessed' && data.score != null) fail(400, 'INVALID_SCORE', '未测评的内容不能填写分数。');
    return { domain: data.domain, knowledge_point: text(data.knowledge_point, '知识点', 500),
      observed_response: text(data.observed_response, '学习证据', 5000), result: data.result, score: data.score ?? null,
      evidence_ref: text(data.evidence_ref, '证据引用', 200, true), next_action: text(data.next_action, '下一步', 2000, true) || '' };
  }
  recordAttendance(user, lessonId, data) {
    const lesson = this.lessonFor(user, lessonId); requireRole(user, 'admin', 'teacher');
    if (!this.roster(user, lesson).some(s => s.id === data.student_id)) fail(403, 'INVALID_STUDENT', '学生不在授权名单中。');
    if (!['present','absent','leave','late'].includes(data.status)) fail(400, 'INVALID_ATTENDANCE', '出勤状态无效。');
    const old = this.one('SELECT * FROM attendance WHERE lesson_id=? AND student_id=?', lessonId, data.student_id);
    if (old) revision(old, data.expected_revision);
    else if (data.expected_revision !== 0) fail(409, 'REVISION_CONFLICT', '出勤记录已变化，请刷新。');
    this.run(`INSERT INTO attendance VALUES (?,?,?,?,?,1) ON CONFLICT(lesson_id,student_id)
      DO UPDATE SET status=excluded.status,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at,revision=attendance.revision+1`,
      lessonId, data.student_id, data.status, user.id, now());
    this.audit(user, 'attendance.recorded', lessonId);
    return this.one('SELECT * FROM attendance WHERE lesson_id=? AND student_id=?', lessonId, data.student_id);
  }
  confirmObservation(user, observationId, data) {
    const row = this.one('SELECT * FROM observations WHERE id=? AND tenant_id=?', observationId, user.tenant_id);
    if (!row) fail(404, 'NOT_FOUND', '记录不存在。'); this.lessonFor(user, row.lesson_id, true); this.studentFor(user, row.student_id);
    const lesson = this.lessonFor(user, row.lesson_id, true);
    if (!this.roster(user, lesson).some(s => s.id === row.student_id)) fail(403, 'STUDENT_ACCESS_REVOKED', '学生已不在授权名单中。');
    revision(row, data.expected_revision);
    if (row.status !== 'draft' || data.teacher_confirmed !== true) fail(422, 'REVIEW_REQUIRED', '请明确确认学习证据后再归档。');
    return this.transaction(() => {
      this.run("UPDATE observations SET status='teacher_confirmed',confirmed_by=?,confirmed_at=?,revision=revision+1 WHERE id=?", user.id, now(), observationId);
      if (row.next_action) this.run('INSERT INTO follow_ups(id,tenant_id,student_id,lesson_id,observation_id,type,description,due_at) VALUES (?,?,?,?,?,?,?,?)',
        id('followup'), user.tenant_id, row.student_id, row.lesson_id, observationId, 'retest', row.next_action, data.due_at ? timestamp(data.due_at, '复测日期') : null);
      this.audit(user, 'observation.confirmed', observationId); return this.one('SELECT * FROM observations WHERE id=?', observationId);
    });
  }
  updateObservation(user, observationId, data) {
    const row = this.one('SELECT * FROM observations WHERE id=? AND tenant_id=?', observationId, user.tenant_id);
    if (!row) fail(404, 'NOT_FOUND', '记录不存在。');
    const lesson = this.lessonFor(user, row.lesson_id, true); this.studentFor(user, row.student_id);
    if (!this.roster(user, lesson).some(s => s.id === row.student_id)) fail(403, 'STUDENT_ACCESS_REVOKED', '学生已不在本课次授权名单中。');
    revision(row, data.expected_revision);
    if (row.status !== 'draft') fail(409, 'OBSERVATION_IMMUTABLE', '已确认的学习证据不能直接改写，请新增更正记录。');
    return this.transaction(() => {
      const draft = this.observationFields(data);
      this.run(`UPDATE observations SET domain=?,knowledge_point=?,observed_response=?,result=?,score=?,evidence_ref=?,next_action=?,revision=revision+1 WHERE id=?`,
        draft.domain, draft.knowledge_point, draft.observed_response, draft.result, draft.score, draft.evidence_ref, draft.next_action, row.id);
      this.audit(user, 'observation.updated', row.id);
      return this.one('SELECT * FROM observations WHERE id=?', row.id);
    });
  }
  createFollowUp(user, lessonId, data) {
    const lesson = this.lessonFor(user, lessonId, true); this.studentFor(user, data.student_id);
    if (!this.roster(user, lesson).some(s => s.id === data.student_id)) fail(400, 'INVALID_STUDENT', '学生不在本课次名单中。');
    if (!['homework','retest','teacher_advice'].includes(data.type)) fail(400, 'INVALID_FOLLOW_UP', '跟进类型无效。');
    const key = id('followup'); this.run('INSERT INTO follow_ups(id,tenant_id,student_id,lesson_id,type,description,due_at) VALUES (?,?,?,?,?,?,?)',
      key, user.tenant_id, data.student_id, lessonId, data.type, text(data.description, '跟进内容', 2000), data.due_at ? timestamp(data.due_at, '计划日期') : null);
    this.audit(user, 'followup.created', key); return this.one('SELECT * FROM follow_ups WHERE id=?', key);
  }
  completeFollowUp(user, key, data) {
    const row = this.one('SELECT * FROM follow_ups WHERE id=? AND tenant_id=?', key, user.tenant_id);
    if (!row) fail(404, 'NOT_FOUND', '待办不存在。'); this.lessonFor(user, row.lesson_id, true); this.studentFor(user, row.student_id); revision(row, data.expected_revision);
    if (row.status !== 'open') fail(409, 'ALREADY_COMPLETED', '待办已完成。');
    this.run("UPDATE follow_ups SET status='completed',completed_at=?,revision=revision+1 WHERE id=?", now(), key);
    this.audit(user, 'followup.completed', key); return { id: key, status: 'completed' };
  }
  bindAccount(user, data) {
    requireRole(user, 'admin'); this.teacher(user, data.teacher_id);
    if (data.admin_verified !== true) fail(422, 'VERIFICATION_REQUIRED', '需先在双方核验账号控制权。');
    const external = text(data.lessonfold_user_id, 'Lessonfold 用户 ID', 200);
    if (this.one('SELECT teacher_id FROM account_bindings WHERE lessonfold_user_id=? AND teacher_id<>?', external, data.teacher_id))
      fail(409, 'ACCOUNT_ALREADY_BOUND', '此 Lessonfold 账号已绑定其他老师。');
    this.run(`INSERT INTO account_bindings VALUES (?,?,?,?,?,1) ON CONFLICT(tenant_id,teacher_id)
      DO UPDATE SET lessonfold_user_id=excluded.lessonfold_user_id,verified_by=excluded.verified_by,verified_at=excluded.verified_at,active=1`,
      user.tenant_id, data.teacher_id, external, user.id, now());
    for (const table of ['launches', 'delegations']) this.run(`DELETE FROM ${table} WHERE teacher_id=? AND tenant_id=?`, data.teacher_id, user.tenant_id);
    this.audit(user, 'account.verified', data.teacher_id); return { teacher_id: data.teacher_id, lessonfold_user_id: external };
  }
  context(user, lessonId) {
    const lesson = this.lessonFor(user, lessonId, true);
    const students = this.roster(user, lesson).map(s => {
      // Only prior lessons and confirmed observations are eligible. Include at most
      // three source lessons and 30 observations; return explicit truncation.
      const history = this.all(`SELECT o.* FROM observations o JOIN lessons l ON l.id=o.lesson_id JOIN classes c ON c.id=l.class_id
        WHERE o.student_id=? AND o.tenant_id=? AND o.status='teacher_confirmed' AND l.starts_at<?
        AND c.teacher_id=? ORDER BY l.starts_at DESC,o.observed_at DESC,o.id`, s.id, user.tenant_id, lesson.starts_at, user.id);
      const sourceLessons = [...new Set(history.map(o => o.lesson_id))].slice(0, 3);
      const selected = history.filter(o => sourceLessons.includes(o.lesson_id)).slice(0, 30);
      const observations = selected.map(o => ({ observation_id: o.id, source_lesson_id: o.lesson_id, observed_at: o.observed_at,
        domain: o.domain, knowledge_point: o.knowledge_point, observed_response: o.observed_response, result: o.result, score: o.score,
        evidence_ref: o.evidence_ref, status: o.status, confirmed_by: o.confirmed_by, confirmed_at: o.confirmed_at, next_action: o.next_action }));
      const followups = this.all(`SELECT f.* FROM follow_ups f JOIN lessons l ON l.id=f.lesson_id JOIN classes c ON c.id=l.class_id
        WHERE f.student_id=? AND f.tenant_id=? AND f.status='open' AND c.teacher_id=? AND l.starts_at<=?
        ORDER BY f.due_at,f.id`, s.id, user.tenant_id, user.id, lesson.starts_at);
      return { student_id: s.id, display_name: s.display_name, recent_confirmed_observations: observations,
        follow_ups: followups.map(f => ({ id: f.id, type: f.type, description: f.description, due_at: f.due_at })),
        history_truncated: selected.length < history.length };
    });
    const payload = { schema_version: 'teaching-context.v1', tenant_id: user.tenant_id, teacher_id: user.id, lesson_id: lessonId,
      lesson: { class_id: lesson.class_id, starts_at: lesson.starts_at, status: lesson.status,
        school_stage: lesson.school_grade <= 6 ? 'primary' : lesson.school_grade <= 9 ? 'junior_secondary' : 'senior_secondary',
        school_grade: lesson.school_grade, curriculum: lesson.curriculum, planned_objectives: lesson.objectives }, students };
    return { ...payload, context_version: `ctx_${digest(canonicalJSON(payload))}`, generated_at: now() };
  }
  publicationsFor(user, lessonId) {
    const lesson = this.lessonFor(user, lessonId);
    return this.all('SELECT * FROM publications WHERE tenant_id=? AND lesson_id=? ORDER BY accepted_at DESC', user.tenant_id, lessonId)
      .map(row => JSON.parse(row.snapshot))
      .filter(p => user.role !== 'student' || p.recipient_student_ids.includes(user.student_id))
      .map(p => {
        if (user.role === 'teacher') return p;
        // Do not return the full object then hide answers in the browser.
        return { publication_id: p.publication_id, title: p.title, content_revision: p.content_revision, approved_at: p.approved_at,
          assets: p.assets.filter(a => a.audience === 'student') };
      });
  }
  receivePublication(user, lessonId, publicationId, p) {
    const lesson = this.lessonFor(user, lessonId, true);
    if (!p || p.schema_version !== 'lesson-publication.v1' || p.publication_id !== publicationId || p.lesson_id !== lessonId ||
      p.tenant_id !== user.tenant_id || p.class_id !== lesson.class_id || p.approved_by !== user.id)
      fail(400, 'PUBLICATION_SCOPE_MISMATCH', '发布对象、机构、课次或审核者不一致。');
    if (Buffer.byteLength(JSON.stringify(p)) > 250000) fail(413, 'PAYLOAD_TOO_LARGE', '请求超过 250,000 字节，请拆分材料。');
    const keys = ['schema_version','publication_id','tenant_id','lesson_id','class_id','recipient_student_ids','preparation_id','content_revision','context_version_used','title','approved_by','approved_at','content_hash','supersedes_publication_id','assets','provenance'];
    if (Object.keys(p).some(k => !keys.includes(k)) || keys.some(k => !(k in p))) fail(400, 'INVALID_PUBLICATION', '发布字段缺失或包含未知字段。');
    text(publicationId, '发布 ID', 200); text(p.preparation_id, '备课 ID', 200); text(p.context_version_used, '学情版本', 200);
    text(p.title, '讲义标题', 200); timestamp(p.approved_at, '审核时间');
    if (p.supersedes_publication_id !== null) text(p.supersedes_publication_id, '上一发布 ID', 200);
    if (!Number.isSafeInteger(p.content_revision) || p.content_revision < 1) fail(400, 'INVALID_REVISION', '发布版本无效。');
    if (!p.provenance || p.provenance.teacher_reviewed !== true ||
      !['rule_based','model_generated','teacher_authored','mixed'].includes(p.provenance.content_method)) fail(422, 'REVIEW_REQUIRED', '讲义必须已由老师审核，简报和来源不能作为讲义。');
    if (!Array.isArray(p.recipient_student_ids) || !p.recipient_student_ids.length || p.recipient_student_ids.length > 200 ||
      new Set(p.recipient_student_ids).size !== p.recipient_student_ids.length) fail(400, 'INVALID_RECIPIENTS', '接收名单无效。');
    const roster = new Set(this.roster(user, lesson).map(s => s.id));
    if (!p.recipient_student_ids.every(s => roster.has(s))) fail(403, 'INVALID_RECIPIENTS', '名单包含未经授权的学生。');
    if (!Array.isArray(p.assets) || !p.assets.length || p.assets.length > 10 || !p.assets.some(a => a?.audience === 'student'))
      fail(422, 'MATERIAL_REQUIRED', '至少需要一份学生版讲义。');
    const assetIds = new Set();
    for (const a of p.assets) {
      if (!a || typeof a !== 'object' || Object.keys(a).some(k => !['asset_id','audience','format','body'].includes(k))) fail(400, 'INVALID_ASSET', '材料字段无效。');
      text(a.asset_id, '材料 ID', 200);
      if (assetIds.has(a.asset_id) || !['student','teacher'].includes(a.audience) || a.format !== 'text/plain') fail(400, 'INVALID_ASSET', '材料 ID、受众或格式错误。');
      text(a.body, '讲义正文', 250000); assetIds.add(a.asset_id);
    }
    if (Object.keys(p.provenance).some(k => !['content_method','teacher_reviewed'].includes(k))) fail(400, 'INVALID_PROVENANCE', '内容来源字段无效。');
    let hash; try { hash = publicationHash(p); } catch { fail(400, 'INVALID_CANONICAL_JSON', '发布正文须为有效 Unicode 和有限数字。'); }
    if (p.content_hash !== hash) fail(400, 'HASH_MISMATCH', '讲义摘要校验失败。');
    return this.transaction(() => {
      const existing = this.one('SELECT * FROM publications WHERE tenant_id=? AND id=?', user.tenant_id, publicationId);
      if (existing) {
        if (existing.content_hash !== hash) fail(409, 'PUBLICATION_CONFLICT', '同一发布 ID 的内容不可更改，请创建新版本。');
        return { status: 200, receipt: this.receipt(existing) };
      }
      if (p.supersedes_publication_id !== null) {
        const previous = this.one('SELECT * FROM publications WHERE tenant_id=? AND id=? AND lesson_id=?', user.tenant_id, p.supersedes_publication_id, lessonId);
        if (!previous || canonicalJSON(JSON.parse(previous.snapshot).recipient_student_ids) !== canonicalJSON(p.recipient_student_ids))
          fail(400, 'INVALID_SUPERSEDES', '前一版本须属于同课次及同接收名单。');
      }
      const row = { tenant_id: user.tenant_id, id: publicationId, lesson_id: lessonId, snapshot: canonicalJSON(p), content_hash: hash,
        receipt_id: id('receipt'), accepted_at: now() };
      this.run('INSERT INTO publications VALUES (?,?,?,?,?,?,?)', ...Object.values(row));
      this.audit(user, 'material.accepted', publicationId); return { status: 201, receipt: this.receipt(row) };
    });
  }
  receipt(row) { return { publication_id: row.id, status: 'accepted', receipt_id: row.receipt_id, accepted_at: row.accepted_at, content_hash: row.content_hash }; }
}
