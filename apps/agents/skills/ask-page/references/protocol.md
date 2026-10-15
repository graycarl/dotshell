# ask-page 协议参考

这份文档写给需要**手工调试**或**绕开 skill 直接用脚本**的场景。日常使用看
`SKILL.md` 即可。

## 1 目录布局

所有状态在 `<cwd>/.pi/ask-page/` 下（可用 `--root` 改）：

```
.pi/ask-page/
├── <slug>.html            # agent 写的页面源码（约定，不是脚本管的）
├── <pageId>/
│   ├── state.json         # token / port / version / status / serverPid / url ...
│   ├── page.html          # 真正被服务的副本
│   ├── result.json        # 提交结果，只写一次（first write wins）
│   ├── results/           # 多轮时被归档的历次结果 round-*.json
│   ├── uploads/           # 用户在浏览器里上传的文件
│   ├── server.log         # daemon 的 stdout/stderr
│   └── server.pid         # daemon 运行期间存在
```

`state.json` 关键字段：

| 字段 | 含义 |
|---|---|
| `pageId` | 页面 id（`ap-xxxxxx` 或 `--id` 指定的名字） |
| `token` | 访问令牌，同一个 pageId 跨轮次**复用**（否则旧标签页会失去访问权） |
| `port` | 监听端口，优先复用（旧标签页靠它继续轮询） |
| `version` | 从 1 开始；`ask`/`start`/`update` 每次都会 +1 |
| `status` | `starting` / `waiting` / `submitted` / `cancelled` / `timeout` / `expired` / `aborted` |
| `serverPid` | 当前服务器的 pid，`null` 或已死表示没有在跑 |

## 2 HTTP 接口

服务器只绑 `127.0.0.1`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/?t=<token>` | token | 返回 `page.html`，并在 `</body>` 前注入 `window.__PI__` 与 `/pi.js` |
| GET | `/pi.js?t=<token>` | token | 客户端 SDK |
| GET | `/pi/state` | token | `{pageId, version, status}`，页面用来判断是否需要自动刷新 |
| POST | `/pi/submit` | token + Origin | body `{payload, meta?}`，写入 `result.json` |
| POST | `/pi/cancel` | token + Origin | body `{reason?}`，写入 `result.json` |
| POST | `/pi/upload` | token + Origin | body 为原始字节；文件名取 `?name=` 或 `X-Pi-Filename` |
| GET | `/assets/<path>` | 无 | 映射 `--assets` 指定的目录 |
| GET | `/uploads/<path>` | 无 | 用户上传的文件 |
| GET | `/<file>` | 无 | `page.html` 同目录下的兄弟文件（图片、css…） |

鉴权细节：

- `token` 通过 `?t=` 查询参数或 `X-Pi-Token` 请求头传递。
- POST 会额外校验 `Origin`，只接受 `http://127.0.0.1:<port>`、`http://localhost:<port>`、`null` 或缺失。
- `state.json`、`result.json`、`server.log`、`page.html` 永远不会作为静态文件下发。
- `/assets` 与 `uploads` 做 realpath 前缀校验，`../` 穿越返回 404。
- 请求体上限 25 MiB。

提交是**幂等**的：`result.json` 用 `O_EXCL` 创建，第二次提交返回 `{"ok":true,"accepted":false}`。

## 3 客户端 SDK（`window.pi`）

页面由服务器自动注入，agent 不需要手动引入。

| API | 说明 |
|---|---|
| `pi.submit(extra?)` | 收集 `choices/comments/uploads` 并 POST `/pi/submit`；成功后显示遮罩、禁用按钮、停止轮询 |
| `pi.cancel(reason?)` | 二次确认后 POST `/pi/cancel` |
| `pi.comment(anchor, text, selectionText?)` | 手工添加一条批注 |
| `pi.choice(name, value)` | 手工设置一个选择值 |
| `pi.upload(file)` | 上传单个 `File`，返回 `{name, path, relPath, url, size}` |
| `pi.setExtra(key, value)` | 往提交载荷里塞自定义字段 |
| `pi.state` | `{choices, comments, uploads, extra}` |
| `pi.on(event, fn)` | 事件：`ready` / `submit` / `cancel` |
| `pi.rescan()` | 页面上新渲染出组件后，重新扫描 `data-pi-*` 标记 |

