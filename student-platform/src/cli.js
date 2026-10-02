import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Store, now } from './store.js';
import { token, publicationHash } from './security.js';

export function seedDemo(store, password = token()) {
  if (store.one('SELECT id FROM users LIMIT 1')) throw new Error('Demo requires an empty database; existing data will not be changed.');
  const admin = store.addUser({ username: 'admin', password, display_name: '演示管理员' });
  // Provisioning is performed by the CLI, never a public setup endpoint.
  store.run("UPDATE users SET role='admin' WHERE id=?", admin.id); admin.role = 'admin';
  const teacher = store.addUser({ username: 'teacher', password, display_name: '林老师 · 演示' });
  const second = store.addUser({ username: 'teacher2', password, display_name: '周老师 · 演示' });
  const a = store.createStudent(admin, { display_name: '测试学生甲', school_grade: 8 });
  const b = store.createStudent(admin, { display_name: '测试学生乙', school_grade: 8 });
  const curriculum = { edition_id: null, edition_name: null, book_id: null, unit_id: null };
  const cls = store.createClass(admin, { name: '初二 A 班 · 演示', teacher_id: teacher.id, school_grade: 8, curriculum });
  const start = new Date(Date.now() - 86400000).toISOString();
  for (const student of [a, b]) store.enroll(admin, cls.id, { student_id: student.id, valid_from: new Date(Date.now() - 7 * 86400000).toISOString() });
  const first = store.createLesson(admin, { class_id: cls.id, title: '第 1 次课 · 词义与表达', starts_at: start,
    ends_at: new Date(Date.parse(start) + 3600000).toISOString(), objectives: ['辨析 borrow / lend', '用连接词组织段落'] });
  const secondStart = new Date(Date.now() + 2 * 86400000).toISOString();
  const next = store.createLesson(admin, { class_id: cls.id, title: '第 2 次课 · 复测与衔接', starts_at: secondStart,
    ends_at: new Date(Date.parse(secondStart) + 3600000).toISOString(), objectives: ['复测借还情境词义', '练习段落衔接'] });
  const observation = store.createObservation(teacher, first.id, { student_id: a.id, domain: 'vocabulary',
    knowledge_point: 'borrow / lend 词义与搭配辨析', observed_response: '在“向朋友借书”的句子中，将 borrow 写为 lend。', result: 'incorrect', score: null,
    next_action: '用两道双向借还情境题复测 borrow / lend。' });
  store.confirmObservation(teacher, observation.id, { expected_revision: 1, teacher_confirmed: true, due_at: secondStart });
  store.createObservation(teacher, first.id, { student_id: b.id, domain: 'writing', knowledge_point: '段落衔接',
    observed_response: '两句话并列，未使用连接表达。该记录仍需老师核对原文。', result: 'partially_correct', score: null, next_action: '补充连接词练习。' });
  store.createFollowUp(teacher, first.id, { student_id: b.id, type: 'homework', description: '写一个 80 词段落，使用两种连接表达。', due_at: secondStart });
  const studentUser = store.addUser({ username: 'student', password, display_name: a.display_name, role: 'student', student_id: a.id });
  const publication = { schema_version: 'lesson-publication.v1', publication_id: 'pub_demo_001', tenant_id: teacher.tenant_id,
    lesson_id: first.id, class_id: cls.id, recipient_student_ids: [a.id, b.id], preparation_id: 'prep_demo_001', content_revision: 1,
    context_version_used: store.context(teacher, first.id).context_version, title: '借还情境练习 · 虚构演示讲义',
    approved_by: teacher.id, approved_at: now(), supersedes_publication_id: null,
    assets: [{ asset_id: 'asset_demo_student', audience: 'student', format: 'text/plain', body: '演示材料\n\n用 borrow 或 lend 填空：\n1. May I ___ your book?\n2. Could you ___ me a pencil?\n\n请说明两个动词的使用方向。' },
      { asset_id: 'asset_demo_teacher', audience: 'teacher', format: 'text/plain', body: '虚构演示教师版\n答案：1. borrow；2. lend。\n先用箭头表示物品流向，再请学生解释。' }],
    provenance: { content_method: 'teacher_authored', teacher_reviewed: true } };
  publication.content_hash = publicationHash(publication); store.receivePublication(teacher, first.id, publication.publication_id, publication);
  return { password, admin, teacher, second, studentUser, a, b, cls, first, next };
}

async function main() {
  const store = new Store(process.env.PLATFORM_DB || 'data/platform.sqlite');
  try {
    if (process.argv[2] === 'demo') {
      const demo = seedDemo(store);
      console.log('Created fictional demo data. Users: admin / teacher / teacher2 / student');
      console.log(`One-time generated demo password (all four users): ${demo.password}`);
      console.log('teacher2 intentionally has no class access. No Lessonfold account is pre-bound.');
    } else if (process.argv[2] === 'setup') {
      if (store.one('SELECT id FROM users LIMIT 1')) throw new Error('Setup requires an empty database.');
      const input = createInterface({ input: process.stdin, output: process.stdout });
      const username = await input.question('Admin username: ');
      // Generate a secret rather than echo a password typed into a terminal.
      const password = token(); input.close();
      store.addUser({ username, password, display_name: '管理员', role: 'admin' });
      console.log(`Admin created. Store this generated password securely: ${password}`);
    } else throw new Error('Usage: node src/cli.js setup|demo');
  } finally { store.db.close(); }
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
