# ask-page 示例：一份待评审的 Markdown

这份正文就是示例：它全部用 Markdown 写成，没有任何 HTML，也没有手写锚点。
每个标题、段落、列表项都由脚本自动挂上批注锚点，点一下就能写意见。

## 1. 为什么要改

现在 `submit()` 在拷贝失败时会静默返回，用户以为已经拿到了结果。

- 剪贴板 API 只在安全上下文里可用，`file://` 下经常退化成 `execCommand`
- 三条降级路径各自返回不同的字符串，调用方没有统一判断
- 失败时的提示语和成功时长得一样

> 结论：先统一返回语义，再谈提示文案。

## 2. 具体改动

### 2.1 统一返回值

| 路径 | 现在 | 改后 |
|---|---|---|
| `navigator.clipboard` | `"clipboard"` | `{ok: true, how: "clipboard"}` |
| `execCommand` | `"execCommand"` | `{ok: true, how: "legacy"}` |
| 手动选择 | `"manual"` | `{ok: false, how: "manual"}` |

### 2.2 改动点

1. `copyText()` 的 `done` 回调改成接收结果对象
2. `showPop()` 根据 `ok` 决定标题栏颜色
3. 补一个失败时的 `console.warn`，方便排查

```js
function copyText(text, done) {
  // 调用方只看 ok，不再猜字符串
  legacyCopy(text).then(function (how) {
    done({ ok: how !== "manual", how: how });
  });
}
```

## 3. 待办

- [x] 统一 `copyText` 返回值
- [x] `showPop` 按 `ok` 着色
- [ ] 回归 `file://` 下的三条降级路径
- [ ] 补一条浏览器兼容说明

## 4. 需要你确认

这段是给批注用的靶子：第 2 节的表格结构是否够清楚，第 3 节的待办项是否该拆成两个迭代。

嵌套列表也支持，用来表达条件分支：

- 如果压测通过
  - 直接灰度 5%
  - 观察 30 分钟
- 如果压测不通过
  - 回滚到上一个 tag

---

分割线以上是正文。写完批注后点右下角「复制结果」。