### 声明式标记

| 标记 | 效果 |
|---|---|
| `data-pi-anchor="name"` | 该元素可点击批注，提交时产出 `{anchor, text, selectionText}` |
| `data-pi-choice="name"` + `data-pi-options="a,b,c"` | 渲染为按钮组，值进入 `payload.choices[name]` |
| 上面的 `data-pi-labels="甲 \| 乙 \| 丙"` | 按钮显示文案 |
| `data-pi-multiple="true"` | 多选 |
| `data-pi-default="a"` | 默认值（多选用逗号分隔） |
| `data-pi-upload` | 容器或 `<input type=file>`，自动上传到 `uploads/` |
| `data-pi-comments` | 批注列表的渲染容器 |
| `data-pi-comments-count` | 批注数量的文本节点 |
| `data-pi-uploads-list` | 已上传文件列表的渲染容器 |
| `data-pi-submit` / `data-pi-cancel` | 按钮 |

SDK 自带 overlay、批注弹层、按钮组的样式（`pi-` 前缀的 class），不依赖模板。

## 4 提交载荷约定

自由 JSON，下面这个 envelope 是**约定**（`assets/template.html` 就是这么产出的）：

```json
{
  "decision": "approve",
  "choices": {"decision": "approve", "priority": "high"},
  "comments": [
    {"anchor": "plan-3", "text": "这里要多一个回滚步骤", "selectionText": "选择到的原文", "at": "2026-05-01T12:00:00Z"}
  ],
  "uploads": [
    {"name": "shot.png", "path": "/abs/.pi/ask-page/ap-x/uploads/shot.png", "relPath": "uploads/shot.png", "url": "/uploads/shot.png", "size": 12345}
  ],
  "extra": {}
}
```

- `choices.decision` 若存在，SDK 会把它提升为顶层 `decision`。
- 不加 `data-pi-choice="decision"` 也不影响：用户可以只写批注就提交。

### 工具返回（stdout）

```json
{"status":"submitted","pageId":"ap-a1b2c3","payload":{...},
 "meta":{"version":2,"submittedAt":"2026-05-01T12:00:00Z","elapsedMs":48213}}
```

| `status` | 退出码 | 含义 |
|---|---|---|
| `submitted` | 0 | 用户提交了 |
| `cancelled` | 2 | 用户点了"放弃"，或 agent `cancel` 了 |
| `timeout` | 3 | `--timeout` 到点；或页面已 `expired`／服务器已死 |
| `pending` | 4 | 仅 `collect`：还没提交 |
| `aborted` | 5 | 终端 Esc／SIGTERM 中止了等待 |
| `error` | 1 | 参数错误等 |

`collect` 也可能直接返回 `submitted` / `cancelled`（有结果时）。

## 5 手工调试片段

```bash
AP=~/.pi/agent/skills/ask-page/scripts/ask_page.py

# 起一个前台页面并等待提交
python3 $AP ask --html-file page.html --id demo

# 后台常驻 + 之后取结果
python3 $AP start --html-file page.html --id demo --idle-timeout 3600
python3 $AP collect demo
python3 $AP update demo --html-file page-v2.html
python3 $AP list
python3 $AP cleanup demo --keep-files

# 用 curl 模拟浏览器提交
PORT=$(python3 -c "import json;print(json.load(open('.pi/ask-page/demo/state.json'))['port'])")
TOKEN=$(python3 -c "import json;print(json.load(open('.pi/ask-page/demo/state.json'))['token'])")
curl -s "http://127.0.0.1:$PORT/?t=$TOKEN" | head -c 200
curl -s -X POST "http://127.0.0.1:$PORT/pi/submit?t=$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"decision":"approve","comments":[{"anchor":"plan-1","text":"ok"}]}}'
```
