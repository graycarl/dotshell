// Ghostty Apple Events 桥接脚本，用法：osascript -l JavaScript ghostty.jxa.js <operation> ...
// 适用于 macOS 上的 Ghostty 1.3+。唯一会用到剪贴板的操作是 "read"。
ObjC.import('AppKit');

function fail(message) { throw new Error(message); }

function ghostty() {
  const app = Application('com.mitchellh.ghostty');
  if (!app.running()) fail('Ghostty 未在运行');
  return app;
}

function terminalById(app, id) {
  // 一律使用稳定的终端 UUID 定位，绝不用索引或当前焦点。
  const term = app.terminals().find(t => t.id() === id);
  if (!term) fail('找不到终端 ID：' + id);
  return term;
}

function windowById(app, id) {
  if (!id) {
    if (app.windows().length === 0) fail('当前没有已打开的 Ghostty 窗口');
    return app.frontWindow();
  }
  const win = app.windows().find(w => w.id() === id);
  if (!win) fail('找不到窗口 ID：' + id);
  return win;
}

function list(app) {
  return app.windows().map(w => ({
    id: w.id(), name: w.name(), selected_tab_id: w.selectedTab() && w.selectedTab().id(),
    tabs: w.tabs().map(t => ({
      id: t.id(), index: t.index(), name: t.name(), selected: t.selected(),
      focused_terminal_id: t.focusedTerminal() && t.focusedTerminal().id(),
      terminals: t.terminals().map(te => ({
        id: te.id(), name: te.name(), working_directory: te.workingDirectory()
      }))
    }))
  }));
}

function snapshotPasteboard(pb) {
  const snapshot = [];
  const items = pb.pasteboardItems;
  if (!items) return snapshot;
  let bytes = 0;
  for (let i = 0; i < Number(items.count); i++) {
    const item = items.objectAtIndex(i);
    const contents = [];
    const types = item.types;
    for (let j = 0; j < Number(types.count); j++) {
      const type = types.objectAtIndex(j);
      try {
        const data = item.dataForType(type);
        if (!data || data.isNil()) fail('无法备份剪贴板类型：' + ObjC.unwrap(type));
        bytes += Number(data.length);
        if (bytes > 32 * 1024 * 1024) fail('剪贴板内容超过 32 MiB，拒绝覆盖');
        // 让字节数据独立于剪贴板条目本身。
        contents.push({type: type, data: $.NSData.dataWithData(data)});
      } catch (e) { fail('剪贴板快照失败（类型 ' + ObjC.unwrap(type) + '）：' + String(e)); }
    }
    snapshot.push(contents);
  }
  return snapshot;
}

function restorePasteboard(pb, snapshot) {
  // 先构造好全部条目再清空，确保准备阶段失败时不会破坏剪贴板。
  const items = $.NSMutableArray.alloc.init;
  for (const contents of snapshot) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const entry of contents) {
      if (!item.setDataForType(entry.data, entry.type)) fail('无法恢复某种剪贴板类型');
    }
    items.addObject(item);
  }
  pb.clearContents; // JXA 中零参数的 ObjC 选择器是属性而非函数，不能加括号调用。
  if (snapshot.length === 0) return;
  if (!pb.writeObjects(items)) fail('无法恢复剪贴板条目');
}

