const app = document.querySelector('#app');
const modal = document.querySelector('#dialog');
const state = { user: null, csrf: '', data: null, page: 'dashboard', detail: null, tab: 'overview', filter: '' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { admin: '运营管理员', teacher: '授课老师', student: '学生', scheduled: '待上课', completed: '已完成', cancelled: '已取消',
  vocabulary: '词汇', grammar: '语法', reading: '阅读', listening: '听力', speaking: '口语', writing: '写作', correct: '正确',
  incorrect: '错误', partially_correct: '部分正确', not_assessed: '未测评', homework: '作业', retest: '复测', teacher_advice: '教师建议',
  present: '出勤', absent: '缺勤', leave: '请假', late: '迟到' };
const date = (value, options = {}) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'short', day: 'numeric', ...options }).format(new Date(value)) : '未安排';
const time = value => date(value, { hour: '2-digit', minute: '2-digit', hour12: false });
const gradeName = n => n <= 6 ? `小学 ${n} 年级` : n <= 9 ? `初中 ${n - 6} 年级` : `高中 ${n - 9} 年级`;
const isAdmin = () => state.user.role === 'admin';
const isTeacher = () => state.user.role === 'teacher';
const brand = '<div class="brand"><span class="brand-mark" aria-hidden="true">L</span><div><strong>Language House</strong><span>学生与教学</span></div></div>';
const button = (action, text, id = '', cls = '', extra = '') => `<button type="button" class="${cls}" data-action="${action}" data-id="${escape(id)}" ${extra}>${text}</button>`;
const badge = (text, cls = '') => `<span class="pill ${cls}">${escape(text)}</span>`;
const empty = (title, text = '') => `<div class="empty"><strong>${escape(title)}</strong>${escape(text)}</div>`;
const card = (title, body, action = '') => `<section class="card"><div class="card-head"><h2>${escape(title)}</h2>${action}</div>${body}</section>`;
const field = (name, label, value = '', type = 'text', required = true, extra = '') => `<div class="field"><label for="field-${name}">${escape(label)}</label><input id="field-${name}" name="${name}" type="${type}" value="${escape(value)}" ${required ? 'required' : ''} ${extra}></div>`;
const area = (name, label, value = '', required = false) => `<div class="field"><label for="field-${name}">${escape(label)}</label><textarea id="field-${name}" name="${name}" rows="4" maxlength="5000" ${required ? 'required' : ''}>${escape(value)}</textarea></div>`;
const select = (name, label, options, value = '') => `<div class="field"><label for="field-${name}">${escape(label)}</label><select id="field-${name}" name="${name}" required>${options.map(([id, text]) => `<option value="${escape(id)}" ${id === value ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select></div>`;
const check = (name, text) => `<label class="check"><input name="${name}" type="checkbox" required>${escape(text)}</label>`;
const choices = names => names.map(n => [n, labels[n]]);
const curriculumFields = c => `<div class="two-fields">${field('edition_id', '教材版本 ID', c?.edition_id, 'text', false)}${field('edition_name', '教材版本名称', c?.edition_name, 'text', false)}${field('book_id', '册次', c?.book_id, 'text', false)}${field('unit_id', '当前单元', c?.unit_id, 'text', false)}</div>`;
const curriculumData = data => ({ ...Object.fromEntries(['edition_id', 'edition_name', 'book_id', 'unit_id'].map(k => [k, data[k] || null])), confirmation_status: data.curriculum_confirmed ? 'teacher_confirmed' : 'pending_teacher_confirmation' });
const curriculumText = c => c?.confirmation_status === 'teacher_confirmed' ? `${c.edition_name} · ${c.book_id} · ${c.unit_id}` : '教材待老师确认';
// datetime-local values always represent Beijing time, including on a browser in another timezone.
const localDate = value => value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16) : '';
const utcDate = value => value ? new Date(`${value}:00+08:00`).toISOString() : null;
function toast(message) {
  const node = document.querySelector('#toast'); node.textContent = message; node.style.display = 'block';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.style.display = 'none'; }, 4500);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': state.csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/login')) { state.user = null; modal.close(); login(); }
    throw new Error(result.error?.message || '操作失败，请稍后重试。');
  }
  return result;
}
function login() {
  app.innerHTML = `<main class="login"><section class="login-brand">${brand}<div><h1>让每一次课，<br>接住上一次的成长。</h1><p>学生、课次、教学材料与真实学习记录，在这里连成一条清晰的线。</p></div><small>LANGUAGE HOUSE · TEACHING WITH CONTINUITY</small></section>
    <section class="login-form"><form id="login-form"><span class="eyebrow">教学工作台</span><h2>欢迎回来</h2><p class="intro">使用管理员为你开通的账号登录</p>${field('username', '用户名', '', 'text', true, 'autocomplete="username" maxlength="80"')}${field('password', '密码', '', 'password', true, 'autocomplete="current-password" maxlength="200"')}<p class="error" role="alert"></p><button class="primary">登录工作台</button><p class="footer-note">真实记录 · 老师确认 · 连续教学</p></form></section></main>`;
  document.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; const submit = form.querySelector('button'); submit.disabled = true;
    try { const result = await api('/api/login', 'POST', Object.fromEntries(new FormData(form))); state.user = result.user; state.csrf = result.csrf; state.tab = 'overview'; history.replaceState(null, '', '#dashboard'); await refresh(); }
    catch (error) { form.querySelector('.error').textContent = error.message; }
    finally { submit.disabled = false; }
  });
}
async function dialog(title, html, onSubmit) {
  modal.innerHTML = `<form><h2>${escape(title)}</h2>${html}<p class="error" role="alert"></p><div class="form-actions">${button('close-dialog', '取消')}<button class="primary" type="submit">保存</button></div></form>`;
  if (!modal.open) modal.showModal();
  modal.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(form))); modal.close(); await refresh(); toast('已保存'); }
    catch (error) { form.querySelector('.error').textContent = error.message; }
    finally { submit.disabled = false; }
  });
}
function shell(content) {
  const menu = state.user.role === 'student' ? [['dashboard', '⌂', '我的课堂'], ['lessons', '◷', '课次与材料']] :
    [['dashboard', '⌂', '教学概览'], ['students', '♧', '学生档案'], ['classes', '▦', '班级管理'], ['lessons', '◷', '课次安排'], ...(isTeacher() ? [['followups', '✓', '作业与复测']] : []), ...(isAdmin() ? [['settings', '⚙', '账号与连接']] : [])];
  app.innerHTML = `<div class="layout"><aside class="sidebar">${brand}<div class="nav-label">工作空间</div><nav class="nav" aria-label="主导航">${menu.map(([id, icon, title]) => button('navigate', `<span class="icon">${icon}</span>${title}`, id, state.page === id || (id === 'lessons' && state.page === 'lesson') ? 'active' : '')).join('')}</nav><div class="sidebar-foot">每次教学，留下依据。<br>每份记录，连接下一次课。</div></aside><main class="main"><header class="topbar"><span class="workspace">咸祥 Language House / 教学工作台</span><div class="account"><span class="avatar">${escape(state.user.display_name.slice(0, 1))}</span><span>${escape(state.user.display_name)}<small>${labels[state.user.role]}</small></span>${button('password-form', '修改密码', '', 'quiet')}${button('logout', '退出', '', 'quiet')}</div></header><div class="content">${content}</div></main></div>`;
}
function heading(title, subtitle, action = '') { return `<div class="page-head"><div><span class="eyebrow">LANGUAGE HOUSE</span><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div>${action}</div>`; }
function lessonCards(lessons) {
  return lessons.length ? lessons.map(l => `<article class="lesson-card"><div class="date-block"><small>${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'short' }).format(new Date(l.starts_at))}</small><strong>${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', day: 'numeric' }).format(new Date(l.starts_at))}</strong></div><div class="lesson-text"><h3>${escape(l.title)}</h3><p>${escape(l.class_name)} · ${time(l.starts_at)}（北京时间）</p><div class="row">${badge(labels[l.status], l.status === 'scheduled' ? 'gold' : 'gray')}${badge(l.material_count ? `${l.material_count} 份讲义已归档` : '待接收讲义', l.material_count ? '' : 'gray')}${l.pending_observation_count ? badge(`${l.pending_observation_count} 条记录待确认`, 'gold') : ''}</div></div>${button('navigate', '打开课次 →', `lesson/${l.id}`, 'ghost')}</article>`).join('') : empty('暂无课次', isAdmin() ? '先建立班级，再安排一次课。' : '分配课次后会显示在这里。');
}
function dashboard() {
  const { lessons, students, classes, follow_ups } = state.data;
  const next = lessons.filter(l => l.status === 'scheduled' && l.ends_at > new Date().toISOString()).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 4);
  const metrics = state.user.role === 'student' ? [['可查看课次', lessons.length], ['已归档讲义', lessons.reduce((n, l) => n + l.material_count, 0)]] :
    [['学生', students.length], ['班级', classes.length], ['待上课', lessons.filter(l => l.status === 'scheduled').length], [isTeacher() ? '待跟进' : '待确认记录', isTeacher() ? follow_ups.length : lessons.reduce((n, l) => n + l.pending_observation_count, 0)]];
  return heading('把成长，落在每一次课堂里', '从课次出发，连接备课、交付与课后学习证据。') + `<section class="hero"><div><span class="eyebrow">TODAY’S TEACHING</span><h2>${next.length ? '下一次课，从真实学情开始。' : '准备好迎接下一次课堂。'}</h2><p>已确认的学习记录会进入下一次备课；未确认的建议保留为草稿。</p></div><div class="hero-art" aria-hidden="true">Aa</div></section><div class="metrics">${metrics.map(([label, n]) => `<div class="metric"><span>${label}</span><strong>${n}</strong><small>当前账号授权范围</small></div>`).join('')}</div><div class="grid"><div>${card('即将到来的课次', lessonCards(next), button('navigate', '查看全部 →', 'lessons', 'ghost'))}${card('最近的课堂', lessonCards(lessons.filter(l => l.starts_at < new Date().toISOString()).slice(0, 2)))}</div><div>${card('教学待办', follow_ups.length ? follow_ups.slice(0, 6).map(f => `<div class="task"><span class="task-dot"></span><div><h3>${escape(f.description)}</h3><p>${escape(f.student_name)} · ${labels[f.type]} · ${date(f.due_at)}</p></div></div>`).join('') : empty('暂时没有待办', '新的作业与复测安排会显示在这里。'))}<div class="note">材料归档、出勤和课次完成分别记录。归档讲义不会扣除课时或发送家长消息。</div></div></div>`;
}
function studentsPage() {
  return heading('学生档案', '用稳定的学生 ID 连接记录；同名学生也各有自己的成长轨迹。', isAdmin() ? button('student-form', '+ 新建学生', '', 'primary') : '') +
    `<div class="section-label"><h2>${state.data.students.length} 位学生</h2><input class="search" id="student-search" aria-label="搜索学生" placeholder="搜索姓名或学生 ID" value="${escape(state.filter)}"></div><div class="card table-wrap"><table><thead><tr><th>学生</th><th>学校年级</th><th>学生 ID</th><th>操作</th></tr></thead><tbody>${state.data.students.filter(s => `${s.display_name} ${s.id}`.toLowerCase().includes(state.filter.toLowerCase())).map(s => `<tr><td><div class="student-name"><span class="avatar">${escape(s.display_name.slice(0, 1))}</span><strong>${escape(s.display_name)}</strong></div></td><td>${gradeName(s.school_grade)}</td><td><small>${escape(s.id)}</small></td><td>${isAdmin() ? button('student-form', '编辑', s.id, 'ghost') : button('navigate', '学习记录 →', `student/${s.id}`, 'ghost')}</td></tr>`).join('')}</tbody></table>${!state.data.students.length ? empty('还没有学生', '由管理员创建学生，再加入班级。') : ''}</div>`;
}
function classesPage() {
  return heading('班级管理', '教材进度、授课老师与有效在班关系，在这里统一维护。', isAdmin() ? button('class-form', '+ 新建班级', '', 'primary') : '') +
    `<div class="settings-grid">${state.data.classes.map(c => card(c.name, `<div class="card-body"><p>${escape(c.teacher_name)} · ${gradeName(c.school_grade)}</p><p class="muted">${escape(curriculumText(c.curriculum))}</p>${button('navigate', '成员与班级信息 →', `class/${c.id}`, 'ghost')}</div>`)).join('')}</div>${!state.data.classes.length ? empty('还没有班级', '一对一课程也可以建立单人班级。') : ''}`;
}
function lessonsPage() {
  return heading('课次安排', '改排时间保留课次 ID，让历史材料和学习记录持续关联。', isAdmin() ? button('lesson-form', '+ 安排课次', '', 'primary', state.data.classes.length ? '' : 'disabled') : '') + `<div class="card">${lessonCards(state.data.lessons)}</div>`;
}
function followupsPage() {
  return heading('作业与复测', '完成跟进后，下一次备课不再把它列为未完成事项。') + card('待跟进事项', state.data.follow_ups.length ? state.data.follow_ups.map(f => `<div class="task"><span class="task-dot"></span><div class="grow"><h3>${escape(f.description)}</h3><p>${escape(f.student_name)} · ${labels[f.type]} · ${date(f.due_at)}</p></div>${button('complete-followup', '标记完成', f.id, 'ghost')}</div>`).join('') : empty('全部跟进已处理', '可在课次中添加作业、复测与教师建议。'));
}
function observationCard(o, showName = true) {
  const student = state.detail.students?.find(s => s.id === o.student_id) || state.data.students.find(s => s.id === o.student_id);
  return `<article class="observation"><div class="spread"><div class="row">${showName ? `<strong>${escape(student?.display_name || o.student_id)}</strong>` : ''}${badge(labels[o.domain], 'gray')}${badge(o.status === 'teacher_confirmed' ? '老师已确认' : '待老师确认', o.status === 'teacher_confirmed' ? '' : 'gold')}</div><small>${time(o.observed_at)}</small></div><h3>${escape(o.knowledge_point)}</h3><p>${escape(o.observed_response)}</p><p class="muted">结果：${labels[o.result]}${o.score !== null ? ` · 分数 ${o.score}` : ' · 未评分'}</p>${o.next_action ? `<p>下一步：${escape(o.next_action)}</p>` : ''}${o.status === 'draft' ? `<div class="row">${button('observation-form', '编辑草稿', o.id, 'ghost')}${button('confirm-observation', '核对并确认', o.id, 'primary')}</div>` : `<small>确认时间：${time(o.confirmed_at)} · 记录版本 ${o.revision}</small>`}</article>`;
}
function materialCards(publications) {
  return publications.length ? publications.map(p => `<article class="observation"><div class="material-header"><div><h3>${escape(p.title)}</h3><small>备课版本 ${p.content_revision} · ${time(p.approved_at)}</small></div>${badge('已接收归档')}</div>${p.assets.map(a => `<h4>${a.audience === 'teacher' ? '教师版 · 答案与提示' : '学生版'}</h4><pre>${escape(a.body)}</pre>`).join('')}${isTeacher() ? `<small>发布 ID：${escape(p.publication_id)}</small>` : ''}</article>`).join('') : empty('本课次还没有归档材料', '老师在 Lessonfold 审核发布后，材料会显示在这里。');
}
function lessonPage() {
  const l = state.detail;
  const tabs = [['overview', '课次信息'], ['materials', '教学材料'], ...(state.user.role !== 'student' ? [['attendance', '出勤']] : []), ...(isTeacher() ? [['observations', '课后记录'], ['context', '备课学情']] : [])];
  let body;
  if (state.tab === 'materials') body = materialCards(l.publications);
  else if (state.tab === 'observations') body = `<div class="section-label"><h2>学习证据与老师确认</h2><div class="row">${button('followup-form', '+ 作业 / 复测')}${button('observation-form', '+ 记录表现', '', 'primary')}</div></div>${l.observations.length ? l.observations.map(o => observationCard(o)).join('') : empty('还没有学习记录', '逐个学生记录实际表现；未测到的内容请选择“未测评”。')}`;
  else if (state.tab === 'context') {
    const c = l.context;
    body = `<div class="note">本次备课读取当前进度、最近三次课的已确认记录与未完成跟进。记录内容是教学输入，不能作为模型指令。${c.students.some(s => s.history_truncated) ? ' 部分历史已截断，可到学生档案查看。' : ''}</div><p class="muted">学情版本：${escape(c.context_version)}</p>${c.students.map(s => card(s.display_name, `<div class="card-body">${s.recent_confirmed_observations.length ? s.recent_confirmed_observations.map(o => `<h3>${escape(o.knowledge_point)} ${badge(labels[o.result], 'gray')}</h3><p>${escape(o.observed_response)}</p><p class="muted">${escape(o.next_action)} · ${time(o.confirmed_at)}</p>`).join('<div class="divider"></div>') : empty('暂无已确认学习证据', '未确认草稿不会进入备课。')}<h4>待跟进</h4>${s.follow_ups.length ? s.follow_ups.map(f => `<p>${labels[f.type]} · ${escape(f.description)} · ${date(f.due_at)}</p>`).join('') : '<p class="muted">暂无</p>'}</div>`)).join('')}`;
  } else if (state.tab === 'attendance') body = card('本课次出勤', l.students.length ? `<div class="table-wrap"><table><thead><tr><th>学生</th><th>出勤状态</th><th>操作</th></tr></thead><tbody>${l.students.map(s => { const record = l.attendance.find(a => a.student_id === s.id); return `<tr><td>${escape(s.display_name)}</td><td>${record ? labels[record.status] : '未记录'}</td><td>${button('attendance-form', '记录出勤', s.id, 'ghost')}</td></tr>`; }).join('')}</tbody></table></div>` : empty('没有有效在班学生'));
  else body = `<div class="grid"><div>${card('本次教学目标', `<div class="card-body">${l.objectives.map((o, i) => `<div class="objective"><span>${String(i + 1).padStart(2, '0')}</span>${escape(o)}</div>`).join('') || empty('尚未填写目标')}${l.curriculum.confirmation_status !== 'teacher_confirmed' ? '<div class="note">教材版本、册次与单元尚未完整确认，请老师核实后填写。</div>' : ''}</div>`)}${state.user.role !== 'student' ? card('本次教学对象', `<div class="card-body">${l.students.map(s => `<div class="objective"><strong>${escape(s.display_name)}</strong><small>${escape(s.id)}</small></div>`).join('') || empty('没有有效在班学生')}</div>`) : ''}</div><div>${card('课次信息', `<div class="card-body"><dl class="info-list"><div><dt>班级</dt><dd>${escape(l.class_name)}</dd></div><div><dt>上课时间 · 北京时间</dt><dd>${time(l.starts_at)} — ${time(l.ends_at)}</dd></div><div><dt>状态</dt><dd>${badge(labels[l.status], 'gold')}</dd></div><div><dt>教材进度</dt><dd>${escape(curriculumText(l.curriculum))}</dd></div></dl>${state.user.role !== 'student' ? button('lesson-form', '修改课次信息', l.id, 'ghost') : ''}</div>`)}<div class="note">本课次已收到 ${l.publications.length} 份讲义。发布后形成固定快照，继续编辑草稿不会更改历史材料。</div></div></div>`;
  return button('navigate', '← 返回课次列表', 'lessons', 'back') + heading(l.title, `${l.class_name} · ${gradeName(l.school_grade)}`, isTeacher() ? button('launch', '去 Lessonfold 备课 ↗', l.id, 'primary') : '') + `<div class="tabs" role="tablist">${tabs.map(([key, name]) => button('tab', name, key, key === state.tab ? 'active' : '', `role="tab" aria-selected="${key === state.tab}"`)).join('')}</div>${body}`;
}
function studentPage() {
  const s = state.detail;
  return button('navigate', '← 返回学生列表', 'students', 'back') + heading(s.display_name, `${gradeName(s.school_grade)} · ${s.id}`) + card('学习时间线', `<div class="card-body">${s.observations.length ? s.observations.map(o => observationCard(o, false)).join('') : empty('暂无学习证据')}</div>`) + card('作业与复测记录', `<div class="card-body">${s.follow_ups.map(f => `<div class="objective">${badge(f.status === 'open' ? '待完成' : '已完成', 'gray')}<span>${labels[f.type]}</span>${escape(f.description)}</div>`).join('') || empty('暂无跟进记录')}</div>`);
}
function classPage() {
  const c = state.detail;
  return button('navigate', '← 返回班级列表', 'classes', 'back') + heading(c.name, `${gradeName(c.school_grade)} · ${curriculumText(c.curriculum)}`, isAdmin() ? button('class-form', '编辑班级 / 分配老师', c.id, 'primary') : '') + card('在班关系', `<div class="table-wrap"><table><thead><tr><th>学生</th><th>有效时间 · 北京时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${c.memberships.map(m => `<tr><td>${escape(m.display_name)}<small class="block">${escape(m.student_id)}</small></td><td>${date(m.valid_from)} — ${m.valid_until ? date(m.valid_until) : '持续有效'}</td><td>${badge(m.valid_until && m.valid_until <= new Date().toISOString() ? '已退出' : m.valid_from > new Date().toISOString() ? '待加入' : '在班', 'gray')}</td><td>${isAdmin() && !m.valid_until ? button('end-membership', '结束在班', m.id, 'ghost') : ''}</td></tr>`).join('')}</tbody></table></div>`, isAdmin() ? button('enroll', '+ 加入学生', c.id) : '');
}
async function settingsPage() {
  const [users, bindings, events] = await Promise.all([api('/api/users'), api('/api/account-bindings'), api('/api/audit-events')]); state.users = users; state.bindings = bindings;
  return heading('账号与连接', '管理员核验身份与分配权限；学习结论由授课老师确认。', button('user-form', '+ 开通账号', '', 'primary')) + card('成员账号', `<div class="table-wrap"><table><thead><tr><th>成员</th><th>用户名 / 角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${users.map(u => `<tr><td>${escape(u.display_name)}</td><td>${escape(u.username)} · ${labels[u.role]}</td><td>${badge(u.active ? '启用' : '停用', 'gray')}</td><td>${u.id !== state.user.id ? button('toggle-user', u.active ? '停用' : '启用', u.id, 'quiet') + button('reset-password', '重设密码', u.id, 'quiet') : '当前账号'}</td></tr>`).join('')}</tbody></table></div>`) + card('Lessonfold 连接', `<div class="card-body"><p>${badge(state.data.integration_configured ? '服务连接已配置' : '服务连接尚未配置', state.data.integration_configured ? '' : 'gold')}</p><p class="muted">服务地址与密钥由部署负责人在服务器配置。绑定前需核验老师同时控制双方账号。</p>${bindings.map(b => `<div class="objective"><div class="grow">${escape(users.find(u => u.id === b.teacher_id)?.display_name)}<small class="block">Lessonfold：${escape(b.lessonfold_user_id)} · ${b.active ? '已核验绑定' : '已撤销'}</small></div>${b.active ? button('revoke-binding', '撤销绑定', b.teacher_id, 'ghost') : ''}</div>`).join('')}${button('binding-form', '+ 核验并绑定老师', '', 'primary')}</div>`) + card('最近操作记录', `<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象 ID</th></tr></thead><tbody>${events.map(e => `<tr><td>${time(e.created_at)}</td><td>${escape(e.actor_name)}</td><td>${escape(e.action)}</td><td><small>${escape(e.object_id)}</small></td></tr>`).join('')}</tbody></table></div>`);
}
let refreshEpoch = 0;
async function refresh() {
  if (!state.user) return;
  const epoch = ++refreshEpoch;
  const [page, detailId] = (location.hash.slice(1) || 'dashboard').split('/');
  const tab = state.tab;
  try {
    const data = await api('/api/dashboard');
    if (epoch !== refreshEpoch || !state.user) return;
    let detail = null;
    if (['lesson', 'student', 'class'].includes(page) && detailId) {
      detail = await api(`/api/${{ lesson: 'lessons', student: 'students', class: 'classes' }[page]}/${encodeURIComponent(detailId)}`);
      if (epoch !== refreshEpoch || !state.user) return;
      if (page === 'lesson' && tab === 'context' && isTeacher()) detail.context = await api(`/api/lessons/${encodeURIComponent(detailId)}/teaching-context`);
    }
    if (epoch !== refreshEpoch || !state.user) return;
    state.data = data; state.page = page; state.detail = detail;
    let content;
    if (detail) content = { lesson: lessonPage, student: studentPage, class: classPage }[page]();
    else if (page === 'settings' && isAdmin()) content = await settingsPage();
    else content = ({ dashboard, students: studentsPage, classes: classesPage, lessons: lessonsPage, followups: followupsPage }[page] || dashboard)();
    if (epoch === refreshEpoch && state.user) shell(content);
  } catch (error) {
    if (epoch !== refreshEpoch) return;
    if (state.user) shell(heading('暂时无法打开此页面', error.message) + card('重新打开', '<div class="card-body">' + button('reload', '重试', '', 'primary') + ' ' + button('navigate', '返回教学概览', 'dashboard') + '</div>'));
    throw error;
  }
}

