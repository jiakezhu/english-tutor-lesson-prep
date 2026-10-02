# english-tutor-lesson-prep

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Claude Agent Skill](https://img.shields.io/badge/Claude-Agent%20Skill-blueviolet)
![Status](https://img.shields.io/badge/status-active-success)

> A context-aware Claude Agent Skill that reads a student's lesson history, identifies weak points and teacher annotations, then generates a personalized, curriculum-aligned tutoring document — automatically.
>
> 能读取历史备课文档与学生错题记录，结合下一单元课本内容，自动生成针对性备课文档的 Claude Agent Skill。

---

## The Core Idea · 核心理念

Most AI document tools generate content from scratch every time. This skill does something different: **it reads what already happened before it writes what comes next.**

大多数 AI 文档工具每次都从零生成内容。这个 Skill 做的事情不同：**它先读懂发生过什么，再决定下一步写什么。**

Before generating a single word of lesson content, the skill ingests four sources of context:

在生成任何内容之前，Skill 会先读取四类上下文：

| Input · 输入 | Source · 来源 | Purpose · 作用 |
|-------------|--------------|---------------|
| 👤 Student profile | Stored weakness tags, error history, grade level · 薄弱点标签、错题历史、当前年级 | Calibrate difficulty and review priority · 校准难度与复习优先级 |
| 📄 Previous lesson slides | Last session's `.docx` converted to text · 上节课课件转文本 | Extract dictation errors, starred items, teacher annotations · 提取默写错误、重点标记、教师批注 |
| 📚 Textbook content | Next unit's word list and theme · 下一单元词表与主题 | Align new content to curriculum · 对齐课程进度 |
| 📊 Vocabulary CSV | Student's full word database · 学生完整词汇数据库 | Filter unit-specific vocab with proficiency context · 结合掌握情况筛选词汇 |

The output is not a generic lesson plan. It is a document **built around what this specific student struggled with last time, calibrated to what they need to learn next.**

输出的不是通用备课文档，而是**围绕这位学生上次的薄弱点、面向下一阶段学习目标**量身定制的内容。

---

## What It Reads · 读取内容

### From previous lesson documents · 从历史备课文档读取

- **Dictation errors (默写错误):** Words the student misspelled or blanked — automatically surfaced as review priority in the new document
- **Starred / highlighted items (重点标记):** Phrases or grammar points the teacher flagged during the last session — carried forward into the next KP section
- **Teacher notes (批注):** Free-form comments written during or after class — parsed to inform tone, difficulty level, and focus areas

- **默写错误：** 学生上次写错或未写出的词汇——自动提升为新文档的复习优先级
- **重点标记：** 上节课教师标注的词组或语法点——顺延进入下一份文档的知识点版块
- **批注内容：** 课中或课后的自由备注——用于调整难度、语气和重点方向

### From the next unit's textbook content · 从下一单元课本读取

- Unit theme and topic keywords → used to write an **original, on-topic reading passage**
- Core vocabulary list → cross-referenced with student's CSV to identify **new words that need introduction vs. words already seen**
- Typical writing formats for this unit type → used to construct **targeted writing prompts with format notes**

- 单元主题与关键词 → 用于撰写**贴合主题的原创阅读短文**
- 核心词汇表 → 与学生词汇 CSV 交叉比对，区分**首次出现的生词与已见过的词汇**
- 该单元对应的常见作文文体 → 用于构建**包含格式要点的针对性作文题目**

---

## Pipeline · 流水线

**[→ View interactive flowchart · 查看交互式流程图](https://jiakezhu.github.io/images/agent-flowchart.html)**

```
  TRIGGER · 触发
  ─────────────────────────────────────────────────────────
  "明天给王腾昊上课，默写必修3第三单元"

        │
        ▼
  STEP 01 · Parse & Retrieve · 解析与检索
  ─────────────────────────────────────────────────────────
  • Identify student name & target unit
  • Load student profile: weakness tags, error history, grade
  • 识别学生姓名与目标单元，读取学生画像：薄弱点标签、错题历史、年级

        │
        ▼
  STEP 02 · Parallel File Access · 并行文件读取
  ─────────────────────────────────────────────────────────
  ┌──────────────────────┐   ┌──────────────────────────┐
  │ Latest lesson slides │   │  Vocabulary CSV          │
  │ (.docx → text)       │   │  (student word database) │
  │ 上节课课件转文本      │   │  学生词汇数据库           │
  └──────────┬───────────┘   └───────────┬──────────────┘
             └──────────────┬────────────┘
                            │
        ▼
  STEP 03 · AI Core Generation · AI 核心生成
  ─────────────────────────────────────────────────────────
  Claude synthesizes all context and generates 5 modules:
  Claude 综合所有上下文，生成五个教学版块：

  ① Review dictation list    (errors from last session)
     复习默写词表             （上次错词优先）
  ② New vocabulary list      (unit words, deduped against history)
     新课默写词表             （去重历史已见词汇）
  ③ Reading comprehension    (original passage + leveled questions)
     阅读理解                 （原创短文 + 梯度题目）
  ④ Essay instruction        (format notes + model paragraphs)
     作文讲解                 （格式要点 + 范文首段）
  ⑤ Grammar & vocab KPs      (tables targeting flagged weak areas)
     知识点精讲               （针对标记薄弱点的对比表格）

        │
        ▼
  STEP 04 · Dual Format Output · 双格式输出
  ─────────────────────────────────────────────────────────
  ┌─────────────────┐   ┌───────────────────────────────┐
  │  Markdown       │   │  Word (.docx)                 │
  │  (archive/web)  │   │  color-coded, print-ready     │
  │  存档 / 网页预览  │   │  配色完整，即刻可打印          │
  └─────────────────┘   └───────────────────────────────┘

        │  (optional · 可选)
        ▼
  STEP 05 · Post-Class Email Dispatch · 课后自动发邮件
  ─────────────────────────────────────────────────────────
  Teacher triggers one command → SMTP sends:
  教师一键触发 → SMTP 自动发送：

  • Lesson summary & key takeaways · 课堂小结与重点回顾
  • Document attachments (.docx) · 文档附件
  • Homework checklist · 作业清单
  • Next-class preview · 下节课预习提示
```

---

## Output Structure · 文档结构

| # | Section · 版块 | Personalization · 个性化逻辑 |
|---|---------------|----------------------------|
| 1 | 复习默写 | Prioritizes words the student got wrong last session · 优先包含上次错词 |
| 2 | 新课默写 | 15 new words, cross-checked against student's prior exposure · 与历史词汇交叉去重 |
| 3 | 核心词组 | Carries forward any starred phrases from previous doc · 顺延上次标注词组 |
| 4 | 阅读理解 | Original passage themed to the next unit · 原创短文对齐下一单元主题 |
| 5 | 知识点精讲 | Grammar tables targeting flagged weak areas · 针对标记薄弱点设计对比表 |
| 6 | 作文讲解 | Format and prompts matched to this unit's exam writing type · 文体与考纲对齐 |
| 7 | 课后作业 + 下节课预告 | Preview words seeded from the unit after next · 基于后续单元提前播种词汇 |

Both **Markdown** and **Word (.docx)** versions are saved automatically. The `.docx` is color-coded and print-ready; the Markdown serves as a lightweight archive and can be rendered in any browser.

系统自动保存 **Markdown** 与 **Word (.docx)** 两份格式。`.docx` 配色完整，即刻可打印；Markdown 作为轻量存档，可在任意浏览器渲染。

---

## Technical Design · 技术设计

### Context extraction · 上下文提取

The skill reads previous lesson `.docx` files directly — parsing table contents, identifying annotated rows, and extracting free-text teacher notes. It also reads a per-student profile (weakness tags, error history, grade level) to calibrate difficulty before content generation begins. No separate tagging system or database is required; the documents and CSV files themselves are the source of truth.

Skill 直接读取历史课件 `.docx` 文件——解析表格内容、识别标注行、提取自由文本批注——同时读取学生画像（薄弱点标签、错题历史、年级），在内容生成开始前完成难度校准。无需独立的标签系统或数据库，文档和 CSV 文件本身即为数据来源。

### Post-class email dispatch · 课后自动发邮件

After the lesson, a single command triggers an SMTP email to the student containing: a lesson summary, the `.docx` attachment, a homework checklist, and a next-class vocabulary preview. The email content is compiled from the same config object used to generate the document — no duplication of effort.

课后一键触发 SMTP 发送邮件，内容包括：课堂小结、`.docx` 附件、作业清单、下节课预习词表。邮件内容直接从生成文档时所用的同一 config 对象中编译——无需重复填写任何信息。

### Skill definition · Skill 定义

All pipeline logic is encoded in `SKILL.md`: data schemas, reading rules, content composition constraints, and the config shape expected by the renderer. This means the pipeline is fully auditable, version-controlled, and adjustable without touching any code.

全部流水线逻辑均编码在 `SKILL.md` 中：数据格式、读取规则、内容生成约束、渲染器所需的 config 结构。这意味着整个流水线完全可审计、可版本控制，调整规则无需改动任何代码。

### Document renderer · 文档渲染器

`scripts/generate_lesson.js` is a config-driven Word document builder using [`docx`](https://www.npmjs.com/package/docx) (Node.js). It handles table layouts, per-unit color theming, header/footer injection, and shading — keeping all presentation logic entirely separate from content.

`scripts/generate_lesson.js` 是基于 [`docx`](https://www.npmjs.com/package/docx)（Node.js）的配置驱动文档构建器，负责处理表格布局、单元主题配色、页眉页脚注入与单元格着色——将所有展示逻辑与内容完全分离。

### Reference knowledge base · 参考知识库

The `references/` folder grounds Claude's generation with structured, unit-specific knowledge:

`references/` 目录为 Claude 的生成提供结构化约束：

- **`unit-themes.md`** — Unit-to-topic mappings, passage settings, writing directions, and KP suggestions for 必修1–3 · 必修1–3各单元主题映射、短文场景、作文方向与知识点建议
- **`color-map.md`** — Per-unit color palettes for consistent visual identity · 各单元专属配色，保证视觉风格一致
- **`kp-table-patterns.md`** — Five reusable table templates with exact column specs · 五种可复用知识点表格模板，含精确列宽规格

---

## Repository Structure · 项目结构

```
english-tutor-lesson-prep/
├── SKILL.md                      # Agent skill definition, pipeline logic, reading rules
│                                 # Skill 定义、流水线逻辑、读取规则
├── scripts/
│   └── generate_lesson.js        # Config-driven docx rendering engine
│                                 # 配置驱动的文档渲染引擎
└── references/
    ├── unit-themes.md             # Unit → theme / passage / writing map (必修1–3)
    ├── color-map.md               # Per-unit color palette definitions
    └── kp-table-patterns.md       # Reusable knowledge point table templates
```

---

## Installation · 安装

**Prerequisites · 前置要求**
- Node.js ≥ 18
- `npm install docx`

**Install as a Claude Code skill · 安装为 Claude Code Skill**
```bash
git clone https://github.com/jiakezhu/english-tutor-lesson-prep.git ~/.claude/skills/english-tutor-lesson-prep
```

**Configure paths · 配置路径**

Edit `SKILL.md` to point to your vocabulary CSV and lesson history folder:

修改 `SKILL.md` 中的路径，指向词汇文件与历史课件目录：

```
CSV:     /Users/YOUR_USERNAME/Desktop/英语家教/课件/txt缓存/课本/STUDENT_单词表.csv
Lessons: /Users/YOUR_USERNAME/Desktop/英语家教/课件/txt缓存/课件/STUDENT/
Output:  /path/to/output/folder/
```

**Run manually · 手动运行**
```bash
node scripts/generate_lesson.js --config /tmp/lesson_config.json --output ./output.docx
```

---

## Design Principles · 设计原则

**Continuity over novelty · 连续性优于新颖性**
Each lesson document is a direct response to the previous one. The system is designed to accumulate pedagogical context over time, not reset it.

每份备课文档都是对上一份的直接回应。系统设计为随时间积累教学上下文，而非每次重置。

**Grounded generation · 有据可查的生成**
Claude's output is constrained by explicit reference documents and real student data — not open-ended generation. This keeps content accurate, curriculum-aligned, and pedagogically consistent across sessions.

Claude 的输出受显式参考文档和真实学生数据约束，而非开放式生成。这保证内容准确、符合课程进度，并在课次间保持教学连贯性。

**Separation of concerns · 关注点分离**
Intelligence (Claude + SKILL.md) and rendering (Node.js + generate_lesson.js) are fully decoupled. Swapping the output format, the AI model, or the reference corpus requires changing only one layer.

智能层（Claude + SKILL.md）与渲染层（Node.js + generate_lesson.js）完全解耦。更换输出格式、AI 模型或参考知识库，只需修改对应的单一层。

---

## License · 许可证

MIT

---

## Student Management Platform · 学生管理平台

[`student-platform/`](student-platform/README.md) adds an independent Node.js 24+ / SQLite web application for student profiles, classes, lesson scheduling, attendance, teacher-confirmed learning evidence, homework/retests, and the student-system side of Lessonfold integration. Existing lesson generation scripts, reference content, and Skill instructions remain unchanged. Start with `cd student-platform && node src/cli.js demo`, then `node src/server.js`; the CLI creates fictional data and prints a random demo password.

学生管理平台包含权限隔离、一次性备课入口、已确认学情读取和不可变讲义归档；运行与验收步骤见上方文档，机器可验证的接口见 [`integration-contracts/`](integration-contracts/README.md)。外部 Lessonfold 需要另行实现接收端与发布同步，配置地址本身不代表已完成跨系统联调。