function read(app, id, mode) {
  const term = terminalById(app, id); // 在碰剪贴板之前就失败
  const actions = {screen: 'write_screen_file:copy,plain', scrollback: 'write_scrollback_file:copy,plain', selection: 'write_selection_file:copy,plain'};
  if (!Object.prototype.hasOwnProperty.call(actions, mode)) fail('无效的读取模式：' + mode);
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = snapshotPasteboard(pb); // 遇到惰性/不可用数据会安全失败
  const before = Number(pb.changeCount);
  let produced = null;
  let value = null;
  let error = null;
  try {
    if (!app.performAction(actions[mode], {on: term})) fail('Ghostty 拒绝了读取动作（没有选区，或该动作不可用）');
    produced = Number(pb.changeCount);
    if (produced === before) fail('Ghostty 未把临时文件路径放到剪贴板');
    const pathObj = pb.stringForType($.NSPasteboardTypeString);
    if (!pathObj) fail('Ghostty 没有返回临时文件路径');
    const path = ObjC.unwrap(pathObj);
    const tmp = ObjC.unwrap($.NSTemporaryDirectory());
    const expected = {screen: 'screen.txt', scrollback: 'history.txt', selection: 'selection.txt'}[mode];
    // 若其他应用并发改动了剪贴板，绝不按任意路径去读。
    // macOS 常给出 /private/var/... 而标准化后是 /var/...
    const normalized = ObjC.unwrap($(path).stringByStandardizingPath);
    if (!normalized.startsWith(tmp) || !normalized.endsWith('/' + expected)) {
      fail('剪贴板中不是预期的 Ghostty 临时文件');
    }
    const manager = $.NSFileManager.defaultManager;
    let isDirectory = Ref();
    if (!manager.fileExistsAtPathIsDirectory($(normalized), isDirectory) || isDirectory[0]) fail('Ghostty 的临时文件不可用');
    const data = $.NSData.dataWithContentsOfFile($(normalized));
    if (!data) fail('无法读取 Ghostty 的临时文件');
    const decoded = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    if (!decoded) fail('Ghostty 的临时文件不是 UTF-8 编码');
    value = ObjC.unwrap(decoded);
    // Ghostty 每次读取都会新建临时文件。删掉我们消费过的那个，
    // 避免恢复剪贴板后仍把敏感滚动历史留在磁盘上。
    manager.removeItemAtPathError($(normalized), null);
  } catch (e) {
    error = e;
  } finally {
    // Ghostty 之后可能已有其他应用或用户复制了新内容，绝不覆盖它。
    if (produced !== null && Number(pb.changeCount) === produced) {
      try { restorePasteboard(pb, saved); }
      catch (e) { error = new Error('剪贴板恢复失败：' + e.message); }
    } else if (produced !== null) {
      error = new Error('剪贴板被并发改动，已保留较新的内容不动');
    } else if (Number(pb.changeCount) !== before) {
      // 动作在改动剪贴板之后抛错，不要覆盖未知的外部数据。
      error = new Error('剪贴板发生意外变化，已保留其当前内容不动');
    }
  }
  if (error) throw error;
  return value;
}

function config(app, cwd) {
  const cfg = app.newSurfaceConfiguration();
  if (cwd) cfg.initialWorkingDirectory = cwd;
  return cfg;
}

function run(argv) {
  try {
    if (!argv.length) fail('缺少操作参数');
    const app = ghostty();
    let result;
    switch (argv[0]) {
      case 'list':
        result = list(app);
        break;
      case 'read':
        result = read(app, argv[1], argv[2]);
        break;
      case 'send': {
        const term = terminalById(app, argv[1]);
        app.inputText(argv[2], {to: term});
        if (argv[3] === 'submit') app.sendKey('enter', {to: term});
        result = {terminal_id: term.id(), submitted: argv[3] === 'submit'};
        break;
      }
      case 'new-tab': {
        const win = windowById(app, argv[1]);
        const tab = app.newTab({in: win, withConfiguration: config(app, argv[2])});
        result = {window_id: win.id(), tab_id: tab.id(), terminal_id: tab.focusedTerminal().id()};
        break;
      }
      case 'split': {
        const term = terminalById(app, argv[1]);
        const direction = argv[2];
        if (!['right', 'left', 'up', 'down'].includes(direction)) fail('无效的拆分方向');
        const newTerm = app.split(term, {direction: direction, withConfiguration: config(app, argv[3])});
        result = {terminal_id: newTerm.id(), working_directory: newTerm.workingDirectory()};
        break;
      }
      case 'focus': {
        const term = terminalById(app, argv[1]);
        app.focus(term);
        result = {terminal_id: term.id()};
        break;
      }
      default: fail('未知操作：' + argv[0]);
    }
    return JSON.stringify({ok: true, data: result});
  } catch (e) {
    return JSON.stringify({ok: false, error: String(e.message || e)});
  }
}
