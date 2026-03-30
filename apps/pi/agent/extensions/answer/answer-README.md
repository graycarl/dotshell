# Answer Extension - 增强版

## 功能概述

这个扩展从 AI 助手的消息中提取问题，并提供交互式界面来回答。

## 新增功能 ✨

### 选项列表支持

当问题包含预定义选项时，会自动识别并显示为可选择的列表：

- **自动提取选项**：从文本中识别"A or B"、列表、编号等格式的选项
- **方向键选择**：使用 ↑/↓ 快速选择选项
- **数字键快选**：按 1-9 直接选择对应选项
- **文本输入兜底**：按 `t` 键可切换到文本输入模式

## 使用方法

### 触发方式

1. **命令**：输入 `/answer`
2. **快捷键**：按 `Ctrl + .`

### 交互说明

#### 选项选择模式（当问题有选项时）

```
╭────────────────────────────────────────╮
│ Questions (1/3)                        │
├────────────────────────────────────────┤
│ ● ○ ○                                  │
│                                        │
│ Q: What is your preferred database?   │
│                                        │
│ A: (Select an option)                 │
│                                        │
│     ❯ 1. MySQL                         │
│       2. PostgreSQL                    │
│       3. MongoDB                       │
│                                        │
│     Press 't' to switch to text input  │
│                                        │
├────────────────────────────────────────┤
│ ↑↓ select · 1-9 quick select ·        │
│ Enter confirm · Tab next · Esc cancel  │
╰────────────────────────────────────────╯
```

**快捷键：**
- `↑` / `↓` - 上下选择选项
- `1-9` - 直接选择对应编号的选项
- `Enter` - 确认选择并进入下一题
- `t` 或 `e` - 切换到文本输入模式
- `Tab` - 跳到下一个问题
- `Shift+Tab` - 跳到上一个问题
- `Esc` - 取消

#### 文本输入模式（默认或无选项时）

```
╭────────────────────────────────────────╮
│ Questions (2/3)                        │
├────────────────────────────────────────┤
│ ● ● ○                                  │
│                                        │
│ Q: What should we name this project?  │
│                                        │
│ A: [光标在此输入...]                    │
│                                        │
│                                        │
├────────────────────────────────────────┤
│ Tab/Enter next · Shift+Tab prev ·      │
│ Shift+Enter newline · Esc cancel       │
╰────────────────────────────────────────╯
```

**快捷键：**
- 正常输入文字
- `Enter` - 下一题
- `Shift+Enter` - 换行（多行输入）
- `t` 或 `e` - 如果问题有选项，切换回选项选择模式
- `Tab` - 跳到下一个问题
- `Shift+Tab` - 跳到上一个问题
- `Esc` - 取消

### 进度指示器

- 🔵 `●` (青色) - 当前正在回答的问题
- 🟢 `●` (绿色) - 已回答的问题
- ⚪ `○` (灰色) - 未回答的问题

### 提交确认

回答完最后一个问题后，会显示确认对话框：

```
╭────────────────────────────────────────╮
│ Submit all answers? (Enter/y to        │
│ confirm, Esc/n to cancel)              │
╰────────────────────────────────────────╯
```

## 示例场景

### 场景 1：带选项的问题

**AI 消息：**
> "I have a few questions:
> 1. Which database would you like to use? We support MySQL or PostgreSQL.
> 2. Do you want to use TypeScript or JavaScript?
> 3. What's your project name?"

**提取结果：**
```json
{
  "questions": [
    {
      "question": "Which database would you like to use?",
      "context": "We support MySQL or PostgreSQL.",
      "options": ["MySQL", "PostgreSQL"]
    },
    {
      "question": "Do you want to use TypeScript or JavaScript?",
      "options": ["TypeScript", "JavaScript"]
    },
    {
      "question": "What's your project name?"
    }
  ]
}
```

### 场景 2：自由文本问题

**AI 消息：**
> "Could you describe the main features you want in the application?"

**提取结果：**
```json
{
  "questions": [
    {
      "question": "Could you describe the main features you want in the application?"
    }
  ]
}
```

## 技术细节

### 问题提取

- 使用 LLM 提取问题（优先级：GPT-5.1 Codex Mini → Claude Haiku 4.5 → 当前模型）
- 结构化 JSON 输出
- 自动识别各种格式的选项列表

### UI 组件

- 基于 `@mariozechner/pi-tui` 的自定义组件
- 支持 ANSI 颜色和样式
- 响应式布局（最大宽度 120 字符）
- 缓存渲染结果以提高性能

### 答案格式

提交的答案格式：

```
Q: What is your preferred database?
> We support MySQL or PostgreSQL.
A: PostgreSQL

Q: Do you want to use TypeScript or JavaScript?
A: TypeScript

Q: What's your project name?
A: awesome-project
```

## 开发说明

### 核心文件

- `~/.pi/agent/extensions/answer.ts`

### 关键接口

```typescript
interface ExtractedQuestion {
  question: string;
  context?: string;
  options?: string[];  // 新增：选项列表
}
```

### 主要类

- `QnAComponent` - 交互式 Q&A 界面组件
  - `inputMode[]` - 每个问题的输入模式（'select' | 'text'）
  - `selectedOptionIndex[]` - 选项选择索引
  - `switchToTextMode()` - 切换到文本输入
  - `switchToSelectMode()` - 切换到选项选择

## 注意事项

- 确保在交互式模式下使用（需要 TTY）
- 选项选择支持最多 9 个选项的数字快选
- 文本输入模式支持多行输入
- 所有答案在最后统一提交
