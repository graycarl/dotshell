---
name: blog
description: Manage the Jekyll blog at ~/Sources/Blogs. Use when the user asks to write/read a blog post or essay, publish an article, list existing articles, or read a specific article. Covers the repository https://github.com/graycarl/blogs and the site https://graycarl.me/.
---

# Blog Skill

管理基于 Jekyll 的个人博客仓库 `~/Sources/Blogs`（仓库 `https://github.com/graycarl/blogs`，站点 `https://graycarl.me`）。

## 仓库约定

- 博客文章目录：`~/Sources/Blogs/_posts/blog/`
- 随笔目录：`~/Sources/Blogs/_posts/essay/`
- 静态资源目录：`~/Sources/Blogs/fs/`
- 日期格式：`YYYY-MM-DD HH:MM`，使用 `Asia/Shanghai` 时区
- 文件命名格式：`YYYY-MM-DD-{english-slug}.md`
- 站点配置：`~/Sources/Blogs/_config.yml`

## 使用场景

- 用户说“写篇博客/随笔/Blog/Essay 关于 xxx” → 进入写作流程
- 用户说“列出所有文章”/“看看我最近写了什么” → 进入列表流程
- 用户说“读一下/打开/查看某篇文章” → 进入阅读流程

## 写作流程

1. **判断分类**
   - 如果用户明确说“随笔/essay/感想” → 保存到 `_posts/essay/`
   - 否则默认保存到 `_posts/blog/`

2. **生成英文 slug**
   - 将标题翻译成简洁、URL 友好的英文
   - 全部小写，空格和标点替换为 `-`，去除多余 `-`
   - 例如标题“AI 帮我升级博客基础设施” → slug `ai-helps-update-blog-infrastructure`

3. **生成文件名**
   - 使用当前日期：`YYYY-MM-DD-{slug}.md`
   - 例如：`2026-07-14-ai-helps-update-blog-infrastructure.md`

4. **生成 front matter**
   ```yaml
   ---
   layout: post
   title: "用户给定的标题"
   date: 2026-07-14 14:30
   tags: [tag1, tag2, tag3]
   ---
   ```
   - `title` 保留用户原始语言（中文或英文）
   - `date` 使用准确的当前北京时间，使用 date 命令获取
   - `tags` 必须是 YAML 数组格式，根据内容自动提取 3-5 个相关标签

5. **生成正文**
   - 基于用户给出的标题/大纲，撰写完整、连贯的 Markdown 正文；
   - 文章内容准确、精炼、有条理，避免无意义的情绪化表达；
   - 不要在正文中重复 front matter 中的标题

6. **预览并确认**
   - 向用户展示：
     - 文件完整路径
     - front matter
     - 正文前 200 字摘要
     - 即将使用的 commit message：`feat(blog): Add {slug}` 或 `feat(essay): Add {slug}`
   - 询问用户是否确认发布

7. **提交并推送（用户确认后）**
   ```bash
   cd ~/Sources/Blogs
   git add _posts/{blog,essay}/YYYY-MM-DD-{slug}.md
   git commit -m "feat(blog): Add {slug}"
   # 或 feat(essay): Add {slug}
   git push
   ```
   - 如果用户要求修改，回到步骤 5/6
   - 如果用户放弃，不要创建文件或删除已创建但未提交的文件

## 阅读流程

1. **列出所有文章**
   ```bash
   ls -1 ~/Sources/Blogs/_posts/blog ~/Sources/Blogs/_posts/essay
   ```
   - 展示文件名，可附带简短说明（日期 + 标题/关键词）

2. **按关键词定位文章**
   - 如果用户给出标题关键词，优先在文件名中匹配：
     ```bash
     rg -i "keyword" ~/Sources/Blogs/_posts --files-with-matches
     ```
   - 如果关键词匹配多篇，列出候选让用户选择

3. **读取指定文章**
   ```bash
   cat ~/Sources/Blogs/_posts/{blog,essay}/YYYY-MM-DD-title.md
   ```
   - 读取后展示全文内容，必要时总结要点

## 静态资源

- 如果文章需要配图，建议放在 `~/Sources/Blogs/fs/`
- 图片引用路径：`/fs/{filename}`（Jekyll 会原样复制到站点根目录）
- 图片文件名建议带日期前缀：`17-08-03-xxx.png`

## 注意事项

- 不要修改 `.ruby-version`、`_config.yml` 或 `Gemfile` 等基础设施配置，除非用户明确要求
- 不要在未经用户确认的情况下直接 `git push`
- `tags` 必须是 YAML 数组：`tags: [a, b, c]`，不要写成 `tags: a, b, c`
- 日期使用当前准确时间，避免使用模板中的占位时间（如 `2026-07-13 12:00`）
- 提交信息使用英文，固定格式：`feat(blog): Add {slug}` 或 `feat(essay): Add {slug}`
