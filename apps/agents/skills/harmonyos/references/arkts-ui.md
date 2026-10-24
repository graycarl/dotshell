# ArkTS 语言 + ArkUI 声明式 UI + 状态管理 + 导航

写页面、写组件、管状态、跳页面时读这篇。这里只讲**推荐写法**；具体报错的排查见 `pitfalls.md`，
API 事实以 SDK d.ts 为准（见 `resources.md`「如何取正文」）。

## ArkTS 严格模式：比 TypeScript 严得多

ArkTS 是 TS 的**受限子集**，很多 TS 习惯写法直接编译不过。写代码时先按这几条自检：

| 禁止 | 替代写法 |
|---|---|
| `as const` | 用枚举 / 显式类型常量 |
| `catch (e: unknown)` 后随意转换 | `catch (e) { const err = e as BusinessError }`，`import { BusinessError } from '@kit.BasicServicesKit'` |
| `interface` 对象 `obj['key']` 索引访问 | 先 `const m = obj as Record<string, Object>` 再取 |
| 构造参数属性 `constructor(private x: number)` | 显式字段 + 构造函数体内赋值 |
| 无类型的对象字面量 | 必须有显式 interface/class 对应：`const o: Foo = { ... }` |
| 字符串直接传枚举参数 | `http.RequestMethod.GET`（用枚举成员） |
| `any` / `unknown` 滥用 | 用具体类型或 `Object`，必要时 `Record` |

其它注意事项：
- **`buffer.from(str, 'utf-8')` 返回 `Buffer`，不能直接当 `Uint8Array` 用**（本地 mock 下 `byteOffset`
  是伪造值）→ `new Uint8Array(buffer.from(s, 'utf-8').buffer)`。
- 装饰器只在 `@Component`/`@ComponentV2` 结构内生效；`@Entry` 只在页面级组件上。
- 全局声明（`NavPathStack`、`Navigation`、`TextInput` 相关枚举等）**不需要 import**；
  不确定某类型/枚举在哪：grep `$SDK/ets/component/*.d.ts`（组件声明）与 `ets/kits/@kit.*.d.ts`（导出清单）。

## 声明式 UI 基本范式

```ts
@ComponentV2
struct TaskRow {
  @Param task: Task            // 外部传入（V2）
  @Event onToggle: () => void  // 回调（V2）

  build() {
    Row() {
      Text(this.task.title).fontSize(16)
      Blank()
      Toggle({ type: ToggleType.Checkbox, isOn: this.task.done })
        .onChange(() => this.onToggle())
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
  }
}
```

- 复用 UI 片段：`@Builder` 方法 / `@BuilderParam` 传槽位；**`@Builder` 只声明参数，不要在里面持有状态**。
- 生命周期：`aboutToAppear`（数据加载）→ `onPageShow`（页面可见刷新）→ `aboutToDisappear`（释放资源）。
- 布局优先用 `Row/Column/Flex/Stack` + `layoutWeight`，少写死宽高；滚动内容用 `List`（长列表，
  配 `LazyForEach`）或 `Scroll`（短内容）。
- 长列表**不要用零高度占位项实现折叠**：折叠应通过重建可见数据源 + `onDataReloaded()` 实现。
- 常见交互组件：长按菜单 `bindContextMenu(..., ResponseType.LongPress)`、半模态表单 `bindSheet`。
  注意 `MenuItemOptions.content` 只接受 `ResourceStr`（不能传 CustomBuilder），长按菜单里做红字删除项
  要换自定义 `Menu` 布局。

## 状态管理：优先 V2

| 场景 | 用什么 |
|---|---|
| 组件内可变值 | `@Local`（V2）/ `@State`（V1） |
| 父 → 子单向传参 | `@Param`（V2）/ `@Prop`（V1） |
| 子 → 父回调 | `@Event`（V2）/ 函数属性（V1） |
| 可观察对象（深层字段变更） | `@ObservedV2` + `@Trace` |
| 跨页面共享状态 | `AppStorageV2.connect(Store, () => new Store())!` 单例 |
| 全局配置/少量 KV | `AppStorage` / `PersistentStorage` |

