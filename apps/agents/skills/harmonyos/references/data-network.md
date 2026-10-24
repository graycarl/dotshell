# 数据持久化、网络、权限与日志

「把数据存下来 / 发请求 / 拿权限 / 打日志」时读这篇。API 签名以 SDK d.ts 为准，
权限合法性以 `PermissionDefinitions.json` 为准（见 `resources.md`）。

## 持久化选型

| 需求 | 方案 | 说明 |
|---|---|---|
| 少量配置项（开关、主题、最近项） | `preferences`（用户首选项） | KV，异步 API，轻量；不用于列表数据 |
| 结构化业务数据（增删改查、排序、分页） | `relationalStore`（RDB，SQLite 封装） | **默认选择**；谓词查询、事务、索引都支持 |
| 大对象/文件（图片、附件、导出文件） | `@ohos.file.fs` + 应用沙箱目录 | 用 `context.filesDir` / `cacheDir`，别写死绝对路径 |
| 跨进程/分布式 KV | `distributedKVStore` | 有跨设备同步需求时才用 |

RDB 基本套路（`@kit.ArkData`）：

```ts
import { relationalStore } from '@kit.ArkData'

const STORE_CONFIG: relationalStore.StoreConfig = {
  name: 'app.db', securityLevel: relationalStore.SecurityLevel.S1
}
const store = await relationalStore.getRdbStore(context, STORE_CONFIG)
await store.executeSql(`CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER DEFAULT 0)`)

// 插入
await store.insert('task', { title: '写方案', done: 0 } as relationalStore.ValuesBucket)
// 查询
const predicates = new relationalStore.RdbPredicates('task')
predicates.equalTo('done', 0).orderByAsc('id')
const rs = await store.query(predicates, ['id', 'title', 'done'])
while (rs.goToNextRow()) { rs.getLong(rs.getColumnIndex('id')) }
rs.close() // 务必关闭，否则连接泄漏
```

要点：
- 建表用 `executeSql` + `IF NOT EXISTS`，**升级用 `version` 字段做迁移**，不要靠 try/catch 吞错。
- `ResultSet` 用完必须 `close()`；`getColumnIndex` 只在循环内调用一次成本更低。
- 大量写入用事务（`store.beginTransaction()/commit()`），否则逐条 insert 会很慢。
- 时间戳统一存 `INTEGER`（毫秒），避免字符串比较歧义。

## 网络请求（HTTP）

```ts
import { http } from '@kit.NetworkKit'
import { BusinessError } from '@kit.BasicServicesKit'

const req = http.createHttp()
try {
  const res = await req.request('https://api.example.com/tasks', {
    method: http.RequestMethod.GET,
    header: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    connectTimeout: 10000, readTimeout: 15000,
    expectDataType: http.HttpDataType.STRING
  })
  if (res.responseCode !== 200) { /* 按业务约定处理错误码 */ }
  const body = JSON.parse(res.result as string) as TaskListResp
} catch (e) {
  const err = e as BusinessError   // 禁止 catch(e: unknown) 后强转，ArkTS 会报错
  hilog.error(0x0000, 'Net', 'request failed: %{public}s', JSON.stringify(err))
} finally {
  req.destroy()                     // 不 destroy 会占着连接
}
```

- 权限：`module.json5` 里 `requestPermissions` 加 `ohos.permission.INTERNET`（`system_grant`，免弹窗）。
- 大文件上传/下载用 `@ohos.request`（上传下载任务），不要用 http 硬扛。
- 需要 WebSocket/长连接：`@ohos.net.webSocket`。

### 对接第三方 REST API 的设计检查清单

1. **写操作是否回显完整对象**？很多端点 create 只回 id、update/delete 只回 `{"status":"ok"}`。
   本地乐观更新时缺失字段（创建时间、优先级、排序位）要么自算、要么下次全量刷新前先置 pending，
   否则刷新后内容会跳变。
2. **字段是纯文本还是富文本**？若服务端存的富文本由别处生成（markdown→HTML），
   纯文本表单保存时**只提交改动过的字段**，避免「纯文本回写把富文本覆盖掉」。
3. **分页/排序在哪一端做**？服务端不支持排序时，本地排序要与服务端分页语义对齐（否则翻页顺序错乱）。
4. **失败重试与幂等**：POST 重试需服务端幂等键，否则会重复创建。

## 权限申请

1. 设计阶段先查级别（决定可行性）：
   ```bash
   python3 - <<'PY'
   import json
   p='/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json'
   d=json.load(open(p))
   for it in d['definePermissions']:
       if it['name'] in ('ohos.permission.READ_PASTEBOARD','ohos.permission.ACCESS_BIOMETRIC'):
           print(it['name'], it['grantMode'], it['availableLevel'])
   PY
   ```
   - `system_grant` + `normal`：声明即可，免弹窗（`INTERNET`、`ACCESS_BIOMETRIC`、`PRIVACY_WINDOW`）；
   - `user_grant` + `normal`：需运行时弹窗（相机、麦克风、位置、通讯录）；
   - `system_basic`/`system_core`：**普通应用申请不到**（如 `READ_PASTEBOARD`）→ 换方案，别硬写。
2. 声明：`module.json5` → `requestPermissions: [{ name, reason: '$string:xxx', usedScene: {...} }]`，
   `reason` 必须引用字符串资源（审核会查），`usedScene.abilities` 写真正用到它的 Ability。
3. 申请：`abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, ['ohos.permission.CAMERA'])`；
   **在用户触发动作时申请**（点「拍照」才申请相机），首次启动批量申请会被审核驳。
4. 每次使用前用 `checkAccessToken` 复核（用户可能已在设置里关闭）。

## 日志（HiLog）

```ts
import { hilog } from '@kit.BasicServicesKit'
const DOMAIN = 0x0001          // 自定义域，团队内约定
hilog.info(DOMAIN, 'TaskStore', 'loaded %{public}d tasks', n)
```

- 参数用 `%{public}s` / `%{public}d` 显式标注，**默认 `%s` 是 private，真机日志里会打成 `<private>`**。
- 查日志：`hdc shell hilog | grep TaskStore`（设备侧也要开日志级别，release 包默认可能不带 info）。
- 崩溃定位：`hdc shell hilog -r`（清空）→ 复现 → `hdc shell hilog | grep -i "error\|exception"`，
  或看 `hdc shell ls /data/log/faultlog/faultlogger/`。