async function studentForm(studentId) {
  const s = state.data.students.find(s => s.id === studentId);
  await dialog(s ? '编辑学生' : '新建学生', field('display_name', '学生姓名', s?.display_name, 'text', true, 'maxlength="200"') + field('school_grade', '学校年级（1–12）', s?.school_grade || 8, 'number', true, 'min="1" max="12"'),
    data => api(s ? `/api/students/${s.id}` : '/api/students', s ? 'PATCH' : 'POST', { ...data, school_grade: Number(data.school_grade), ...(s ? { expected_revision: s.revision } : {}) }));
}
async function classForm(classId) {
  const c = state.data.classes.find(c => c.id === classId); const users = await api('/api/users');
  const teachers = users.filter(u => u.role === 'teacher' && u.active).map(u => [u.id, u.display_name]);
  if (!teachers.length) { toast('请先开通一个老师账号。'); return; }
  await dialog(c ? '编辑班级与老师' : '新建班级', field('name', '班级名称', c?.name) + select('teacher_id', '授课老师', teachers, c?.teacher_id) + field('school_grade', '学校年级（1–12）', c?.school_grade || 8, 'number', true, 'min="1" max="12"') + curriculumFields(c?.curriculum) + '<p class="note">改派老师后，原老师立即失去该班权限；新老师可以接续查看这个班的历史课次。</p>',
    data => api(c ? `/api/classes/${c.id}` : '/api/classes', c ? 'PATCH' : 'POST', { name: data.name, teacher_id: data.teacher_id, school_grade: Number(data.school_grade), curriculum: curriculumData(data), ...(c ? { expected_revision: c.revision } : {}) }));
}
async function lessonForm(lessonId) {
  const l = state.data.lessons.find(l => l.id === lessonId);
  await dialog(l ? '修改课次' : '安排课次', (l ? '' : select('class_id', '班级', state.data.classes.map(c => [c.id, c.name]))) + field('title', '课次名称', l?.title) + `<div class="two-fields">${field('starts_at', '开始时间 · 北京时间', localDate(l?.starts_at), 'datetime-local')}${field('ends_at', '结束时间 · 北京时间', localDate(l?.ends_at), 'datetime-local')}</div>` + (l ? select('status', '课次状态', choices(['scheduled', 'completed', 'cancelled']), l.status) : '') + area('objectives', '教学目标（每行一条）', l?.objectives.join('\n')) + (l ? curriculumFields(l.curriculum) + (isTeacher() ? `<label class="check"><input name="curriculum_confirmed" type="checkbox" ${l.curriculum.confirmation_status === 'teacher_confirmed' ? 'checked' : ''}>我已核实教材版本、册次与单元；填写完整后确认本课次进度。</label>` : '<p class="note">教材信息由授课老师核实并确认。</p>') : '<p class="note">教材进度初始继承班级设置，可由老师在课次中确认。</p>'), data => api(l ? `/api/lessons/${l.id}` : '/api/lessons', l ? 'PATCH' : 'POST', { ...data, starts_at: utcDate(data.starts_at), ends_at: utcDate(data.ends_at), objectives: data.objectives.split('\n').map(s => s.trim()).filter(Boolean), ...(l ? { curriculum: curriculumData(data), expected_revision: l.revision } : {}) }));
}
async function observationForm(observationId) {
  const o = state.detail.observations.find(o => o.id === observationId);
  if (state.page === 'student' && !o) return;
  if (!o && !state.detail.students?.length) { toast('本课次没有可记录的学生，请先维护在班关系。'); return; }
  await dialog(o ? '编辑学习证据草稿' : '记录学生表现', (o ? '' : select('student_id', '学生', state.detail.students.map(s => [s.id, `${s.display_name} · ${s.id.slice(-6)}`]))) + select('domain', '教学领域', choices(['vocabulary', 'grammar', 'reading', 'listening', 'speaking', 'writing']), o?.domain) + field('knowledge_point', '具体知识点', o?.knowledge_point, 'text', true, 'maxlength="500"') + area('observed_response', '实际作答 / 表现（学习证据）', o?.observed_response, true) + select('result', '结果', choices(['not_assessed', 'incorrect', 'partially_correct', 'correct']), o?.result || 'not_assessed') + field('score', '分数（可留空；未测评须留空）', o?.score, 'number', false, 'min="0" max="100" step="0.1"') + area('next_action', '下一步 / 复测建议', o?.next_action) + field('evidence_ref', '原始证据引用（可选，非公开链接）', o?.evidence_ref, 'text', false) + '<p class="note">保存为草稿。核对并确认后，才进入正式学情与下一课备课。</p>', data => api(o ? `/api/observations/${o.id}` : `/api/lessons/${state.detail.id}/observations`, o ? 'PATCH' : 'POST', { ...data, score: data.score === '' ? null : Number(data.score), ...(o ? { expected_revision: o.revision } : {}) }));
}
const actions = {
  navigate: async key => { state.tab = 'overview'; state.filter = ''; if (location.hash === `#${key}`) await refresh(); else location.hash = key; },
  tab: async key => { state.tab = key; await refresh(); },
  reload: refresh,
  logout: async () => { await api('/api/logout', 'POST', {}); state.user = null; state.csrf = ''; refreshEpoch++; login(); },
  'password-form': async () => { await dialog('修改自己的密码', field('current_password', '当前密码', '', 'password', true, 'autocomplete="current-password" maxlength="200"') + field('new_password', '新密码（12–200 字符）', '', 'password', true, 'autocomplete="new-password" minlength="12" maxlength="200"') + '<p class="note">保存后所有登录会话失效，请使用新密码重新登录。</p>', async data => { await api('/api/me/password', 'POST', data); state.user = null; state.csrf = ''; login(); }); },
  'reset-password': async key => { const u = state.users.find(u => u.id === key); await dialog('重设成员密码', `<p>${escape(u.display_name)} · ${escape(u.username)}</p>` + field('new_password', '新密码（12–200 字符）', '', 'password', true, 'autocomplete="new-password" minlength="12" maxlength="200"') + check('confirmed', '我已核验成员身份。保存后该成员的登录会话与备课委托失效。'), data => api(`/api/users/${key}/password`, 'POST', data)); },
  'close-dialog': () => modal.close(), 'student-form': studentForm, 'class-form': classForm, 'lesson-form': lessonForm, 'observation-form': observationForm,
  launch: async lessonId => { const launch = await api('/integrations/v1/lessonfold/launches', 'POST', { lesson_id: lessonId }); location.assign(launch.launch_url); },
  'confirm-observation': async observationId => { const o = state.detail.observations.find(o => o.id === observationId); await dialog('核对并确认学习记录', `<h3>${escape(o.knowledge_point)}</h3><pre>${escape(o.observed_response)}</pre><p>结果：${labels[o.result]} · ${escape(o.next_action)}</p>${field('due_at', '下一步计划时间 · 北京时间（可选）', '', 'datetime-local', false)}${check('teacher_confirmed', '我已核对实际学习证据，确认记录准确。')}`, data => api(`/api/observations/${o.id}/confirm`, 'POST', { expected_revision: o.revision, teacher_confirmed: true, due_at: utcDate(data.due_at) })); },
  'followup-form': async () => { await dialog('添加作业或复测', select('student_id', '学生', state.detail.students.map(s => [s.id, `${s.display_name} · ${s.id.slice(-6)}`])) + select('type', '类型', choices(['homework', 'retest', 'teacher_advice'])) + area('description', '跟进内容', '', true) + field('due_at', '计划时间 · 北京时间（可选）', '', 'datetime-local', false), data => api(`/api/lessons/${state.detail.id}/follow-ups`, 'POST', { ...data, due_at: utcDate(data.due_at) })); },
  'complete-followup': async key => { const f = state.data.follow_ups.find(f => f.id === key); await dialog('完成跟进', `<p>${escape(f.description)}</p>${check('completed', '已完成这项跟进。完成待办不等于学生已掌握知识点。')}`, () => api(`/api/follow-ups/${key}/complete`, 'POST', { expected_revision: f.revision })); },
  'attendance-form': async studentId => { const a = state.detail.attendance.find(a => a.student_id === studentId); await dialog('记录出勤', select('status', '出勤状态', choices(['present', 'absent', 'leave', 'late']), a?.status) + '<p class="note">记录出勤不会自动确认学情、扣除课时或通知家长。</p>', data => api(`/api/lessons/${state.detail.id}/attendance`, 'PUT', { ...data, student_id: studentId, expected_revision: a?.revision || 0 })); },
  enroll: async classId => { await dialog('学生加入班级', select('student_id', '学生', state.data.students.map(s => [s.id, `${s.display_name} · ${s.id.slice(-6)}`])) + field('valid_from', '在班开始时间 · 北京时间', localDate(new Date().toISOString()), 'datetime-local') + field('valid_until', '在班结束时间（可选）', '', 'datetime-local', false), data => api(`/api/classes/${classId}/memberships`, 'POST', { ...data, valid_from: utcDate(data.valid_from), valid_until: utcDate(data.valid_until) })); },
  'end-membership': async key => { await dialog('结束在班关系', field('valid_until', '退出时间 · 北京时间', localDate(new Date().toISOString()), 'datetime-local') + '<p class="note">历史名单保留，退出生效后学生无法继续访问该班材料。</p>', data => api(`/api/memberships/${key}`, 'PATCH', { valid_until: utcDate(data.valid_until) })); },
  'user-form': async () => { await dialog('开通成员账号', field('username', '用户名', '', 'text', true, 'maxlength="80" autocomplete="off"') + field('display_name', '显示姓名') + select('role', '角色', choices(['teacher', 'admin', 'student']), 'teacher') + field('password', '初始密码（12–200 字符）', '', 'password', true, 'minlength="12" maxlength="200" autocomplete="new-password"') + select('student_id', '关联学生（仅学生角色使用）', [['', '非学生账号不关联'], ...state.data.students.map(s => [s.id, `${s.display_name} · ${s.id.slice(-6)}`])]), data => api('/api/users', 'POST', { ...data, student_id: data.role === 'student' ? data.student_id : null })); modal.querySelector('[name=student_id]').required = false; },
  'toggle-user': async key => { const u = state.users.find(u => u.id === key); await dialog(u.active ? '停用账号' : '启用账号', `<p>${escape(u.display_name)} · ${escape(u.username)}</p>${check('confirmed', u.active ? '停用账号并使现有会话立即失效。' : '重新启用此账号。')}`, () => api(`/api/users/${key}`, 'PATCH', { active: !u.active })); },
  'binding-form': async () => { const users = await api('/api/users'); await dialog('核验并绑定双方教师账号', select('teacher_id', '本平台老师', users.filter(u => u.role === 'teacher' && u.active).map(u => [u.id, u.display_name])) + field('lessonfold_user_id', 'Lessonfold 平台用户 ID') + check('admin_verified', '我已核验老师控制双方账号，确认此 ID 对应同一位老师；不以姓名匹配。'), data => api('/api/account-bindings', 'POST', { ...data, admin_verified: true })); },
  'revoke-binding': async teacherId => { await dialog('撤销 Lessonfold 账号绑定', check('confirmed', '撤销绑定并立即拒绝现有委托的读取与材料写入。'), () => api('/api/account-bindings', 'PATCH', { teacher_id: teacherId })); }
};
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]'); if (!target || target.disabled) return;
  const action = actions[target.dataset.action]; if (!action) return;
  target.disabled = true;
  try { await action(target.dataset.id); } catch (error) { toast(error.message); } finally { target.disabled = false; }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'student-search') return;
  state.filter = event.target.value;
  // Keep focus and selection while updating only the table body.
  const template = document.createElement('template'); template.innerHTML = studentsPage();
  app.querySelector('tbody').replaceWith(template.content.querySelector('tbody'));
});
window.addEventListener('hashchange', () => refresh().catch(error => toast(error.message)));
api('/api/me').then(result => { state.user = result.user; state.csrf = result.csrf; return refresh(); }).catch(() => login());