规则：
- **页面间共享状态走单例（AppStorageV2 / 普通单例），不要靠路由 param 传大对象**（param 会被序列化语义约束，
  且返回时无法回写）。
- 共享状态若是**普通类单例**（不是 `@ObservedV2`），在单例上提供 `addListener/removeListener`，
  页面用 `@Local version: number` 自增触发重渲。
- 一次只用一个范式：V1（`@State/@Prop/@Link`）与 V2（`@Local/@Param/@Event/@Monitor`）**不要混用**。
- `@ComponentV2` 可以作 NavDestination 宿主（官方案例多为 V1，但行为一致）。

## 路由与导航：Navigation + NavDestination

**页面跳转首选 `Navigation` + `NavPathStack`**（`router` 已是旧方案）。约定「路由栈即历史栈」：
进详情页 = `pushPath`，系统返回 = `pop`，兄弟页切换 = `replacePath`，回首页 = `clear`/`popToIndex`。

关键写法（踩过坑的部分，务必照抄结构）：

```ts
@Entry
@ComponentV2
struct Index {
  @Local pathStack: NavPathStack = new NavPathStack()
  @Builder PageMap(name: string) {          // ① 路由表必须是组件内 @Builder 方法
    if (name === 'detail') { DetailPage() } // ② param 由子页自己从 pathStack 取，别透传
  }

  build() {
    Navigation(this.pathStack) {
      HomePage()
    }
    .navDestination(this.PageMap)           // ③ 绑定组件内方法，不是 top-level 函数
    .mode(NavigationMode.Stack)             // ④ 单栏应用显式指定
    .hideTitleBar(true).hideToolBar(true)   // ⑤ 不配置也会占位 ~112vp
    .ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.BOTTOM]) // ⑥ 内容延伸到屏幕底（API 20+）
  }
}
```

- `@Builder` 路由表**只声明 `name` 参数**；`pushPath({ name })` 不传 param 时 param 是 `undefined`，
  把它透传给子组件的 `@Param param: object` 会类型不匹配 → 子页构建异常，表现是**页面空白**。
- 子页 `NavDestination` 自己从 `pathStack.getParamByName()` 取值，并对 undefined 兜底。
- `Navigation` 内容区布局在**安全区内**（避让状态栏/手势条）；`expandSafeArea` 只扩展绘制区域，
  想要滚动内容真正延伸到屏幕底，用 `ignoreLayoutSafeArea`，且前提是标题栏/工具栏已隐藏。
- 排查「页面空白」优先级：路由表形式 → param 透传 → `NavDestination` 是否包在子页组件内。

## 资源名与图标

- `$r('sys.color.xxx')` / `$r('sys.media.xxx')` 的合法名字**只有** `$SDK/toolchains/id_defined.json`
  里存在的那些（`ohos_ic_public_settings` 这类「看起来通用」的名字可能是 private，编译报
  `Unknown resource name`）。不确定就 grep：
  ```bash
  grep -o '"ohos_ic_public[a-z_]*"' $SDK/toolchains/id_defined.json | sort -u
  grep -o '"ohos_id_color[a-z_]*"'  $SDK/toolchains/id_defined.json | sort -u
  ```
- 文本颜色常用：`sys.color.primary` / `sys.color.secondary` / `sys.color.alert_transparent`
  （并不存在 `ohos_id_color_secondary_text` 之类的写法）。
- 应用图标：分层资源 `background` + `foreground` 均 **1024×1024 正方形 PNG**，不做圆角（系统裁切）；
  背景层不允许透明像素；前景主体居中、勿近四角。改图标要同时替换
  `AppScope/resources/base/media/*`、`entry/src/main/resources/base/media/*`（entry 覆盖 AppScope）
  和 `startIcon.png`。
- 字符串/颜色/尺寸都写进 `resources/base/element/*.json`，深色模式在 `resources/dark/element/`；
  不要硬编码 `'#FF0000'`（多主题时会漏改）。
