# Lessonfold × 学生管理系统 · 实施约定 v1

本目录是本仓库学生系统侧的单一接口来源。输入的两份2026-10-02讨论稿是需求参考；其引用的另一个 Lessonfold 本地仓库不在本次修改范围。这里将拟议内容具体化为已实现的学生系统接口，外部 Lessonfold 仍须按此实现并共同联调。

## 文件

- `openapi.json`：OpenAPI 3.1，四个外部端点、凭证和返回结构。
- `teaching-context.v1.schema.json` / `lesson-publication.v1.schema.json`：JSON Schema 2020-12。
- `examples/`：虚构字段样例及固定可复现的 RFC 8785 / SHA-256 测试向量；样例ID不是本机演示库的随机ID。

## 字段归属与首版映射

| 原约定 | 实现与约束 |
| --- | --- |
| tenant_id / teacher_id / student_id / class_id / lesson_id | 学生平台生成稳定字符串ID；改名/改排不变。teacher与Lessonfold平台用户经管理员核验绑定，禁止姓名匹配。 |
| class_id 一对一可空 | 本版必填；一对一建单人班级。不支持无班级课次，避免有字段却无可执行权限模型。 |
| 在班关系 | valid_from 包含，valid_until 不包含；当前有效关系与课次时间关系均须成立。 |
| context_version | 可见教学输入的规范化SHA-256摘要；generated_at不参加版本。 |
| 学习证据 | observations 先存draft，老师确认成为teacher_confirmed；未测评score=null。 |
| recent_confirmed_observations | 最近三次有确认记录的先前授权课次，每人最多30条；history_truncated明确是否截断。 |
| follow_ups | 授权课次的未完成作业/复测/建议，包含due_at（可空）。 |
| 讲义快照 | publication_id / 版本 / 学情来源 / 接收名单 / 学生教师文本原子持久化；历史不可变。 |
| 同步状态 | 本平台仅在成功归档时返回accepted回执。Lessonfold负责pending_sync / synced / failed与持久化重试，不能拿本平台归档状态代替其传输状态。 |

所有对象本机构校验；教师授权按班级当前负责人校验。交接班级会撤销原老师对历史和未来课次的访问；本次课次保存原排课teacher_id供来源追溯，输出上下文teacher_id始终是当前已核验调用者。

## 握手

1. 老师以本平台会话调用 `POST /integrations/v1/lessonfold/launches`，正文 `{lesson_id}`。必须当前有课次权限且双方账号已核验绑定，服务配置完整。
2. 返回 `{launch_url,expires_at}`，URL仅包含随机 `launch` 入口码。有效期五分钟，仅哈希存库。
3. Lessonfold后端取得其**已认证当前平台用户 ID**，用 `Authorization: Bearer <LESSONFOLD_SERVICE_KEY>` 调用 `POST /integrations/v1/lessonfold/launches/exchange`，正文 `{launch_code,lessonfold_user_id}`。这个ID不能从未认证的浏览器参数获取。服务密钥只证明服务身份，核验映射与课次权限是另外一步。
4. 成功返回 `{delegation_token,expires_at,tenant_id,teacher_id,lesson_id}`。委托八小时、只限该课次、仅后端保存；单次消费与委托写入同一事务。错误账号不消费入口，重复消费返回409。
5. 读取/归档都同时发送服务 Bearer 和 `X-Lessonfold-Delegation: <delegation_token>`。每次请求重新检查账号启用、映射、课次和名单权限。委托过期后从本平台重新进入备课；没有浏览器可访问的服务凭据或长效刷新凭据。
6. Lessonfold消费后立即移除地址栏入口码并采用no-referrer，禁止记录完整URL、入口码、委托和正文。

本平台已实现上述学生系统提供的四个端点；Lessonfold自身的 `/api/integrations/student-system/launch`、关联保存与发布端点不在本仓库，不能由学生端伪造 `oai-authenticated-user-id` 代替。

## 读取上下文

`GET /integrations/v1/lessons/{lesson_id}/teaching-context` 仅输出教学字段、学生展示姓名、已确认先前事实、未完成跟进和教材待确认状态，不含家长联系方式、财务、未确认建议或其他班级数据。Context作为数据使用，备注不能升级为模型指令。

## 接收发布

`PUT /integrations/v1/lessons/{lesson_id}/materials/{publication_id}` 正文遵循 `lesson-publication.v1.schema.json`，250,000 UTF-8字节总请求上限，包括JSON编码与两版正文。学生版必须存在，asset_id唯一，只允许text/plain。机构、课次、班级、审核老师、接收名单均核验；个人材料需单独限定recipient_student_ids。老师应检查全班学生正文不含私人诊断，接收器不根据文字猜测是否属于个人信息。

计算摘要时删除顶层content_hash，按 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) 的UTF-16键排序与ECMAScript数值/字符串序列化规范化，UTF-8编码后SHA-256，格式 `sha256:<64个小写十六进制字符>`。不进行Unicode正规化；拒绝重复键、孤立代理、非有限数字。固定测试向量见examples/hash-vector.json。

首次合法归档返回201和回执；同ID/同内容返回200和原回执；同ID不同不可变内容返回409；重新发布须新ID，可通过supersedes_publication_id引用同课次、同有序接收名单的旧版本。快照与回执保存于一个SQLite事务。老师/学生读取材料仍验证当前权限。历史名单不自动追加新学生。

接收器核验发送端teacher_reviewed=true以及合法content_method，不接受brief/sources模式；发送端仍必须验证expected_revision、陈旧结果、实际生成内容、审核动作和学情变更。接收器无法通过外部ID自行读取Lessonfold草稿数据库。

## 错误与重试

`{error:{code,message,request_id,retryable}}`。400修正格式；401重新认证；403/404停止越权请求；409解决消费/内容冲突；413拆分并保留草稿；422补审核/绑定/材料；429/503临时退避重试。

网络故障/回执丢失使用同publication_id重试。发送端须把不可变快照与待同步任务原子保存，最多首轮三次退避，持久化失败并提供人工重试；不能依赖浏览器页面持续打开。接收器不存在更新/删除历史材料接口；没有课时核销或发消息副作用。

## 验证与双方责任

自动测试覆盖连续两课、未确认记录排除、第二位老师隔离/交接、同名与改名、进度变化、学生版过滤、入口过期/消费/身份不匹配、错误课次、服务凭据与委托组合、权限撤销、重复提交/丢回执、内容冲突、超长拒绝及数据库重启。

实际联调前Lessonfold负责人需完成自己的入口适配、经认证身份传递、关联恢复、审核快照、结果新鲜度校验和后台同步重试，并通过同一套接口测试向量；双方再验证真实部署HTTPS/Origin、账号映射和连续两课。当前不宣称已连接另一个远端服务。

2026-10-02：首版学生系统实施约定。新增history_truncated/due_at，明确class_id必填和八小时课次委托；发布字段语义保持原拟议lesson-publication.v1。后续语义不兼容变化须升主版本并共同评审。
