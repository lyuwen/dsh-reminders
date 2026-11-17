window.__ModuleLoader__.load({
  id: 'dsh-reminders-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    const NS = 'reminders';
    const PANEL_ID = 'reminders';
    const TOAST_ID = 'reminders-dream';
    const POLL_MS = 2500;
    /** Auto-dismiss countdown for a finished dreaming popup, paused while hovered. */
    const TOAST_LIFETIME_MS = 12000;
    const TOAST_FADE_MS = 320;
    const API_ROOT = 'api/dsh-reminders/';
    /** Timestamp of the last dreaming summary the user has actually seen. */
    const SEEN_KEY = 'dshr:lastSeenAt';
    const STATUSES = ['todo', 'doing', 'blocked', 'done'];
    const FRESHNESS = ['fresh', 'warm', 'stale', 'cold'];
    const CHANGE_KINDS = ['created', 'updated', 'attention', 'grouped'];
    const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5];
    const INTERVALS = [1, 5, 10, 15, 30, 60];
    const MAX_TITLE_LENGTH = 200;

    // -------------------------------------------------------------------
    // Locale dictionaries (flat dotted keys; en and zh keep an equal key set)
    // -------------------------------------------------------------------
    const DICT_EN = {
      'panel': 'Reminders',
      'loading': 'Loading reminders…',
      'unavailable.title': 'Reminders host unavailable',
      'unavailable.body': 'The plugin host did not answer. Make sure the reminders bundle is enabled, then retry.',
      'stale.body': 'The host did not answer. Showing the last saved list: {message}',
      'panel.noticeDismiss': 'Dismiss notice',
      'error.unknown': 'Unknown error',
      'error.session': 'Could not open the session: {message}',
      'action.retry': 'Retry',
      'action.cancel': 'Cancel',
      'action.new': 'New reminder',
      'action.dreamNow': 'Dream now',
      'dream.toggle': 'Dreaming',
      'dream.interval': 'Dream interval',
      'dream.statusOn': 'Dreaming on · every {interval} min · last run {last}',
      'dream.statusOff': 'Dreaming off · every {interval} min',
      'dream.statusRunning': 'Dreaming on · every {interval} min · running now',
      'dream.running': 'Dreaming…',
      'dream.toggleFailed': 'Could not change dreaming: {message}',
      'dream.intervalFailed': 'Could not change the interval: {message}',
      'dream.runFailed': 'Could not start dreaming: {message}',
      'search.placeholder': 'Search reminders',
      'search.label': 'Search reminders',
      'filter.all': 'All',
      'filter.statusLabel': 'Filter by status',
      'status.todo': 'To do',
      'status.doing': 'Doing',
      'status.blocked': 'Blocked',
      'status.done': 'Done',
      'freshness.fresh': 'Fresh',
      'freshness.warm': 'Warm',
      'freshness.stale': 'Stale',
      'freshness.cold': 'Cold',
      'source.manual': 'Manual',
      'source.dream': 'Dreamed',
      'group.count': '{n}',
      'group.general': 'General',
      'group.untitled': 'Untitled group',
      'group.unknown': 'Unknown group',
      'group.rename': 'Rename group',
      'group.delete': 'Delete group',
      'group.deleteConfirm': 'Delete group',
      'group.deleteHint': 'Its reminders move to General.',
      'group.renameRequired': 'Enter a group name.',
      'group.save': 'Save',
      'group.failed': 'Could not update the group: {message}',
      'row.progress': '{n}%',
      'row.importance': 'Importance {n}',
      'row.sessions': 'Linked sessions',
      'row.open': 'Open reminder: {title}',
      'empty.title': 'No reminders yet',
      'empty.body': 'Create one manually, or turn on dreaming to build the list from your recently used sessions.',
      'empty.action': 'New reminder',
      'empty.filteredTitle': 'No reminders match',
      'empty.filteredBody': 'Try another search or status filter.',
      'empty.clearFilters': 'Clear filters',
      'editor.newTitle': 'New reminder',
      'editor.editTitle': 'Edit reminder',
      'editor.close': 'Close editor',
      'editor.meta': '{source} · {freshness} · updated {time}',
      'editor.title': 'Title',
      'editor.titlePlaceholder': 'What are you working on?',
      'editor.titleRequired': 'Enter a title.',
      'editor.titleTooLong': 'Keep the title to 200 characters or fewer.',
      'editor.status': 'Status',
      'editor.progress': 'Progress',
      'editor.importance': 'Importance',
      'editor.importanceValue': 'Set importance to {n}',
      'editor.group': 'Group',
      'editor.nextStep': 'Next step',
      'editor.nextStepPlaceholder': 'The next concrete action',
      'editor.notes': 'Notes',
      'editor.notesPlaceholder': 'Anything worth remembering',
      'editor.sessions': 'Linked sessions',
      'editor.sessionsEmpty': 'No linked sessions',
      'editor.pinned': 'Pinned',
      'editor.newGroup': 'New group…',
      'editor.newGroupPlaceholder': 'Group name',
      'editor.createGroup': 'Create group',
      'editor.groupFailed': 'Could not create the group: {message}',
      'editor.save': 'Save',
      'editor.saving': 'Saving…',
      'editor.saveFailed': 'Could not save: {message}',
      'editor.delete': 'Delete',
      'editor.deleteConfirm': 'Confirm delete',
      'editor.deleteHint': 'This cannot be undone.',
      'editor.deleteFailed': 'Could not delete: {message}',
      'toast.running': 'Dreaming…',
      'toast.runningScanned': 'Scanned {n} sessions',
      'toast.runningHint': 'Looking through your recent sessions.',
      'toast.doneTitle': 'Dreaming finished',
      'toast.nothingTitle': 'Dreaming found nothing',
      'toast.summary': 'Scanned {scanned} sessions · {created} new · {updated} updated · {attention} needing attention',
      'toast.whileAway': 'While you were away',
      'toast.aggregateBody': '{runs} dreaming passes while this page was unfocused · {created} new · {updated} updated · {attention} needing attention',
      'toast.changes': 'Proposed changes',
      'toast.change.created': 'New',
      'toast.change.updated': 'Updated',
      'toast.change.attention': 'Attention',
      'toast.change.grouped': 'Grouped',
      'toast.unknownItem': 'Untitled reminder',
      'toast.edit': 'Edit',
      'toast.delete': 'Delete',
      'toast.deleteFailed': 'Could not delete: {message}',
      'toast.undo': 'Undo',
      'toast.undoFailed': 'Could not undo: {message}',
      'toast.openList': 'Open list',
      'toast.dismiss': 'Dismiss',
      'toast.errorTitle': 'Dreaming failed',
      'toast.errorFallback': 'The dreaming run failed.',
      'toast.retry': 'Retry',
      'toast.retrying': 'Starting…',
      'toast.actionFailed': 'That did not work: {message}',
      'toast.notification': 'Dreaming notification',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n}m ago',
      'time.hoursAgo': '{n}h ago',
      'time.daysAgo': '{n}d ago',
      'time.never': 'never',
      'time.minutes': '{n} min',
    };

    const DICT_ZH = {
      'panel': '提醒',
      'loading': '正在加载提醒…',
      'unavailable.title': '提醒服务不可用',
      'unavailable.body': '插件的宿主没有响应。请确认提醒插件已启用，然后重试。',
      'stale.body': '宿主没有响应，正在显示上次保存的列表：{message}',
      'panel.noticeDismiss': '关闭提示',
      'error.unknown': '未知错误',
      'error.session': '无法打开会话：{message}',
      'action.retry': '重试',
      'action.cancel': '取消',
      'action.new': '新建提醒',
      'action.dreamNow': '立即扫描',
      'dream.toggle': '梦境模式',
      'dream.interval': '扫描间隔',
      'dream.statusOn': '梦境模式开启 · 每 {interval} 分钟 · 上次运行 {last}',
      'dream.statusOff': '梦境模式关闭 · 每 {interval} 分钟',
      'dream.statusRunning': '梦境模式开启 · 每 {interval} 分钟 · 正在运行',
      'dream.running': '正在扫描…',
      'dream.toggleFailed': '无法切换梦境模式：{message}',
      'dream.intervalFailed': '无法修改扫描间隔：{message}',
      'dream.runFailed': '无法启动扫描：{message}',
      'search.placeholder': '搜索提醒',
      'search.label': '搜索提醒',
      'filter.all': '全部',
      'filter.statusLabel': '按状态筛选',
      'status.todo': '待办',
      'status.doing': '进行中',
      'status.blocked': '受阻',
      'status.done': '已完成',
      'freshness.fresh': '新近',
      'freshness.warm': '近期',
      'freshness.stale': '较久',
      'freshness.cold': '很久',
      'source.manual': '手动',
      'source.dream': '梦境',
      'group.count': '{n}',
      'group.general': '常规',
      'group.untitled': '未命名分组',
      'group.unknown': '未知分组',
      'group.rename': '重命名分组',
      'group.delete': '删除分组',
      'group.deleteConfirm': '删除分组',
      'group.deleteHint': '分组内的提醒会移到「常规」。',
      'group.renameRequired': '请输入分组名称。',
      'group.save': '保存',
      'group.failed': '无法更新分组：{message}',
      'row.progress': '{n}%',
      'row.importance': '重要度 {n}',
      'row.sessions': '关联会话',
      'row.open': '打开提醒：{title}',
      'empty.title': '还没有提醒',
      'empty.body': '可以手动新建，或开启梦境模式从最近使用的会话中生成。',
      'empty.action': '新建提醒',
      'empty.filteredTitle': '没有匹配的提醒',
      'empty.filteredBody': '换一个搜索词或状态筛选试试。',
      'empty.clearFilters': '清除筛选',
      'editor.newTitle': '新建提醒',
      'editor.editTitle': '编辑提醒',
      'editor.close': '关闭编辑',
      'editor.meta': '{source} · {freshness} · 更新于 {time}',
      'editor.title': '标题',
      'editor.titlePlaceholder': '你在做什么？',
      'editor.titleRequired': '请填写标题。',
      'editor.titleTooLong': '标题请控制在 200 个字符以内。',
      'editor.status': '状态',
      'editor.progress': '进度',
      'editor.importance': '重要度',
      'editor.importanceValue': '设为 {n} 星',
      'editor.group': '分组',
      'editor.nextStep': '下一步',
      'editor.nextStepPlaceholder': '下一个具体动作',
      'editor.notes': '备注',
      'editor.notesPlaceholder': '任何值得记住的内容',
      'editor.sessions': '关联会话',
      'editor.sessionsEmpty': '没有关联会话',
      'editor.pinned': '置顶',
      'editor.newGroup': '新建分组…',
      'editor.newGroupPlaceholder': '分组名称',
      'editor.createGroup': '创建分组',
      'editor.groupFailed': '无法创建分组：{message}',
      'editor.save': '保存',
      'editor.saving': '保存中…',
      'editor.saveFailed': '保存失败：{message}',
      'editor.delete': '删除',
      'editor.deleteConfirm': '确认删除',
      'editor.deleteHint': '删除后无法恢复。',
      'editor.deleteFailed': '删除失败：{message}',
      'toast.running': '正在扫描…',
      'toast.runningScanned': '已扫描 {n} 个会话',
      'toast.runningHint': '正在查看你最近使用的会话。',
      'toast.doneTitle': '扫描完成',
      'toast.nothingTitle': '没有找到需要记录的内容',
      'toast.summary': '扫描 {scanned} 个会话 · 新增 {created} 项 · 更新 {updated} 项 · {attention} 项需要注意',
      'toast.whileAway': '你离开期间',
      'toast.aggregateBody': '此页面未聚焦期间完成了 {runs} 次 dreaming · 新增 {created} 项 · 更新 {updated} 项 · {attention} 项需要注意',
      'toast.changes': '建议的变更',
      'toast.change.created': '新增',
      'toast.change.updated': '更新',
      'toast.change.attention': '注意',
      'toast.change.grouped': '归组',
      'toast.unknownItem': '未命名提醒',
      'toast.edit': '编辑',
      'toast.delete': '删除',
      'toast.deleteFailed': '无法删除：{message}',
      'toast.undo': '撤销',
      'toast.undoFailed': '无法撤销：{message}',
      'toast.openList': '打开列表',
      'toast.dismiss': '关闭',
      'toast.errorTitle': '扫描失败',
      'toast.errorFallback': '本次扫描失败了。',
      'toast.retry': '重试',
      'toast.retrying': '正在启动…',
      'toast.actionFailed': '操作未完成：{message}',
      'toast.notification': '梦境通知',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'time.never': '从未',
      'time.minutes': '{n} 分钟',
    };

    // -------------------------------------------------------------------
    // Small utilities
    // -------------------------------------------------------------------
    function str(value) {
      return typeof value === 'string' ? value : '';
    }

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function num(value, fallback) {
      return typeof value === 'number' && isFinite(value) ? value : fallback;
    }

    function clampInt(value, min, max, fallback) {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!isFinite(parsed)) return fallback;
      const rounded = Math.round(parsed);
      if (rounded < min) return min;
      if (rounded > max) return max;
      return rounded;
    }

    function messageOf(error) {
      if (!error) return '';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message) return error.message;
      return '';
    }

    function fallbackT(key) {
      return str(key);
    }

    function translatorOf(props) {
      return props && typeof props.t === 'function' ? props.t : fallbackT;
    }

    function statusOf(item) {
      const value = item && item.status;
      return STATUSES.indexOf(value) >= 0 ? value : 'todo';
    }

    function freshnessOf(item) {
      const value = item && item.freshness;
      return FRESHNESS.indexOf(value) >= 0 ? value : 'cold';
    }

    function sourceKeyOf(item) {
      return item && item.source === 'dream' ? 'source.dream' : 'source.manual';
    }

    function kindLabel(t, kind) {
      return CHANGE_KINDS.indexOf(kind) >= 0 ? t('toast.change.' + kind) : str(kind);
    }

    function normalizeSessions(item) {
      const result = [];
      const seen = [];
      if (!isObject(item)) return result;
      if (Array.isArray(item.sessions)) {
        for (const session of item.sessions) {
          if (!isObject(session)) continue;
          const id = str(session.id) || str(session.sessionId);
          if (!id || seen.indexOf(id) >= 0) continue;
          seen.push(id);
          result.push({ id: id, title: str(session.title) || id, lastTouched: num(session.lastTouched, 0) });
        }
      }
      if (Array.isArray(item.sessionIds)) {
        for (const raw of item.sessionIds) {
          const id = typeof raw === 'string' ? raw : (isObject(raw) ? str(raw.id) : '');
          if (!id || seen.indexOf(id) >= 0) continue;
          seen.push(id);
          result.push({ id: id, title: id, lastTouched: 0 });
        }
      }
      return result;
    }

    function sortItems(list) {
      return list.slice().sort(function compareItems(left, right) {
        const leftPinned = left && left.pinned === true ? 1 : 0;
        const rightPinned = right && right.pinned === true ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        const leftImportance = num(left && left.importance, 0);
        const rightImportance = num(right && right.importance, 0);
        if (leftImportance !== rightImportance) return rightImportance - leftImportance;
        return num(right && right.lastTouched, 0) - num(left && left.lastTouched, 0);
      });
    }

    function filterItems(items, groups, search, statusFilter) {
      const groupNames = new Map();
      for (const group of groups) {
        if (isObject(group) && typeof group.id === 'string' && group.id) groupNames.set(group.id, str(group.name));
      }
      const query = str(search).trim().toLowerCase();
      return items.filter(function matches(item) {
        if (!isObject(item)) return false;
        if (statusFilter !== 'all' && statusOf(item) !== statusFilter) return false;
        if (!query) return true;
        const parts = [
          str(item.title),
          str(item.nextStep),
          str(item.notes),
          groupNames.get(str(item.groupId)) || '',
        ];
        for (const session of normalizeSessions(item)) parts.push(session.title);
        return parts.join('\n').toLowerCase().indexOf(query) >= 0;
      });
    }

    function buildSections(list, groups) {
      const known = new Map();
      const order = [];
      for (const group of groups) {
        if (!isObject(group) || typeof group.id !== 'string' || !group.id) continue;
        if (known.has(group.id)) continue;
        known.set(group.id, str(group.name));
        order.push({ id: group.id, name: str(group.name) });
      }
      const buckets = new Map();
      const extra = [];
      for (const item of list) {
        if (!isObject(item)) continue;
        const groupId = typeof item.groupId === 'string' ? item.groupId : '';
        if (groupId && known.has(groupId)) {
          if (!buckets.has(groupId)) buckets.set(groupId, []);
          buckets.get(groupId).push(item);
        } else {
          extra.push(item);
        }
      }
      const sections = [];
      for (const group of order) {
        const groupItems = buckets.get(group.id);
        if (!groupItems || groupItems.length === 0) continue;
        sections.push({ key: 'g:' + group.id, id: group.id, name: group.name, items: sortItems(groupItems), editable: true });
      }
      if (extra.length > 0) {
        sections.push({ key: 'g:__ungrouped', id: '', name: '', items: sortItems(extra), editable: false });
      }
      return sections;
    }

    function formatRelative(at, t) {
      const timestamp = num(at, 0);
      if (timestamp <= 0) return t('time.never');
      const diff = Math.max(0, Date.now() - timestamp);
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return t('time.justNow');
      if (minutes < 60) return t('time.minutesAgo', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('time.hoursAgo', { n: hours });
      return t('time.daysAgo', { n: Math.floor(hours / 24) });
    }

    // -------------------------------------------------------------------
    // HTTP helpers
    // -------------------------------------------------------------------
    function endpoint(path) {
      try {
        const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://localhost/';
        return new URL(API_ROOT + path, base).href;
      } catch (_error) {
        return API_ROOT + path;
      }
    }

    async function fetchState() {
      const response = await fetch(endpoint('state'), {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response || response.ok !== true) {
        throw new Error('HTTP ' + (response ? response.status : 'request failed'));
      }
      const body = await response.json();
      if (!isObject(body) || body.ok !== true) {
        throw new Error('The host returned an invalid state payload.');
      }
      return body;
    }

    async function postAction(action, payload) {
      const response = await fetch(endpoint('action'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: action, payload: payload || {} }),
      });
      if (!response || response.ok !== true) {
        throw new Error('HTTP ' + (response ? response.status : 'request failed'));
      }
      let body = null;
      try {
        body = await response.json();
      } catch (_error) {
        throw new Error('The host returned an invalid response.');
      }
      if (!isObject(body) || body.ok !== true) {
        const detail = isObject(body) && isObject(body.error) ? body.error : null;
        const message = detail && str(detail.message) ? str(detail.message) : (detail && str(detail.code) ? str(detail.code) : 'Request failed');
        const error = new Error(message);
        error.code = detail && str(detail.code) ? str(detail.code) : 'unknown';
        throw error;
      }
      return body.value;
    }

    // -------------------------------------------------------------------
    // Module-level polling store (shared by the page and the overlay toast)
    // -------------------------------------------------------------------
    const idleSnapshot = { status: 'idle', data: null, error: null };
    let storeSnapshot = idleSnapshot;
    let storeSignature = 'idle||';
    const storeListeners = new Set();
    let pollHandle = null;
    let requestInFlight = null;

    function signatureOf(snapshot) {
      const status = str(snapshot.status);
      const error = str(snapshot.error);
      if (!snapshot.data) return status + '|' + error + '|';
      let payload = '';
      try {
        const data = snapshot.data;
        payload = JSON.stringify({
          revision: data.revision,
          settings: data.settings,
          groups: data.groups,
          items: data.items,
          dream: data.dream,
        });
      } catch (_error) {
        payload = 'unserializable:' + Date.now();
      }
      return status + '|' + error + '|' + payload;
    }

    function commitSnapshot(next, force) {
      let signature = '';
      try {
        signature = signatureOf(next);
      } catch (_error) {
        signature = 'unserializable:' + Date.now();
      }
      if (!force && signature === storeSignature) return;
      storeSignature = signature;
      storeSnapshot = next;
      for (const listener of Array.from(storeListeners)) {
        try {
          listener();
        } catch (error) {
          console.error('dsh-reminders: store listener crashed', error);
        }
      }
    }

    function getSnapshot() {
      return storeSnapshot;
    }

    function subscribeStore(listener) {
      storeListeners.add(listener);
      if (storeListeners.size === 1) startPolling();
      return function unsubscribe() {
        storeListeners.delete(listener);
        if (storeListeners.size === 0) stopPolling();
      };
    }

    function startPolling() {
      if (pollHandle !== null) return;
      if (typeof setInterval !== 'function') return;
      pollHandle = setInterval(function pollTick() {
        loadState(false);
      }, POLL_MS);
      loadState(false);
    }

    function stopPolling() {
      if (pollHandle === null) return;
      clearInterval(pollHandle);
      pollHandle = null;
    }

    function loadState(force) {
      if (requestInFlight !== null) return requestInFlight;
      if (typeof fetch !== 'function') {
        commitSnapshot({ status: storeSnapshot.data ? 'ready' : 'error', data: storeSnapshot.data, error: 'fetch is unavailable in this browser' }, true);
        return Promise.resolve(null);
      }
      requestInFlight = (async function run() {
        try {
          const data = await fetchState();
          commitSnapshot({ status: 'ready', data: data, error: null }, force === true);
          return data;
        } catch (error) {
          const message = messageOf(error) || 'Request failed';
          commitSnapshot({
            status: storeSnapshot.data ? 'ready' : 'error',
            data: storeSnapshot.data,
            error: message,
          }, force === true);
          return null;
        } finally {
          requestInFlight = null;
        }
      })();
      return requestInFlight;
    }

    function refresh() {
      if (requestInFlight !== null) {
        return requestInFlight.then(function afterPending() {
          return loadState(true);
        }, function afterPendingFailure() {
          return loadState(true);
        });
      }
      return loadState(true);
    }

    // -------------------------------------------------------------------
    // Edit-request bridge from the dreaming toast to the panel page
    // -------------------------------------------------------------------
    let editState = { token: 0, itemId: '' };
    let consumedEditToken = 0;
    const editListeners = new Set();

    function getEditState() {
      return editState;
    }

    function subscribeEdit(listener) {
      editListeners.add(listener);
      return function unsubscribe() {
        editListeners.delete(listener);
      };
    }

    function requestEdit(itemId) {
      const id = str(itemId);
      if (!id) return;
      editState = { token: editState.token + 1, itemId: id };
      for (const listener of Array.from(editListeners)) {
        try {
          listener();
        } catch (error) {
          console.error('dsh-reminders: edit listener crashed', error);
        }
      }
    }

    // -------------------------------------------------------------------
    // Host bridge filled in by apply()
    // -------------------------------------------------------------------
    let hostBridge = {
      selectPanel: function noopSelectPanel() {},
      openSession: function noopOpenSession() {},
    };

    function selectPanelSafely() {
      try {
        hostBridge.selectPanel();
      } catch (error) {
        console.error('dsh-reminders: could not select the reminders panel', error);
      }
    }

    function openSessionSafely(sessionId) {
      const id = str(sessionId);
      if (!id) return;
      try {
        hostBridge.openSession(id);
      } catch (error) {
        console.error('dsh-reminders: could not open the session', error);
      }
    }

    // -------------------------------------------------------------------
    // Seen watermark + long-absence aggregation
    // -------------------------------------------------------------------
    function readSeenAt() {
      try {
        if (typeof localStorage === 'undefined') return 0;
        const value = num(localStorage.getItem(SEEN_KEY), 0);
        return value > 0 ? value : 0;
      } catch (_error) {
        return 0;
      }
    }

    function writeSeenAt(at) {
      const value = Math.floor(num(at, 0));
      if (!(value > 0)) return;
      try {
        if (typeof localStorage === 'undefined') return;
        const previous = readSeenAt();
        if (value > previous) localStorage.setItem(SEEN_KEY, String(value));
      } catch (_error) {
        // Private-mode storage failures must not break the popup.
      }
    }

    /**
     * Collapse every dreaming result the user has not seen into one feed:
     * the live running pass, a single settled pass, or an aggregate of all
     * passes that completed while the page was unfocused. This is what keeps a
     * long absence from stacking notifications.
     * @param {object|null} data - Host state payload.
     * @param {number} seenAt - last seen-through timestamp.
     * @returns {{running: object|null, activity: object|null}}
     */
    function unseenFeed(data, seenAt, suppressedRunningId) {
      const dream = data && isObject(data.dream) ? data.dream : null;
      const running = dream && isObject(dream.activity) && str(dream.activity.status) === 'running'
        ? dream.activity
        : null;
      if (running && str(running.id) !== str(suppressedRunningId)) return { running: running, activity: null };
      const candidates = [];
      const rollup = dream && isObject(dream.rollup) ? dream.rollup : null;
      if (rollup && num(rollup.endedAt, 0) > seenAt) {
        candidates.push({ record: rollup, runs: Math.max(1, num(rollup.runs, 1)) });
      }
      const activities = data && Array.isArray(data.activities) ? data.activities.filter(isObject) : [];
      for (const activity of activities) {
        if (activity.undone === true) continue;
        if (str(activity.status) === 'running') continue;
        const endedAt = num(activity.endedAt, num(activity.startedAt, 0));
        if (endedAt > seenAt) candidates.push({ record: activity, runs: 1 });
      }
      if (candidates.length === 0) return { running: null, activity: null };
      candidates.sort(function oldestFirst(left, right) {
        return num(left.record.endedAt, num(left.record.startedAt, 0)) - num(right.record.endedAt, num(right.record.startedAt, 0));
      });
      const runs = candidates.reduce(function sum(total, entry) {
        return total + entry.runs;
      }, 0);
      const last = candidates[candidates.length - 1].record;
      if (runs <= 1 && candidates.length === 1) {
        return { running: null, activity: last };
      }
      let created = 0;
      let updated = 0;
      let attention = 0;
      let startedAt = Number.MAX_SAFE_INTEGER;
      let endedAt = 0;
      const changesByItem = new Map();
      const looseChanges = [];
      const attentionItems = new Set();
      for (const entry of candidates) {
        const record = entry.record;
        created += num(record.created, 0);
        updated += num(record.updated, 0);
        attention += num(record.attention, 0);
        startedAt = Math.min(startedAt, num(record.startedAt, 0) || Number.MAX_SAFE_INTEGER);
        endedAt = Math.max(endedAt, num(record.endedAt, num(record.startedAt, 0)));
        const changes = Array.isArray(record.changes) ? record.changes.filter(isObject) : [];
        for (const change of changes) {
          const itemId = str(change.itemId);
          if (str(change.kind) === 'attention' && itemId) attentionItems.add(itemId);
          if (itemId) changesByItem.set(itemId, change);
          else looseChanges.push(change);
        }
      }
      // A forgotten item is re-flagged on every pass, so "needing attention"
      // counts distinct items, never one increment per dreaming run.
      if (attentionItems.size > 0) attention = attentionItems.size;
      if (!(startedAt < Number.MAX_SAFE_INTEGER)) startedAt = endedAt;
      return {
        running: null,
        activity: {
          id: 'agg:' + endedAt,
          status: 'done',
          aggregated: true,
          startedAt: startedAt,
          endedAt: endedAt,
          scanned: 0,
          created: created,
          updated: updated,
          attention: attention,
          runs: runs,
          changes: Array.from(changesByItem.values()).concat(looseChanges).slice(-60),
          undoable: false,
          seenThrough: endedAt,
        },
      };
    }

    // -------------------------------------------------------------------
    // Components
    // -------------------------------------------------------------------

    function useNowTick() {
      const [, setTick] = React.useState(0);
      React.useEffect(function subscribeTick() {
        if (typeof setInterval !== 'function') return undefined;
        const handle = setInterval(function tick() {
          setTick(function bump(value) {
            return value + 1;
          });
        }, 30000);
        return function stopTick() {
          clearInterval(handle);
        };
      }, []);
    }

    function RemindersIcon({ size }) {
      const edge = num(size, 18) > 0 ? num(size, 18) : 18;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: edge,
        height: edge,
        'aria-hidden': true,
        focusable: 'false',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { display: 'block', flex: 'none' },
      },
        h('rect', { x: 4.25, y: 3.25, width: 13.5, height: 17.5, rx: 3 }),
        h('path', { d: 'M7.6 8.4l1.1 1.1 2.1-2.1' }),
        h('path', { d: 'M7.6 13.1l1.1 1.1 2.1-2.1' }),
        h('path', { d: 'M13.2 8.4h1.9M13.2 13.1h1.9' }),
        h('path', {
          d: 'M18.2 15.4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z',
          fill: 'currentColor',
          stroke: 'none',
        })
      );
    }

    function GroupSection(props) {
      const section = isObject(props.section) ? props.section : { id: '', name: '', items: [], editable: false };
      const t = translatorOf(props);
      const onError = typeof props.onError === 'function' ? props.onError : function noopError() {};
      const [renaming, setRenaming] = React.useState(false);
      const [name, setName] = React.useState(str(section.name));
      const [confirming, setConfirming] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      React.useEffect(function syncName() {
        if (!renaming) setName(str(section.name));
      }, [section.name, renaming]);
      const canEdit = section.editable === true && str(section.id) !== '';
      const itemCount = Array.isArray(section.items) ? section.items.length : 0;
      const displayName = str(section.name) || (canEdit ? t('group.untitled') : t('group.general'));

      const startRename = function startRename() {
        setConfirming(false);
        setName(str(section.name));
        setRenaming(true);
      };

      const cancelRename = function cancelRename() {
        setName(str(section.name));
        setRenaming(false);
      };

      const submitRename = async function submitRename() {
        if (busy) return;
        const next = name.trim();
        if (!next) {
          onError(t('group.renameRequired'));
          return;
        }
        setBusy(true);
        try {
          await postAction('group.rename', { id: section.id, name: next });
          await refresh();
          setRenaming(false);
        } catch (error) {
          onError(t('group.failed', { message: messageOf(error) || t('error.unknown') }));
        } finally {
          setBusy(false);
        }
      };

      const removeGroup = async function removeGroup() {
        if (busy) return;
        setBusy(true);
        try {
          await postAction('group.delete', { id: section.id });
          await refresh();
          setConfirming(false);
        } catch (error) {
          onError(t('group.failed', { message: messageOf(error) || t('error.unknown') }));
        } finally {
          setBusy(false);
        }
      };

      let head = null;
      if (renaming) {
        head = h('div', { className: 'dshr-groupRename' },
          h('input', {
            className: 'dshr-input',
            type: 'text',
            value: name,
            autoFocus: true,
            'aria-label': t('group.rename'),
            onChange: function onChange(event) {
              setName(event.target.value);
            },
            onKeyDown: function onKeyDown(event) {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              }
            },
          }),
          h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', disabled: busy, onClick: submitRename }, t('group.save')),
          h('button', { type: 'button', className: 'dshr-btn dshr-btn--ghost dshr-btn--small', disabled: busy, onClick: cancelRename }, t('action.cancel'))
        );
      } else if (confirming) {
        head = h('div', { className: 'dshr-groupRename' },
          h('span', { className: 'dshr-groupDeleteHint' }, t('group.deleteHint')),
          h('button', { type: 'button', className: 'dshr-btn dshr-btn--small dshr-btn--danger', disabled: busy, onClick: removeGroup }, t('group.deleteConfirm')),
          h('button', { type: 'button', className: 'dshr-btn dshr-btn--ghost dshr-btn--small', disabled: busy, onClick: function cancelDelete() { setConfirming(false); } }, t('action.cancel'))
        );
      } else {
        head = [
          h('span', { key: 'name', className: 'dshr-groupName' }, displayName),
          h('span', { key: 'count', className: 'dshr-groupCount' }, t('group.count', { n: itemCount })),
          canEdit ? h('div', { key: 'actions', className: 'dshr-groupActions' },
            h('button', { type: 'button', className: 'dshr-btn dshr-btn--ghost dshr-btn--small', onClick: startRename }, t('group.rename')),
            h('button', { type: 'button', className: 'dshr-btn dshr-btn--ghost dshr-btn--small', onClick: function startConfirm() { setConfirming(true); } }, t('group.delete'))
          ) : null,
        ];
      }

      return h('section', { className: 'dshr-group' },
        h('div', { className: 'dshr-groupHead' }, head),
        h('ul', { className: 'dshr-rows' }, props.children)
      );
    }

    function ReminderRow(props) {
      const item = isObject(props.item) ? props.item : {};
      const t = translatorOf(props);
      const status = statusOf(item);
      const freshness = freshnessOf(item);
      const sessions = normalizeSessions(item);
      const progress = clampInt(item.progress, 0, 100, 0);
      const importance = clampInt(item.importance, 1, 5, 3);
      const title = str(item.title) || t('toast.unknownItem');
      const nextStep = str(item.nextStep);
      const pinned = item.pinned === true;
      const done = status === 'done';
      const selected = props.selected === true;
      const itemId = str(item.id);
      const open = function open() {
        if (typeof props.onSelect === 'function') props.onSelect(itemId);
      };
      return h('li', {},
        h('div', {
          className: 'dshr-row',
          role: 'button',
          tabIndex: 0,
          'data-done': done ? 'true' : 'false',
          'aria-current': selected ? 'true' : undefined,
          'aria-label': t('row.open', { title: title }),
          onClick: open,
          onKeyDown: function onKeyDown(event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open();
            }
          },
        },
          h('span', { className: 'dshr-statusDot', 'data-status': status, 'aria-hidden': 'true' }),
          h('div', { className: 'dshr-rowMain' },
            h('div', { className: 'dshr-rowTop' },
              h('span', { className: 'dshr-rowTitle', title: title }, title),
              pinned ? h('span', { className: 'dshr-pin', 'aria-hidden': 'true' }, '★') : null
            ),
            nextStep ? h('div', { className: 'dshr-rowNext', title: nextStep }, nextStep) : null,
            h('div', { className: 'dshr-rowMeta' },
              h('span', { className: 'dshr-freshness', 'data-freshness': freshness }, t('freshness.' + freshness)),
              h('span', { className: 'dshr-rowMetaItem' }, t('row.progress', { n: progress })),
              h('span', {
                className: 'dshr-stars',
                role: 'img',
                'aria-label': t('row.importance', { n: importance }),
              },
                h('span', { className: 'dshr-starsFilled' }, '★'.repeat(importance)),
                h('span', { className: 'dshr-starsEmpty' }, '☆'.repeat(5 - importance))
              )
            ),
            sessions.length > 0 ? h('div', {
              className: 'dshr-sessionChips',
              role: 'group',
              'aria-label': t('row.sessions'),
            }, sessions.map(function renderSession(session) {
              return h('button', {
                key: session.id,
                type: 'button',
                className: 'dshr-sessionChip',
                title: session.title,
                onClick: function onClick(event) {
                  event.stopPropagation();
                  if (typeof props.onOpenSession === 'function') props.onOpenSession(session.id);
                },
                onKeyDown: function onKeyDown(event) {
                  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                },
              }, session.title);
            })) : null
          )
        )
      );
    }

    function ReminderEditor(props) {
      const t = translatorOf(props);
      const item = isObject(props.item) ? props.item : null;
      const isNew = item === null;
      const groups = Array.isArray(props.groups) ? props.groups.filter(isObject) : [];
      const [title, setTitle] = React.useState(function initialTitle() { return item ? str(item.title) : ''; });
      const [status, setStatus] = React.useState(function initialStatus() { return statusOf(item); });
      const [progress, setProgress] = React.useState(function initialProgress() { return clampInt(item && item.progress, 0, 100, 0); });
      const [importance, setImportance] = React.useState(function initialImportance() { return clampInt(item && item.importance, 1, 5, 3); });
      const [groupId, setGroupId] = React.useState(function initialGroupId() {
        const raw = item && typeof item.groupId === 'string' ? item.groupId : '';
        if (raw) return raw;
        const first = groups.find(function findGroup(group) { return typeof group.id === 'string' && group.id; });
        return first ? first.id : '';
      });
      const [pinned, setPinned] = React.useState(function initialPinned() { return item ? item.pinned === true : false; });
      const [nextStep, setNextStep] = React.useState(function initialNextStep() { return item ? str(item.nextStep) : ''; });
      const [notes, setNotes] = React.useState(function initialNotes() { return item ? str(item.notes) : ''; });
      const [titleTouched, setTitleTouched] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [confirmingDelete, setConfirmingDelete] = React.useState(false);
      const [newGroupOpen, setNewGroupOpen] = React.useState(false);
      const [newGroupName, setNewGroupName] = React.useState('');
      const [groupBusy, setGroupBusy] = React.useState(false);

      React.useEffect(function syncGroupSelection() {
        const known = groups.some(function hasGroup(group) { return group && group.id === groupId; });
        if (known) return;
        const itemGroup = item && typeof item.groupId === 'string' ? item.groupId : '';
        if (itemGroup && groups.some(function hasItemGroup(group) { return group && group.id === itemGroup; })) {
          setGroupId(itemGroup);
          return;
        }
        const first = groups.find(function findGroup(group) { return group && typeof group.id === 'string' && group.id; });
        if (first) setGroupId(first.id);
      }, [groups, groupId, item]);

      const onClose = typeof props.onClose === 'function' ? props.onClose : function noopClose() {};
      const onSaved = typeof props.onSaved === 'function' ? props.onSaved : function noopSaved() {};
      const onDeleted = typeof props.onDeleted === 'function' ? props.onDeleted : function noopDeleted() {};
      const onOpenSession = typeof props.onOpenSession === 'function' ? props.onOpenSession : openSessionSafely;

      const trimmedTitle = title.trim();
      const titleError = trimmedTitle.length === 0
        ? t('editor.titleRequired')
        : (trimmedTitle.length > MAX_TITLE_LENGTH ? t('editor.titleTooLong') : null);
      const sessions = normalizeSessions(item);

      const groupOptions = [];
      for (const group of groups) {
        if (typeof group.id === 'string' && group.id) {
          groupOptions.push({ id: group.id, name: str(group.name) || t('group.untitled') });
        }
      }
      if (groupId && !groupOptions.some(function hasOption(option) { return option.id === groupId; })) {
        groupOptions.push({ id: groupId, name: t('group.unknown') });
      }

      const save = async function save() {
        if (saving) return;
        setTitleTouched(true);
        if (titleError) return;
        setSaving(true);
        setError(null);
        let outcome = null;
        try {
          const patch = {
            title: trimmedTitle,
            notes: notes,
            nextStep: nextStep,
            status: status,
            progress: progress,
            importance: importance,
            pinned: pinned,
          };
          if (groupId) patch.groupId = groupId;
          if (isNew) {
            const created = await postAction('item.create', patch);
            await refresh();
            outcome = { created: true, value: created };
          } else {
            await postAction('item.update', { id: item.id, patch: patch });
            await refresh();
            outcome = { created: false, value: null };
          }
        } catch (saveError) {
          setError(t('editor.saveFailed', { message: messageOf(saveError) || t('error.unknown') }));
        } finally {
          setSaving(false);
        }
        if (outcome) onSaved(outcome.value, outcome.created);
      };

      const remove = async function remove() {
        if (saving || isNew) return;
        setSaving(true);
        setError(null);
        let deleted = false;
        try {
          await postAction('item.delete', { id: item.id });
          await refresh();
          deleted = true;
        } catch (deleteError) {
          setError(t('editor.deleteFailed', { message: messageOf(deleteError) || t('error.unknown') }));
        } finally {
          setSaving(false);
        }
        if (deleted) onDeleted();
      };

      const createGroup = async function createGroup() {
        if (groupBusy) return;
        const nextName = newGroupName.trim();
        if (!nextName) {
          setError(t('group.renameRequired'));
          return;
        }
        setGroupBusy(true);
        setError(null);
        try {
          const value = await postAction('group.create', { name: nextName });
          await refresh();
          if (isObject(value) && typeof value.id === 'string' && value.id) setGroupId(value.id);
          setNewGroupOpen(false);
          setNewGroupName('');
        } catch (groupError) {
          setError(t('editor.groupFailed', { message: messageOf(groupError) || t('error.unknown') }));
        } finally {
          setGroupBusy(false);
        }
      };

      const meta = (function buildMeta() {
        if (isNew) return null;
        return h('div', { className: 'dshr-detailMeta' },
          t('editor.meta', {
            source: t(sourceKeyOf(item)),
            freshness: t('freshness.' + freshnessOf(item)),
            time: formatRelative(item && item.updatedAt, t),
          })
        );
      })();

      const fields = [
        h('div', { key: 'title', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.title')),
          h('input', {
            className: 'dshr-input',
            type: 'text',
            value: title,
            placeholder: t('editor.titlePlaceholder'),
            'aria-label': t('editor.title'),
            'aria-invalid': titleTouched && titleError ? 'true' : 'false',
            onBlur: function onBlur() { setTitleTouched(true); },
            onChange: function onChange(event) { setTitle(event.target.value); },
          }),
          titleTouched && titleError ? h('p', { className: 'dshr-fieldError' }, titleError) : null
        ),
        h('div', { key: 'status', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.status')),
          h('div', { className: 'dshr-segmented', role: 'group', 'aria-label': t('editor.status') },
            STATUSES.map(function renderStatus(value) {
              return h('button', {
                key: value,
                type: 'button',
                className: 'dshr-segBtn',
                'aria-pressed': status === value,
                onClick: function onClick() { setStatus(value); },
              }, t('status.' + value));
            })
          )
        ),
        h('div', { key: 'progress', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.progress')),
          h('div', { className: 'dshr-rangeRow' },
            h('input', {
              className: 'dshr-range',
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              value: progress,
              'aria-label': t('editor.progress'),
              onChange: function onChange(event) {
                setProgress(clampInt(Number(event.target.value), 0, 100, progress));
              },
            }),
            h('span', { className: 'dshr-value' }, t('row.progress', { n: progress }))
          )
        ),
        h('div', { key: 'importance', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.importance')),
          h('div', { className: 'dshr-starsBtns', role: 'group', 'aria-label': t('editor.importance') },
            IMPORTANCE_LEVELS.map(function renderStar(value) {
              return h('button', {
                key: value,
                type: 'button',
                className: 'dshr-starBtn',
                'aria-pressed': importance >= value,
                'aria-label': t('editor.importanceValue', { n: value }),
                onClick: function onClick() { setImportance(value); },
              }, importance >= value ? '★' : '☆');
            })
          )
        ),
        h('div', { key: 'group', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.group')),
          h('div', { className: 'dshr-groupField' },
            h('select', {
              className: 'dshr-select',
              value: groupId,
              'aria-label': t('editor.group'),
              disabled: saving || groupBusy,
              onChange: function onChange(event) { setGroupId(event.target.value); },
            }, groupOptions.map(function renderGroupOption(option) {
              return h('option', { key: option.id, value: option.id }, option.name);
            }))
          ),
          h('button', {
            type: 'button',
            className: 'dshr-btn dshr-btn--ghost dshr-btn--small',
            'aria-expanded': newGroupOpen,
            onClick: function toggleNewGroup() { setNewGroupOpen(function flip(value) { return !value; }); },
          }, t('editor.newGroup')),
          newGroupOpen ? h('div', { className: 'dshr-inlineCreate' },
            h('input', {
              className: 'dshr-input',
              type: 'text',
              value: newGroupName,
              placeholder: t('editor.newGroupPlaceholder'),
              'aria-label': t('editor.newGroupPlaceholder'),
              onChange: function onChange(event) { setNewGroupName(event.target.value); },
              onKeyDown: function onKeyDown(event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  createGroup();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setNewGroupOpen(false);
                }
              },
            }),
            h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', disabled: groupBusy, onClick: createGroup },
              groupBusy ? t('editor.saving') : t('editor.createGroup'))
          ) : null
        ),
        h('div', { key: 'nextStep', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.nextStep')),
          h('textarea', {
            className: 'dshr-textarea',
            value: nextStep,
            placeholder: t('editor.nextStepPlaceholder'),
            'aria-label': t('editor.nextStep'),
            onChange: function onChange(event) { setNextStep(event.target.value); },
          })
        ),
        h('div', { key: 'notes', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.notes')),
          h('textarea', {
            className: 'dshr-textarea',
            value: notes,
            placeholder: t('editor.notesPlaceholder'),
            'aria-label': t('editor.notes'),
            onChange: function onChange(event) { setNotes(event.target.value); },
          })
        ),
        h('div', { key: 'pinned', className: 'dshr-field' },
          h('label', { className: 'dshr-checkRow' },
            h('input', {
              className: 'dshr-checkbox',
              type: 'checkbox',
              checked: pinned,
              onChange: function onChange(event) { setPinned(event.target.checked === true); },
            }),
            h('span', { className: 'dshr-label' }, t('editor.pinned'))
          )
        ),
        h('div', { key: 'sessions', className: 'dshr-field' },
          h('span', { className: 'dshr-label' }, t('editor.sessions')),
          sessions.length > 0 ? h('div', { className: 'dshr-sessionList' },
            sessions.map(function renderSession(session) {
              return h('button', {
                key: session.id,
                type: 'button',
                className: 'dshr-sessionChip',
                title: session.title,
                onClick: function onClick() { onOpenSession(session.id); },
              }, session.title);
            })
          ) : h('p', { className: 'dshr-editorSessionsEmpty' }, t('editor.sessionsEmpty'))
        ),
      ];

      const footer = confirmingDelete
        ? [
          h('p', { key: 'hint', className: 'dshr-editorFooterHint' }, t('editor.deleteHint')),
          h('button', { key: 'confirm', type: 'button', className: 'dshr-btn dshr-btn--danger', disabled: saving, onClick: remove }, t('editor.deleteConfirm')),
          h('button', { key: 'cancel', type: 'button', className: 'dshr-btn dshr-btn--ghost', disabled: saving, onClick: function cancelDelete() { setConfirmingDelete(false); } }, t('action.cancel')),
        ]
        : [
          !isNew ? h('button', { key: 'delete', type: 'button', className: 'dshr-btn dshr-btn--ghost dshr-btn--danger', disabled: saving, onClick: function startDelete() { setConfirmingDelete(true); } }, t('editor.delete')) : null,
          h('span', { key: 'spacer', className: 'dshr-spacer' }),
          h('button', { key: 'cancel', type: 'button', className: 'dshr-btn dshr-btn--ghost', disabled: saving, onClick: onClose }, t('action.cancel')),
          h('button', { key: 'save', type: 'button', className: 'dshr-btn dshr-btn--accent', disabled: saving, onClick: save }, saving ? t('editor.saving') : t('editor.save')),
        ];

      return h('div', { className: 'dshr-detailBody' },
        h('div', { className: 'dshr-detailHeader' },
          h('h2', { className: 'dshr-detailTitle' }, isNew ? t('editor.newTitle') : t('editor.editTitle')),
          h('button', { type: 'button', className: 'dshr-iconBtn', 'aria-label': t('editor.close'), onClick: onClose }, '×')
        ),
        h('div', { className: 'dshr-editorScroll' },
          meta,
          fields,
          error ? h('p', { className: 'dshr-fieldError', role: 'alert' }, error) : null
        ),
        h('div', { className: 'dshr-editorFooter' }, footer)
      );
    }

    function RemindersPage(props) {
      const t = translatorOf(props);
      const snapshot = React.useSyncExternalStore(subscribeStore, getSnapshot);
      const editRequestState = React.useSyncExternalStore(subscribeEdit, getEditState);
      const [search, setSearch] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('all');
      const [selectedId, setSelectedId] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      const [settingsBusy, setSettingsBusy] = React.useState(false);
      const [runBusy, setRunBusy] = React.useState(false);
      const [pageError, setPageError] = React.useState(null);
      useNowTick();

      const data = isObject(snapshot.data) ? snapshot.data : null;
      const error = str(snapshot.error);
      const loading = !data && (snapshot.status === 'idle' || snapshot.status === 'loading');
      const unavailable = !data && snapshot.status === 'error';
      const items = React.useMemo(function selectItems() {
        if (!data || !Array.isArray(data.items)) return [];
        return data.items.filter(isObject);
      }, [data]);
      const groups = React.useMemo(function selectGroups() {
        if (!data || !Array.isArray(data.groups)) return [];
        return data.groups.filter(isObject);
      }, [data]);
      const filtered = React.useMemo(function selectFiltered() {
        return filterItems(items, groups, search, statusFilter);
      }, [items, groups, search, statusFilter]);
      const sections = React.useMemo(function selectSections() {
        return buildSections(filtered, groups);
      }, [filtered, groups]);

      React.useEffect(function consumeEditRequest() {
        const token = num(editRequestState && editRequestState.token, 0);
        if (token === 0 || token === consumedEditToken) return;
        consumedEditToken = token;
        const itemId = str(editRequestState && editRequestState.itemId);
        if (!itemId) return;
        setCreating(false);
        setSelectedId(itemId);
        setSearch('');
        setStatusFilter('all');
        selectPanelSafely();
      }, [editRequestState]);

      React.useEffect(function pruneSelection() {
        if (creating || !selectedId) return;
        if (snapshot.status !== 'ready') return;
        const exists = items.some(function hasItem(item) { return item && item.id === selectedId; });
        if (!exists) setSelectedId(null);
      }, [creating, selectedId, snapshot.status, items]);

      const openNew = function openNew() {
        setSelectedId(null);
        setCreating(true);
        setPageError(null);
      };

      const selectItem = function selectItem(itemId) {
        const id = str(itemId);
        if (!id) return;
        setCreating(false);
        setSelectedId(id);
        setPageError(null);
      };

      const closeEditor = function closeEditor() {
        setCreating(false);
        setSelectedId(null);
      };

      const handleSaved = function handleSaved(value, created) {
        if (created && isObject(value) && typeof value.id === 'string' && value.id) {
          setCreating(false);
          setSelectedId(value.id);
        }
      };

      const handleDeleted = function handleDeleted() {
        setCreating(false);
        setSelectedId(null);
      };

      const retry = function retry() {
        loadState(true);
      };

      const updateSettings = async function updateSettings(patch, failureKey) {
        if (settingsBusy) return;
        setSettingsBusy(true);
        setPageError(null);
        try {
          await postAction('settings.update', patch);
          await refresh();
        } catch (settingsError) {
          setPageError(t(failureKey || 'dream.toggleFailed', { message: messageOf(settingsError) || t('error.unknown') }));
        } finally {
          setSettingsBusy(false);
        }
      };

      const toggleDream = function toggleDream() {
        const current = dreamState();
        updateSettings({ dreamEnabled: !current.enabled }, 'dream.toggleFailed');
      };

      const runDream = async function runDream() {
        if (runBusy) return;
        setRunBusy(true);
        setPageError(null);
        try {
          await postAction('dream.run', {});
          await refresh();
        } catch (runError) {
          setPageError(t('dream.runFailed', { message: messageOf(runError) || t('error.unknown') }));
        } finally {
          setRunBusy(false);
        }
      };

      const changeInterval = function changeInterval(nextInterval) {
        updateSettings({ dreamIntervalMinutes: nextInterval }, 'dream.intervalFailed');
      };

      const openSession = function openSession(sessionId) {
        const id = str(sessionId);
        if (!id) return;
        try {
          hostBridge.openSession(id);
        } catch (sessionError) {
          setPageError(t('error.session', { message: messageOf(sessionError) || t('error.unknown') }));
        }
      };

      function dreamState() {
        const dream = data && isObject(data.dream) ? data.dream : {};
        const settings = data && isObject(data.settings) ? data.settings : {};
        const enabled = typeof dream.enabled === 'boolean' ? dream.enabled : (settings.dreamEnabled === true);
        const interval = clampInt(dream.intervalMinutes, 1, 1440, clampInt(settings.dreamIntervalMinutes, 1, 1440, 10));
        const running = dream.running === true;
        const lastRunAt = num(dream.lastRunAt, 0);
        return { enabled: enabled, interval: interval, running: running, lastRunAt: lastRunAt };
      }

      const dream = dreamState();
      const lastRunText = dream.lastRunAt > 0 ? formatRelative(dream.lastRunAt, t) : t('time.never');
      const subtitleText = dream.enabled
        ? (dream.running
          ? t('dream.statusRunning', { interval: dream.interval })
          : t('dream.statusOn', { interval: dream.interval, last: lastRunText }))
        : t('dream.statusOff', { interval: dream.interval });

      const subtitleNodes = [];
      if (dream.running) subtitleNodes.push(h('span', { key: 'spinner', className: 'dshr-spinner', 'aria-hidden': 'true' }));
      subtitleNodes.push(h('span', { key: 'text', className: 'dshr-subtitleText' }, subtitleText));

      const header = h('div', { className: 'dshr-pageHeading' },
        h('div', { className: 'dshr-headingMain' },
          h('h1', {}, t('panel')),
          h('div', { className: 'dshr-subtitle' }, subtitleNodes)
        ),
        h('div', { className: 'dshr-headingActions' },
          h('button', { type: 'button', className: 'dshr-btn dshr-btn--accent', onClick: openNew }, t('action.new')),
          h('button', {
            type: 'button',
            className: 'dshr-btn',
            disabled: !data || dream.running || runBusy,
            'aria-label': t('action.dreamNow'),
            onClick: runDream,
          },
            dream.running || runBusy ? h('span', { className: 'dshr-spinner', 'aria-hidden': 'true' }) : null,
            h('span', {}, dream.running || runBusy ? t('dream.running') : t('action.dreamNow'))
          ),
          h('span', { className: 'dshr-switchWrap' },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': dream.enabled,
              'aria-label': t('dream.toggle'),
              className: 'dshr-toggle' + (dream.enabled ? ' dshr-toggle--on' : ''),
              disabled: !data || settingsBusy,
              onClick: toggleDream,
            }, h('span', { className: 'dshr-toggleKnob' })),
            h('span', { className: 'dshr-switchLabel' }, t('dream.toggle'))
          ),
          h('select', {
            className: 'dshr-select dshr-interval',
            value: String(dream.interval),
            'aria-label': t('dream.interval'),
            disabled: !data || settingsBusy,
            onChange: function onChange(event) {
              const next = Number(event.target.value);
              if (isFinite(next) && next > 0 && next !== dream.interval) changeInterval(next);
            },
          }, intervalOptions(dream.interval).map(function renderInterval(value) {
            return h('option', { key: String(value), value: String(value) }, t('time.minutes', { n: value }));
          }))
        )
      );

      const toolbar = h('div', { className: 'dshr-toolbar' },
        h('div', { className: 'dshr-search' },
          h('input', {
            className: 'dshr-searchInput',
            type: 'search',
            value: search,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.label'),
            onChange: function onChange(event) { setSearch(event.target.value); },
            onKeyDown: function onKeyDown(event) {
              if (event.key === 'Escape' && search) {
                event.stopPropagation();
                setSearch('');
              }
            },
          })
        ),
        h('div', { className: 'dshr-filterTabs', role: 'group', 'aria-label': t('filter.statusLabel') },
          ['all'].concat(STATUSES).map(function renderFilter(value) {
            return h('button', {
              key: value,
              type: 'button',
              className: 'dshr-chip',
              'aria-pressed': statusFilter === value,
              onClick: function onClick() { setStatusFilter(value); },
            }, value === 'all' ? t('filter.all') : t('status.' + value));
          })
        )
      );

      const selectedItem = (function findSelected() {
        if (!selectedId) return null;
        for (const item of items) if (item && item.id === selectedId) return item;
        return null;
      })();
      const showEditor = creating || selectedItem !== null;

      let body = null;
      if (loading) {
        body = h('div', { className: 'dshr-loading' },
          h('span', { className: 'dshr-spinner', 'aria-hidden': 'true' }),
          h('span', {}, t('loading'))
        );
      } else if (unavailable) {
        body = h('div', { className: 'dshr-empty' },
          h('div', { className: 'dshr-emptyGlyph' }, h(RemindersIcon, { size: 44 })),
          h('h2', { className: 'dshr-emptyTitle' }, t('unavailable.title')),
          h('p', { className: 'dshr-emptyBody' }, t('unavailable.body')),
          h('div', { className: 'dshr-emptyActions' },
            h('button', { type: 'button', className: 'dshr-btn dshr-btn--accent', onClick: retry }, t('action.retry'))
          )
        );
      } else if (items.length === 0) {
        body = h('div', { className: 'dshr-empty' },
          h('div', { className: 'dshr-emptyGlyph' }, h(RemindersIcon, { size: 44 })),
          h('h2', { className: 'dshr-emptyTitle' }, t('empty.title')),
          h('p', { className: 'dshr-emptyBody' }, t('empty.body')),
          h('div', { className: 'dshr-emptyActions' },
            h('button', { type: 'button', className: 'dshr-btn dshr-btn--accent', onClick: openNew }, t('empty.action'))
          )
        );
      } else if (filtered.length === 0) {
        body = h('div', { className: 'dshr-empty' },
          h('h2', { className: 'dshr-emptyTitle' }, t('empty.filteredTitle')),
          h('p', { className: 'dshr-emptyBody' }, t('empty.filteredBody')),
          h('div', { className: 'dshr-emptyActions' },
            h('button', {
              type: 'button',
              className: 'dshr-btn',
              onClick: function clearFilters() {
                setSearch('');
                setStatusFilter('all');
              },
            }, t('empty.clearFilters'))
          )
        );
      } else {
        body = h('div', { className: 'dshr-groups' }, sections.map(function renderSection(section) {
          return h(GroupSection, {
            key: section.key,
            section: section,
            t: t,
            onError: setPageError,
          }, section.items.map(function renderRow(item, index) {
            return h(ReminderRow, {
              key: str(item.id) || ('row:' + section.key + ':' + index),
              item: item,
              t: t,
              selected: selectedId === item.id,
              onSelect: selectItem,
              onOpenSession: openSession,
            });
          }));
        }));
      }

      return h('section', {
        className: 'dshr-page',
        'data-detail': showEditor ? 'true' : 'false',
        'aria-label': t('panel'),
      },
        h('div', { className: 'dshr-listPane' },
          h('div', { className: 'dshr-pageScroll' },
            h('div', { className: 'dshr-pageContent' },
              header,
              pageError ? h('div', { className: 'dshr-notice dshr-notice--error', role: 'alert' },
                h('p', {}, pageError),
                h('button', { type: 'button', className: 'dshr-iconBtn', 'aria-label': t('panel.noticeDismiss'), onClick: function clearError() { setPageError(null); } }, '×')
              ) : null,
              data && error ? h('div', { className: 'dshr-notice', role: 'status' },
                h('p', {}, t('stale.body', { message: error })),
                h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', onClick: retry }, t('action.retry'))
              ) : null,
              toolbar,
              body
            )
          )
        ),
        showEditor ? h('aside', {
          className: 'dshr-detail',
          'aria-label': creating ? t('editor.newTitle') : t('editor.editTitle'),
        },
          h(ReminderEditor, {
            key: creating ? 'new' : 'item:' + str(selectedId),
            item: creating ? null : selectedItem,
            groups: groups,
            t: t,
            onClose: closeEditor,
            onSaved: handleSaved,
            onDeleted: handleDeleted,
            onOpenSession: openSession,
          })
        ) : null
      );
    }

    function intervalOptions(current) {
      if (INTERVALS.indexOf(current) >= 0) return INTERVALS;
      return INTERVALS.concat([current]).sort(function ascending(left, right) { return left - right; });
    }

    function DreamToast(props) {
      const t = translatorOf(props);
      const snapshot = React.useSyncExternalStore(subscribeStore, getSnapshot);
      const [seenAt, setSeenAt] = React.useState(readSeenAt);
      const [busy, setBusy] = React.useState(false);
      const [removedIds, setRemovedIds] = React.useState([]);
      const [actionError, setActionError] = React.useState(null);
      // Auto-dismiss: a finished popup counts down and fades away. The countdown
      // pauses while hovered, focused, or while the page itself is not focused.
      const [hoverPaused, setHoverPaused] = React.useState(false);
      const [focusWithin, setFocusWithin] = React.useState(false);
      const [pageActive, setPageActive] = React.useState(true);
      const [remainingMs, setRemainingMs] = React.useState(TOAST_LIFETIME_MS);
      const [fading, setFading] = React.useState(false);
      const [hidden, setHidden] = React.useState(false);
      // A running pass can be hidden too; the finished result still surfaces.
      const [suppressedRunningId, setSuppressedRunningId] = React.useState('');
      const remainingRef = React.useRef(TOAST_LIFETIME_MS);
      const deadlineRef = React.useRef(0);
      const data = isObject(snapshot.data) ? snapshot.data : null;
      const feed = unseenFeed(data, seenAt, suppressedRunningId);
      const runningFeed = isObject(feed.running) ? feed.running : null;
      const activity = runningFeed || (isObject(feed.activity) ? feed.activity : null);
      const activityId = activity ? str(activity.id) : '';
      const activityStatus = activity ? str(activity.status) : '';
      const running = activityStatus === 'running';
      const failed = activityStatus === 'error';
      const aggregated = Boolean(activity && activity.aggregated === true);
      const settled = activityId !== '' && !running;
      const paused = hoverPaused || focusWithin || !pageActive;

      const markSeen = function markSeen() {
        if (!activity) return;
        if (running) {
          setSuppressedRunningId(activityId);
          return;
        }
        const seenThrough = Math.max(
          num(activity.seenThrough, 0),
          num(activity.endedAt, 0),
          num(activity.startedAt, 0)
        );
        writeSeenAt(seenThrough);
        setSeenAt(readSeenAt());
      };

      React.useEffect(function resetOnActivityChange() {
        setRemovedIds([]);
        setActionError(null);
        setBusy(false);
      }, [activityId]);

      React.useEffect(function trackPageFocus() {
        if (typeof window === 'undefined') return undefined;
        const update = function updatePageFocus() {
          const documentVisible = typeof document === 'undefined' || document.hidden !== true;
          const hasFocus = typeof document === 'undefined' || typeof document.hasFocus !== 'function' || document.hasFocus();
          setPageActive(Boolean(window.document && documentVisible && hasFocus));
        };
        update();
        window.addEventListener('focus', update);
        window.addEventListener('blur', update);
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', update);
        }
        return function stopTracking() {
          window.removeEventListener('focus', update);
          window.removeEventListener('blur', update);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', update);
          }
        };
      }, []);

      React.useEffect(function resetCountdown() {
        setFading(false);
        setHidden(false);
        setSuppressedRunningId(function keepRelevant(current) {
          return current !== '' && current !== activityId ? '' : current;
        });
        setRemainingMs(TOAST_LIFETIME_MS);
        remainingRef.current = TOAST_LIFETIME_MS;
        deadlineRef.current = Date.now() + TOAST_LIFETIME_MS;
      }, [activityId, settled]);

      React.useEffect(function applyPause() {
        if (!settled || hidden || fading) return;
        if (paused) {
          remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
        } else {
          deadlineRef.current = Date.now() + remainingRef.current;
        }
      }, [paused, settled, hidden, fading, activityId]);

      React.useEffect(function countdown() {
        if (!settled || paused || fading || hidden) return undefined;
        const timer = setInterval(function tickCountdown() {
          const left = deadlineRef.current - Date.now();
          if (left <= 0) {
            remainingRef.current = 0;
            setRemainingMs(0);
            setFading(true);
          } else {
            remainingRef.current = left;
            setRemainingMs(left);
          }
        }, 100);
        return function stopCountdown() {
          clearInterval(timer);
        };
      }, [settled, paused, fading, hidden, activityId]);

      React.useEffect(function finishFade() {
        if (!fading || activityId === '') return undefined;
        const timer = setTimeout(function commitFade() {
          markSeen();
          setHidden(true);
        }, TOAST_FADE_MS);
        return function stopFade() {
          clearTimeout(timer);
        };
      }, [fading, activityId]);

      if (!activity || !activityId || hidden) return null;

      const scanned = clampInt(activity.scanned, 0, 1000000, 0);
      const created = clampInt(activity.created, 0, 1000000, 0);
      const updated = clampInt(activity.updated, 0, 1000000, 0);
      const attention = clampInt(activity.attention, 0, 1000000, 0);
      const undoable = activity.undoable === true;
      const rawChanges = Array.isArray(activity.changes) ? activity.changes.filter(isObject) : [];
      const changes = rawChanges.filter(function notRemoved(change) {
        return removedIds.indexOf(str(change.itemId)) < 0;
      }).slice(0, 3);
      const changedAnything = created + updated + attention > 0 || rawChanges.length > 0;

      const dismiss = function dismiss() {
        markSeen();
        setHidden(true);
      };
      const dismissWithStop = function dismissWithStop(event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        dismiss();
      };

      const openList = function openList() {
        selectPanelSafely();
      };

      const editChange = function editChange(change) {
        const itemId = str(change.itemId);
        if (!itemId) return;
        requestEdit(itemId);
        selectPanelSafely();
      };

      const deleteChange = async function deleteChange(change) {
        const itemId = str(change.itemId);
        if (!itemId || busy) return;
        setBusy(true);
        setActionError(null);
        try {
          await postAction('item.delete', { id: itemId });
          setRemovedIds(function addRemoved(list) { return list.concat([itemId]); });
          await refresh();
        } catch (deleteError) {
          setActionError(t('toast.deleteFailed', { message: messageOf(deleteError) || t('error.unknown') }));
        } finally {
          setBusy(false);
        }
      };

      const undo = async function undo() {
        if (busy) return;
        setBusy(true);
        setActionError(null);
        try {
          await postAction('dream.undo', { activityId: activityId });
          await refresh();
        } catch (undoError) {
          setActionError(t('toast.undoFailed', { message: messageOf(undoError) || t('error.unknown') }));
        } finally {
          setBusy(false);
        }
      };

      const retryRun = async function retryRun() {
        if (busy) return;
        setBusy(true);
        setActionError(null);
        try {
          await postAction('dream.run', {});
          await refresh();
        } catch (retryError) {
          setActionError(t('toast.actionFailed', { message: messageOf(retryError) || t('error.unknown') }));
        } finally {
          setBusy(false);
        }
      };

      const dismissButton = h('button', {
        type: 'button',
        className: 'dshr-iconBtn',
        'aria-label': t('toast.dismiss'),
        onClick: dismissWithStop,
      }, '×');

      const head = h('div', { className: 'dshr-toastHead' },
        running ? h('span', { className: 'dshr-pulseDot', 'aria-hidden': 'true' }) : null,
        h('h2', { className: 'dshr-toastTitle' },
          running
            ? t('toast.running')
            : (failed
              ? t('toast.errorTitle')
              : (aggregated ? t('toast.whileAway') : (changedAnything ? t('toast.doneTitle') : t('toast.nothingTitle'))))
        ),
        dismissButton
      );

      const bodyNodes = [];
      if (running) {
        bodyNodes.push(h('p', { key: 'runningLine', className: 'dshr-toastBody' },
          scanned > 0 ? t('toast.runningScanned', { n: scanned }) : t('toast.runningHint')));
        bodyNodes.push(h('div', { key: 'progress', className: 'dshr-progress', 'aria-hidden': 'true' }));
      } else if (failed) {
        bodyNodes.push(h('p', { key: 'errorText', className: 'dshr-toastErrorText' },
          str(activity.error) || t('toast.errorFallback')));
      } else {
        bodyNodes.push(h('p', { key: 'summary', className: 'dshr-toastBody' },
          aggregated
            ? t('toast.aggregateBody', { runs: Math.max(1, num(activity.runs, 1)), created: created, updated: updated, attention: attention })
            : t('toast.summary', { scanned: scanned, created: created, updated: updated, attention: attention })
        ));
        if (changes.length > 0) {
          bodyNodes.push(h('ul', { key: 'changes', className: 'dshr-toastChanges', 'aria-label': t('toast.changes') }, changes.map(function renderChange(change, index) {
            const kind = str(change.kind);
            const itemId = str(change.itemId);
            return h('li', { key: itemId + ':' + index, className: 'dshr-change', title: str(change.detail) || undefined },
              h('span', { className: 'dshr-kindBadge', 'data-kind': kind }, kindLabel(t, kind)),
              h('span', { className: 'dshr-changeTitle' }, str(change.title) || t('toast.unknownItem')),
              itemId ? h('span', { className: 'dshr-changeActions' },
                h('button', { type: 'button', className: 'dshr-btn dshr-btn--ghost dshr-btn--small', disabled: busy, onClick: function onClick() { editChange(change); } }, t('toast.edit')),
                h('button', { type: 'button', className: 'dshr-btn dshr-btn--ghost dshr-btn--small dshr-btn--danger', disabled: busy, onClick: function onClick() { deleteChange(change); } }, t('toast.delete'))
              ) : null
            );
          })));
        }
      }
      if (actionError) {
        bodyNodes.push(h('p', { key: 'actionError', className: 'dshr-toastErrorText', role: 'alert' }, actionError));
      }

      const footer = running ? h('div', { className: 'dshr-toastFooter' },
        h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', onClick: dismissWithStop }, t('toast.dismiss'))
      ) : h('div', { className: 'dshr-toastFooter' },
        !failed && !aggregated && undoable
          ? h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', disabled: busy, onClick: undo }, t('toast.undo'))
          : null,
        !failed ? h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', onClick: openList }, t('toast.openList')) : null,
        failed ? h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', disabled: busy, onClick: retryRun },
          busy ? t('toast.retrying') : t('toast.retry')) : null,
        h('button', { type: 'button', className: 'dshr-btn dshr-btn--small', onClick: dismiss }, t('toast.dismiss'))
      );

      const pauseForPointer = function pauseForPointer() {
        setHoverPaused(true);
      };
      const resumeForPointer = function resumeForPointer() {
        setHoverPaused(false);
      };
      const pauseForFocus = function pauseForFocus() {
        setFocusWithin(true);
      };
      const resumeForFocus = function resumeForFocus(event) {
        const current = event && event.currentTarget;
        const next = event && event.relatedTarget;
        if (current && next && typeof current.contains === 'function' && current.contains(next)) return;
        setFocusWithin(false);
      };
      const timerFraction = settled ? Math.max(0, Math.min(1, remainingMs / TOAST_LIFETIME_MS)) : 1;
      const timerBar = h('div', {
        className: 'dshr-toastTimer',
        'aria-hidden': 'true',
        'data-paused': settled && paused ? 'true' : undefined,
      },
        h('div', {
          className: 'dshr-toastTimerFill' + (settled ? '' : ' dshr-toastTimerFill--indeterminate'),
          style: settled ? { width: (timerFraction * 100).toFixed(2) + '%' } : undefined,
        })
      );

      return h('section', {
        className: 'dshr-toast' + (fading ? ' dshr-toast--fading' : ''),
        role: failed ? 'alert' : 'status',
        'aria-live': failed ? 'assertive' : 'polite',
        'aria-label': t('toast.notification'),
        'data-state': running ? 'running' : (failed ? 'error' : 'done'),
        'data-paused': settled && paused ? 'true' : undefined,
        onMouseEnter: pauseForPointer,
        onMouseLeave: resumeForPointer,
        onFocusCapture: pauseForFocus,
        onBlurCapture: resumeForFocus,
      }, timerBar, h('div', { className: 'dshr-toastScroll' }, head, bodyNodes, footer));
    }

    // -------------------------------------------------------------------
    // Styles (single global style tag under the dshr- prefix)
    // -------------------------------------------------------------------
    const STYLE_TEXT = `
      .dshr-page{box-sizing:border-box;width:100%;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-family:var(--dsw-font-family);font-size:14px;line-height:1.6}
      .dshr-listPane{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
      .dshr-pageScroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) var(--dsw-alias-bg-base)}
      .dshr-pageContent{max-width:960px;margin:0 auto;padding:0 clamp(20px,4vw,44px) 48px}
      .dshr-pageHeading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 16px;margin-bottom:18px;padding-top:28px}
      .dshr-headingMain{min-width:0}
      .dshr-pageHeading h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
      .dshr-subtitle{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
      .dshr-headingActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;flex:none}
      .dshr-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
      .dshr-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
      .dshr-btn:disabled{opacity:.55;cursor:default}
      .dshr-btn--accent{color:var(--dsw-alias-state-business-primary)}
      .dshr-btn--ghost{background:none;border:0;color:var(--dsw-alias-label-secondary)}
      .dshr-btn--danger{color:var(--dsw-alias-state-error-primary)}
      .dshr-btn--small{height:26px;padding:0 8px;font-size:12px;border-radius:var(--dsw-radius-md)}
      .dshr-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
      .dshr-switchWrap{display:inline-flex;align-items:center;gap:6px}
      .dshr-switchLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dshr-toggle{position:relative;flex:none;width:34px;height:20px;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:background .15s,border-color .15s}
      .dshr-toggle--on{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
      .dshr-toggle:disabled{opacity:.55;cursor:default}
      .dshr-toggleKnob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}
      .dshr-toggle--on .dshr-toggleKnob{transform:translateX(14px)}
      .dshr-select.dshr-interval{width:auto;min-width:88px}
      .dshr-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-bottom:16px}
      .dshr-search{flex:1 1 220px;min-width:0;max-width:340px}
      .dshr-searchInput{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none;transition:border-color .15s}
      .dshr-searchInput::placeholder{color:var(--dsw-alias-label-caption)}
      .dshr-searchInput:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
      .dshr-searchInput::-webkit-search-cancel-button{display:none}
      .dshr-filterTabs{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
      .dshr-chip{display:inline-flex;align-items:center;height:28px;padding:0 10px;border:0;border-radius:14px;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
      .dshr-chip[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dshr-group{margin-bottom:22px}
      .dshr-groupHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:24px;margin-bottom:6px;padding:0 4px}
      .dshr-groupName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dshr-groupCount{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
      .dshr-groupActions{display:flex;align-items:center;gap:2px;margin-left:auto}
      .dshr-groupRename{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1;min-width:0}
      .dshr-groupRename .dshr-input{flex:1 1 140px;height:28px;font-size:13px}
      .dshr-groupDeleteHint{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dshr-rows{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
      .dshr-row{display:flex;align-items:flex-start;gap:10px;width:100%;padding:8px 10px;border-radius:12px;text-align:left;cursor:pointer}
      .dshr-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover)}
      .dshr-statusDot{flex:none;width:9px;height:9px;margin-top:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}
      .dshr-statusDot[data-status=doing]{background:var(--dsw-alias-state-business-primary)}
      .dshr-statusDot[data-status=blocked]{background:var(--dsw-alias-state-warn-primary)}
      .dshr-statusDot[data-status=done]{background:var(--dsw-alias-state-success-primary)}
      .dshr-rowMain{display:flex;flex-direction:column;flex:1;min-width:0}
      .dshr-rowTop{display:flex;align-items:center;gap:6px;min-width:0}
      .dshr-rowTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dshr-row[data-done=true] .dshr-rowTitle{color:var(--dsw-alias-label-secondary)}
      .dshr-pin{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
      .dshr-rowNext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
      .dshr-rowMeta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:3px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
      .dshr-freshness{padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dshr-freshness[data-freshness=fresh]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
      .dshr-freshness[data-freshness=warm]{color:var(--dsw-alias-state-business-primary)}
      .dshr-freshness[data-freshness=stale]{color:var(--dsw-alias-state-warn-primary)}
      .dshr-stars{font-size:12px;line-height:18px;letter-spacing:.5px;color:var(--dsw-alias-label-caption)}
      .dshr-starsFilled{color:var(--dsw-alias-state-warn-primary)}
      .dshr-sessionChips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
      .dshr-sessionChip{max-width:200px;height:22px;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:none;color:var(--dsw-alias-link);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
      .dshr-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:56px 20px;color:var(--dsw-alias-label-tertiary);font-size:14px}
      .dshr-emptyGlyph{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:12px;color:var(--dsw-alias-label-caption)}
      .dshr-emptyTitle{margin:0 0 6px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-secondary)}
      .dshr-emptyBody{max-width:380px;margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
      .dshr-emptyActions{display:flex;gap:8px;margin-top:16px}
      .dshr-notice{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:0 0 16px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
      .dshr-notice p{flex:1;min-width:0;margin:0}
      .dshr-notice--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .dshr-loading{display:flex;align-items:center;gap:8px;padding:40px 8px;color:var(--dsw-alias-label-tertiary);font-size:13px}
      .dshr-detail{display:flex;flex-direction:column;flex:0 0 380px;min-width:0;min-height:0;border-left:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base)}
      .dshr-detailBody{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
      .dshr-detailHeader{display:flex;align-items:center;gap:8px;flex:none;padding:14px 20px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
      .dshr-detailTitle{flex:1;min-width:0;margin:0;font-size:14px;font-weight:500;line-height:22px}
      .dshr-detailMeta{margin-top:10px;padding:0 20px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .dshr-editorScroll{flex:1;min-height:0;overflow:auto;padding:14px 20px 20px;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) var(--dsw-alias-bg-base)}
      .dshr-field{display:flex;flex-direction:column;gap:6px;min-width:0;margin-bottom:16px}
      .dshr-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dshr-input,.dshr-select,.dshr-textarea{box-sizing:border-box;width:100%;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none;transition:border-color .15s}
      .dshr-input{height:32px}
      .dshr-select{height:32px}
      .dshr-textarea{min-height:64px;resize:vertical}
      .dshr-input::placeholder,.dshr-textarea::placeholder{color:var(--dsw-alias-label-caption)}
      .dshr-input:focus-visible,.dshr-select:focus-visible,.dshr-textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
      .dshr-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
      .dshr-fieldError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
      .dshr-segmented{display:flex;flex-wrap:wrap;gap:4px}
      .dshr-segBtn{flex:1 1 auto;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
      .dshr-segBtn[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
      .dshr-rangeRow{display:flex;align-items:center;gap:10px}
      .dshr-range{flex:1;min-width:0;height:20px;accent-color:var(--dsw-alias-brand-primary)}
      .dshr-value{min-width:38px;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
      .dshr-starsBtns{display:flex;gap:2px}
      .dshr-starBtn{width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-caption);font-size:16px;line-height:1;cursor:pointer}
      .dshr-starBtn[aria-pressed=true]{color:var(--dsw-alias-state-warn-primary)}
      .dshr-checkRow{display:flex;align-items:center;gap:8px;cursor:pointer}
      .dshr-checkbox{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
      .dshr-groupField{display:flex;align-items:center;gap:6px}
      .dshr-groupField .dshr-select{flex:1;min-width:0;width:auto}
      .dshr-inlineCreate{display:flex;gap:6px;margin-top:6px}
      .dshr-inlineCreate .dshr-input{flex:1;min-width:0}
      .dshr-sessionList{display:flex;flex-wrap:wrap;gap:4px}
      .dshr-editorSessionsEmpty{margin:0;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
      .dshr-editorFooter{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;padding:12px 20px;border-top:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base)}
      .dshr-editorFooterHint{flex:1;min-width:120px;margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
      .dshr-spacer{flex:1}
      .dshr-spinner{flex:none;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:dshr-spin .8s linear infinite}
      .dshr-pulseDot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);animation:dshr-pulse 1.2s ease-in-out infinite}
      .dshr-toast{box-sizing:border-box;position:fixed;top:12px;right:12px;z-index:40;width:290px;max-width:calc(100vw - 24px);max-height:42vh;overflow:hidden;padding:9px 11px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;pointer-events:auto;transition:opacity .32s ease,transform .32s ease}
      .dshr-toast--fading{opacity:0;transform:translateY(-4px);pointer-events:none}
      .dshr-toastScroll{max-height:calc(42vh - 24px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) var(--dsw-alias-bg-base)}
      .dshr-toastTimer{position:absolute;top:0;left:0;right:0;height:2px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);pointer-events:none}
      .dshr-toastTimerFill{height:100%;background:var(--dsw-alias-state-business-primary);transition:width .12s linear}
      .dshr-toastTimerFill--indeterminate{width:40%;animation:dshr-indeterminate 1.2s ease-in-out infinite}
      .dshr-toast[data-paused=true] .dshr-toastTimerFill{opacity:.6}
      .dshr-toastHead{display:flex;align-items:center;gap:6px;min-width:0}
      .dshr-toastTitle{flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:19px}
      .dshr-toastBody{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
      .dshr-toastErrorText{margin:6px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:19px;overflow-wrap:anywhere}
      .dshr-progress{position:relative;height:3px;margin-top:8px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-3)}
      .dshr-progress::after{content:"";position:absolute;top:0;bottom:0;width:40%;border-radius:999px;background:var(--dsw-alias-state-business-primary);animation:dshr-indeterminate 1.2s ease-in-out infinite}
      .dshr-toastChanges{display:flex;flex-direction:column;gap:3px;max-height:104px;margin:7px 0 0;padding:0;overflow:auto;list-style:none}
      .dshr-change{display:flex;align-items:center;gap:5px;min-width:0;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
      .dshr-changeTop{display:flex;align-items:center;gap:6px;min-width:0}
      .dshr-kindBadge{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
      .dshr-kindBadge[data-kind=created]{color:var(--dsw-alias-state-success-primary)}
      .dshr-kindBadge[data-kind=updated]{color:var(--dsw-alias-state-business-primary)}
      .dshr-kindBadge[data-kind=attention]{color:var(--dsw-alias-state-warn-primary)}
      .dshr-changeTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px}
            .dshr-changeActions{display:flex;flex:none;justify-content:flex-end;gap:1px;margin-left:auto}
      .dshr-toastFooter{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:5px;margin-top:7px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2)}
      .dshr-toastFooter .dshr-btn{height:24px;padding:0 8px;font-size:12px}
      .dshr-toastChanges .dshr-btn--small{height:20px;padding:0 5px;font-size:11px;line-height:16px}
      .dshr-toast .dshr-iconBtn{width:22px;height:22px;font-size:14px}
      .dshr-page button:focus-visible,.dshr-page input:focus-visible,.dshr-page textarea:focus-visible,.dshr-page select:focus-visible,.dshr-page [role=button]:focus-visible,.dshr-toast button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      @media (hover:hover){
        .dshr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
        .dshr-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
        .dshr-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dshr-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dshr-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dshr-searchInput:hover{border-color:var(--dsw-alias-border-l2)}
        .dshr-input:hover,.dshr-select:hover,.dshr-textarea:hover{border-color:var(--dsw-alias-border-l2)}
        .dshr-sessionChip:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dshr-starBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
      }
      @media (width<=900px){
        .dshr-page[data-detail=true] .dshr-listPane{display:none}
        .dshr-detail{flex-basis:100%;border-left:0}
      }
      @media (width<=560px){
        .dshr-pageContent{padding-inline:16px}
        .dshr-headingActions{width:100%}
        .dshr-toast{top:8px;right:8px;width:calc(100vw - 16px);max-width:calc(100vw - 16px)}
      }
      @media (pointer:coarse){
        .dshr-searchInput,.dshr-input,.dshr-textarea,.dshr-select{font-size:16px}
      }
      @media (prefers-reduced-motion:reduce){
        .dshr-spinner,.dshr-pulseDot,.dshr-progress::after,.dshr-toastTimerFill--indeterminate{animation:none}
        .dshr-progress::after{left:0;width:100%}
        .dshr-toast{transition:none}
        .dshr-toastTimerFill{transition:none}
        .dshr-toast--fading{transform:none}
      }
      @keyframes dshr-spin{to{transform:rotate(360deg)}}
      @keyframes dshr-pulse{0%,100%{opacity:.35}50%{opacity:1}}
      @keyframes dshr-indeterminate{0%{left:-40%}100%{left:100%}}
    `;

    // -------------------------------------------------------------------
    // Plugin wiring
    // -------------------------------------------------------------------
    const inject = ['slots', 'locale', 'layout', 'uiWorkspace'];

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return function noop() {};
      const tag = document.createElement('style');
      tag.dataset.dshReminders = 'styles';
      tag.textContent = STYLE_TEXT;
      document.head.appendChild(tag);
      return function removeStyle() {
        try {
          tag.remove();
        } catch (_error) {
          // The document may be tearing down; nothing else to do.
        }
      };
    }

    function apply(ctx) {
      hostBridge = {
        selectPanel: function selectPanel() {
          ctx.layout.selectPanel(PANEL_ID);
        },
        openSession: function openSession(sessionId) {
          const id = str(sessionId);
          if (!id) return;
          ctx.uiWorkspace.openSession(id);
        },
      };

      ctx.effect(function registerDictionaries() {
        return ctx.locale.register(NS, { en: DICT_EN, zh: DICT_ZH });
      }, 'dsh-reminders: dictionaries');

      const t = ctx.locale.bind(NS);

      ctx.effect(function registerStyles() {
        return installStyles();
      }, 'dsh-reminders: styles');

      ctx.effect(function stopPollingOnDispose() {
        return function disposePolling() {
          stopPolling();
        };
      }, 'dsh-reminders: polling');

      ctx.slots.inject('main', function registerMain() {
        return ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, RemindersPage);
      });

      ctx.slots.inject('sidebar.panellist', function registerPanellist() {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: function label() {
            return t('panel');
          },
        }, RemindersIcon);
      });

      ctx.slots.inject('shell.overlay', function registerOverlay() {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: TOAST_ID,
          order: 100,
          locale: NS,
        }, DreamToast);
      });
    }

    return { inject: inject, apply: apply };
  },
});
