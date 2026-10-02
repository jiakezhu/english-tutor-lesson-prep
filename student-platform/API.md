# 内部 API v1

浏览器采用 HttpOnly cookie 会话。`POST /api/login` 需要精确匹配 `PLATFORM_ORIGIN`；登录返回用户（不含密码）和 CSRF。其余写接口同时需要相同 Origin 与 `X-CSRF-Token`。`GET /api/me` 可恢复当前用户/CSRF。过期、停用或退出会话返回 401；无权对象以 404 防枚举。统一错误 `{error:{code,message,request_id,retryable}}`，不返回内部堆栈。

| 方法与路径 | 输入 / 用途 | 权限 |
| --- | --- | --- |
| GET `/health` | `{status: "ok"}` | 无身份；不返回业务数据 |
| POST `/api/login` | username, password | Origin |
| GET `/api/me` / POST `/api/logout` | 当前身份 / 退出 | 已登录 |
| POST `/api/me/password` | current_password, new_password；使所有会话失效 | 本人 |
| GET `/api/dashboard` | 当前可访问学生/班级/课次/待办 | 按身份过滤 |
| GET/POST `/api/users` | 账号列表 / username, password, display_name, role, student_id | 管理员 |
| PATCH `/api/users/{id}` | active；不能停用自己 | 管理员、本机构 |
| POST `/api/users/{id}/password` | new_password；撤销会话和委托 | 管理员、本机构 |
| POST `/api/students` | display_name, school_grade (1–12) | 管理员 |
| PATCH `/api/students/{id}` | 同创建字段 + expected_revision | 管理员 |
| GET `/api/students/{id}` | 私人学习时间线、作业/复测历史 | 当前授权老师 |
| POST `/api/classes` | name, teacher_id, school_grade, curriculum | 管理员 |
| GET/PATCH `/api/classes/{id}` | 班级与成员 / 同创建字段 + expected_revision | 读取按老师隔离；修改限管理员 |
| POST `/api/classes/{id}/memberships` | student_id, valid_from, valid_until? | 管理员；拒绝重叠时间 |
| PATCH `/api/memberships/{id}` | valid_until | 管理员；保留历史 |
| POST `/api/lessons` | class_id, title, starts_at, ends_at, objectives, curriculum? | 管理员 |
| GET/PATCH `/api/lessons/{id}` | 课次详情 / title, starts_at, ends_at, status, objectives, curriculum, expected_revision | 读取按身份；修改限授权老师/管理员 |
| PUT `/api/lessons/{id}/attendance` | student_id, status, expected_revision（新记录为0） | 授权老师/管理员 |
| GET `/api/lessons/{id}/teaching-context` | 当前已确认学情 | 授权老师 |
| POST `/api/lessons/{id}/observations` | student_id, domain, knowledge_point, observed_response, result, score?, evidence_ref?, next_action? | 授权老师；创建草稿 |
| PATCH `/api/observations/{id}` | 观察字段 + expected_revision | 授权老师；只改草稿 |
| POST `/api/observations/{id}/confirm` | expected_revision, teacher_confirmed=true, due_at? | 授权老师；事实与复测待办原子保存 |
| POST `/api/lessons/{id}/follow-ups` | student_id, type, description, due_at? | 授权老师 |
| POST `/api/follow-ups/{id}/complete` | expected_revision | 授权老师 |
| GET/POST/PATCH `/api/account-bindings` | 列表 / teacher_id, lessonfold_user_id, admin_verified=true / teacher_id撤销 | 管理员；已线下核验双方账号控制权 |
| GET `/api/audit-events` | 最近200条操作；只存对象/状态，不存正文 | 管理员 |

curriculum 字段：edition_id, edition_name, book_id, unit_id 可空，confirmation_status 为 pending_teacher_confirmation 或 teacher_confirmed。管理员填满字段仍保留待确认，老师需在课次上明确确认且四个字段均非空。所有时间要求 `YYYY-MM-DDTHH:mm:ss[.SSS]Z`，UTC；页面在北京时间输入和显示。

domain: vocabulary / grammar / reading / listening / speaking / writing。result: correct / incorrect / partially_correct / not_assessed。未测评分数必须为空。作业 type: homework / retest / teacher_advice；出勤 status: present / absent / leave / late；课次 status: scheduled / completed / cancelled。

浏览器请求 JSON 上限250,000 UTF-8字节（登录2,000、账号4,000、入口2,000字节）。拒绝重复 JSON 键、非法 Unicode、非有限数字、超过64层嵌套及未知发布字段。姓名/标题最多200字符、学习证据5000、知识点500、跟进2000、目标20条（每条500字符）。内部接口只有文档字段被写入数据库，不依赖客户端发送机构/归属ID。没有公开初始化、匿名数据、草稿发布或服务密钥读取接口。
