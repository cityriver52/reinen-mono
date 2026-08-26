/**
 * Re:年モノ - container-bound configuration / menu UX
 *
 * 日常運用では Apps Script エディタを開かない。
 * 配布先ごとに変わる設定は Config シートを唯一の編集箇所とする。
 */

const REINEN_SHEET_CONFIG = Object.freeze({
  CONFIG_SHEET: 'Config',
  DATA_SHEET: 'Data',
  STATE_SHEET: 'State',

  WEB_APP_URL_CELL: 'B15',
  CHAT_WEBHOOK_URL_CELL: 'B16',
  WEEKLY_DAY_CELL: 'B17',
  WEEKLY_HOUR_CELL: 'D17',

  FOLDER_HEADER_ROW: 23,
  FOLDER_FIRST_ROW: 24,
  FOLDER_LAST_ROW: 43,
  USER_HEADER_ROW: 47,
  USER_FIRST_ROW: 48,
  USER_LAST_ROW: 67,
});

const REINEN_PROPERTY_DEFAULTS = Object.freeze({
  SPREADSHEET_ID: '',
  ACTION_SECRET: '__GENERATE__',
  UPCOMING_DAYS: '21',
  WEEKLY_MAX_ITEMS: '3',
  SNOOZE_DAYS: '14',
  MAX_OVERDUE_ALERTS_PER_RUN: '1',
  SEASONAL_WINDOW_DAYS: '21',
  MIN_SEASONAL_ACTIVE_DAYS: '2',
  MIN_SEASONAL_EDIT_ACTIVITIES: '3',
  MIN_SEASONAL_LIFT: '2',
  MAX_RESULTS: '50',
  PAGE_SIZE: '100',
  MAX_PAGES: '500',
});

const REINEN_DEPRECATED_PROPERTIES = Object.freeze([
  'CHAT_WEBHOOK_URL',
  'WEB_APP_URL',
  'WEEKLY_DAY',
  'WEEKLY_HOUR',
  'SEASONAL_COMPARISON_DAYS',
  'MIN_SEASONAL_ACTIVITY_SHARE',
]);

const REINEN_WEEKDAY_MAP = Object.freeze({
  '月曜日': 'MONDAY',
  '火曜日': 'TUESDAY',
  '水曜日': 'WEDNESDAY',
  '木曜日': 'THURSDAY',
  '金曜日': 'FRIDAY',
  '土曜日': 'SATURDAY',
  '日曜日': 'SUNDAY',
  MONDAY: 'MONDAY',
  TUESDAY: 'TUESDAY',
  WEDNESDAY: 'WEDNESDAY',
  THURSDAY: 'THURSDAY',
  FRIDAY: 'FRIDAY',
  SATURDAY: 'SATURDAY',
  SUNDAY: 'SUNDAY',
});

function onOpen() {
  const ui = SpreadsheetApp.getUi();

  const setupMenu = ui.createMenu('セットアップ')
    .addItem('① Chat接続テスト', 'menuTestChatConnection')
    .addItem('② 対象範囲を検証・反映', 'menuRefreshConfig')
    .addItem('③ 実データ通知テスト', 'menuTestWeeklyDigest')
    .addItem('④ 週次トリガーを設定', 'menuSetupWeeklyTrigger');

  const operationMenu = ui.createMenu('運用')
    .addItem('集計を更新', 'menuRunReinenMono')
    .addItem('週次通知を今すぐ実行', 'menuRunWeeklyDigest')
    .addItem('履歴診断', 'menuDiagnoseHistory')
    .addSeparator()
    .addItem('Configを再構築', 'menuInitialSetup');

  ui.createMenu('Re:年モノ')
    .addSubMenu(setupMenu)
    .addSubMenu(operationMenu)
    .addToUi();
}

/**
 * Configを再構築する。既存入力は保持する。
 * 通常の利用者は配布済みテンプレートを使うため、原則この操作は不要。
 */
function setupReinenMonoWorkbook() {
  const ss = requireActiveBoundSpreadsheet_();
  const config = getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.CONFIG_SHEET);
  const preserved = captureExistingConfigInputs_(config);

  // 旧バージョンのScript Propertiesに設定があれば、Configへ一度だけ移行する。
  const props = PropertiesService.getScriptProperties();
  const legacyNotification = {
    webAppUrl: String(props.getProperty('WEB_APP_URL') || '').trim(),
    chatWebhookUrl: String(props.getProperty('CHAT_WEBHOOK_URL') || '').trim(),
    weekday: String(props.getProperty('WEEKLY_DAY') || '').trim(),
    hour: String(props.getProperty('WEEKLY_HOUR') || '').trim(),
  };

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  setupScriptProperties_();

  preserved.notification = preserved.notification || {};
  preserved.notification.webAppUrl = preserved.notification.webAppUrl || legacyNotification.webAppUrl;
  preserved.notification.chatWebhookUrl = preserved.notification.chatWebhookUrl || legacyNotification.chatWebhookUrl;
  preserved.notification.weekday = preserved.notification.weekday || legacyNotification.weekday || '月曜日';
  preserved.notification.hour = preserved.notification.hour || legacyNotification.hour || '9';

  initializeConfigSheet_(config, preserved);
  initializeDataSheet_(getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.DATA_SHEET));
  initializeStateSheet_(getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.STATE_SHEET));

  const legacyData = ss.getSheetByName('おすすめ');
  if (legacyData) ss.deleteSheet(legacyData);

  ss.setActiveSheet(config);
  SpreadsheetApp.flush();
  ss.toast('Configを再構築しました。設定値を確認してください。', 'Re:年モノ', 6);
  return ss.getUrl();
}

/**
 * メニュー操作時に内部インフラを自動補完する。
 * 利用者がApps Scriptエディタを開いて初期化関数を実行する必要はない。
 */
function ensureReinenInfrastructure_() {
  const ss = requireActiveBoundSpreadsheet_();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  setupScriptProperties_();
  initializeDataSheetIfNeeded_(getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.DATA_SHEET));
  initializeStateSheet_(getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.STATE_SHEET));
  return ss;
}

function setupScriptProperties_() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperties();
  const updates = {};

  Object.keys(REINEN_PROPERTY_DEFAULTS).forEach((key) => {
    if (key === 'SPREADSHEET_ID') return;
    if (Object.prototype.hasOwnProperty.call(current, key)) return;
    const defaultValue = REINEN_PROPERTY_DEFAULTS[key];
    updates[key] = defaultValue === '__GENERATE__'
      ? `${Utilities.getUuid()}-${Utilities.getUuid()}`
      : defaultValue;
  });

  if (Object.keys(updates).length > 0) props.setProperties(updates, false);
  REINEN_DEPRECATED_PROPERTIES.forEach((key) => props.deleteProperty(key));
}

function refreshReinenConfig() {
  const ss = ensureReinenInfrastructure_();
  const sheet = requireConfigSheet_(ss);

  const notification = readReinenNotificationConfig_(sheet);
  validateReinenNotificationConfig_(notification, {
    requireWebApp: true,
    requireWebhook: true,
    requireSchedule: true,
  });

  refreshFolderRows_(sheet);
  refreshUserRows_(sheet);

  const runtime = readReinenRuntimeConfig_();
  SpreadsheetApp.flush();
  const summary = `対象フォルダ: ${runtime.folders.length} / 対象ユーザー: ${runtime.users.length}`;
  ss.toast(summary, 'Re:年モノ', 6);
  return summary;
}

// ---------- menu wrappers ----------

function menuInitialSetup() {
  return runMenuAction_('Config再構築', () => setupReinenMonoWorkbook());
}

function menuTestChatConnection() {
  return runMenuAction_('Chat接続テスト', () => {
    ensureReinenInfrastructure_();
    const sheet = requireConfigSheet_(getReinenSpreadsheet_());
    const notification = readReinenNotificationConfig_(sheet);
    validateReinenNotificationConfig_(notification, {
      requireWebhook: true,
      requireWebApp: false,
      requireSchedule: false,
    });
    return sendTestReinenNotification();
  });
}

function menuRefreshConfig() {
  return runMenuAction_('対象範囲の検証・反映', () => refreshReinenConfig());
}

function menuTestWeeklyDigest() {
  return runMenuAction_('実データ通知テスト', () => {
    ensureReinenInfrastructure_();
    const result = runWeeklyReinenDigest();
    return `通常 ${result.weeklyItems}件 / 開始時期超過 ${result.overdueAlerts}件を処理しました。`;
  });
}

function menuSetupWeeklyTrigger() {
  return runMenuAction_('週次トリガー設定', () => {
    ensureReinenInfrastructure_();
    return setupWeeklyReinenTrigger();
  });
}

function menuRunReinenMono() {
  return runMenuAction_('集計更新', () => {
    ensureReinenInfrastructure_();
    const result = runReinenMono();
    return `候補 ${result.count}件（比較年度: ${result.comparisonFiscalYear}年度）`;
  });
}

function menuRunWeeklyDigest() {
  return runMenuAction_('週次通知', () => {
    ensureReinenInfrastructure_();
    const result = runWeeklyReinenDigest();
    return `通常 ${result.weeklyItems}件 / 開始時期超過 ${result.overdueAlerts}件`;
  });
}

function menuDiagnoseHistory() {
  const ui = SpreadsheetApp.getUi();
  try {
    ensureReinenInfrastructure_();
    const result = diagnoseHistory();
    const top = (result.top20 || []).slice(0, 5).map((item, index) => {
      const title = item.title || item.fileId || '(無題)';
      const lift = Number(item.seasonalLift || 0).toFixed(1);
      return `${index + 1}. ${title}（他時期比 ${lift}倍）`;
    });
    ui.alert(
      '履歴診断',
      [
        `比較年度: ${result.comparisonFiscalYear}年度`,
        `取得ファイル: ${result.filesFound}件`,
        '',
        '季節性上位:',
        ...(top.length ? top : ['該当なし']),
      ].join('\n'),
      ui.ButtonSet.OK
    );
    return result;
  } catch (error) {
    showMenuError_('履歴診断', error);
    throw error;
  }
}

function runMenuAction_(label, action) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const result = action();
    const message = typeof result === 'string' ? result : `${label}が完了しました。`;
    if (ss) ss.toast(message, 'Re:年モノ', 6);
    return result;
  } catch (error) {
    showMenuError_(label, error);
    throw error;
  }
}

function showMenuError_(label, error) {
  SpreadsheetApp.getUi().alert(
    `${label}でエラー`,
    String(error && error.message ? error.message : error),
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ---------- Config sheet ----------

function captureExistingConfigInputs_(sheet) {
  const result = { folders: [], users: [], notification: {} };
  if (!sheet) return result;

  try {
    const marker = sheet.getRange('A1').getDisplayValue();
    if (marker === 'Re:年モノ 設定') {
      // 新レイアウト
      const newFolderHeader = sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_HEADER_ROW, 1).getDisplayValue();
      if (newFolderHeader.indexOf('フォルダURL') >= 0) {
        result.notification = readReinenNotificationConfig_(sheet);
        result.folders = sheet
          .getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, 20, 1)
          .getDisplayValues().flat().map((v) => String(v || '').trim()).filter(Boolean);
        result.users = sheet
          .getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, 20, 1)
          .getDisplayValues().flat().map((v) => normalizeEmail_(v)).filter(Boolean);
        return result;
      }

      // 直前バージョンのレイアウト
      const legacyHeader = sheet.getRange(6, 1).getDisplayValue();
      if (legacyHeader.indexOf('フォルダURL') >= 0) {
        result.folders = sheet.getRange(7, 1, 20, 1).getDisplayValues().flat()
          .map((v) => String(v || '').trim()).filter(Boolean);
        result.users = sheet.getRange(31, 1, 20, 1).getDisplayValues().flat()
          .map((v) => normalizeEmail_(v)).filter(Boolean);
        return result;
      }
    }
  } catch (error) {}

  return result;
}

function initializeConfigSheet_(sheet, preserved) {
  const preservedFolders = (preserved && preserved.folders) || [];
  const preservedUsers = (preserved && preserved.users) || [];
  const notification = (preserved && preserved.notification) || {};

  sheet.clear();
  sheet.clearConditionalFormatRules();

  sheet.getRange('A1:D1').merge();
  sheet.getRange('A1')
    .setValue('Re:年モノ 設定')
    .setFontSize(16)
    .setFontWeight('bold');

  sheet.getRange('A3:D3').merge().setValue('セットアップ手順').setFontWeight('bold');
  sheet.getRange('A4:D11').merge();
  sheet.getRange('A4')
    .setValue([
      '1. スプレッドシートを開く',
      '2. Apps Script を Webアプリとしてデプロイする',
      '3. 通知先の Google Chat スペースで Incoming Webhook を作成する',
      '4. 下の「通知設定」に WebアプリURL と Webhook URL を入力する',
      '5. Re:年モノ > セットアップ > ① Chat接続テスト',
      '6. 対象フォルダURLと対象ユーザーのメールアドレスを入力する',
      '7. Re:年モノ > セットアップ > ② 対象範囲を検証・反映',
      '8. Re:年モノ > セットアップ > ③ 実データ通知テスト',
      '9. Re:年モノ > セットアップ > ④ 週次トリガーを設定',
    ].join('\n'))
    .setWrap(true)
    .setFontColor('#5f6368');

  sheet.getRange('A13:D13').merge().setValue('通知設定').setFontWeight('bold');
  sheet.getRange('A15').setValue('WebアプリURL');
  sheet.getRange('A16').setValue('Chat Webhook URL');
  sheet.getRange('A17').setValue('週次通知曜日');
  sheet.getRange('C17').setValue('時間帯（0〜23時）');

  sheet.getRange('B15:D15').merge();
  sheet.getRange('B16:D16').merge();
  sheet.getRange('B15:D17').setBackground('#fff2cc');
  sheet.getRange('B15').setValue(notification.webAppUrl || '');
  sheet.getRange('B16').setValue(notification.chatWebhookUrl || '');
  sheet.getRange('B17').setValue(displayWeekday_(notification.weekday || '月曜日'));
  sheet.getRange('D17').setValue(normalizeHourValue_(notification.hour, 9));

  const weekdayRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['月曜日','火曜日','水曜日','木曜日','金曜日','土曜日','日曜日'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange('B17').setDataValidation(weekdayRule);

  const hourRule = SpreadsheetApp.newDataValidation()
    .requireNumberBetween(0, 23)
    .setAllowInvalid(false)
    .build();
  sheet.getRange('D17').setDataValidation(hourRule).setNumberFormat('0');

  sheet.getRange('A19:D20').merge();
  sheet.getRange('A19')
    .setValue('黄色セルは配布先ごとに編集する設定です。Webhook URL は通知先スペース固有、WebアプリURLは各コピーのデプロイURLです。曜日・時間帯を変更した場合は「④ 週次トリガーを設定」を再実行してください。')
    .setWrap(true)
    .setFontColor('#5f6368');

  sheet.getRange('A22:D22').merge().setValue('対象フォルダ').setFontWeight('bold');
  sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_HEADER_ROW, 1, 1, 4)
    .setValues([['フォルダURL / ID（入力）', '表示名（自動）', 'Folder ID（自動）', '状態（自動）']])
    .setFontWeight('bold')
    .setBackground('#eeeeee');

  const folderRows = 20;
  const folderInputRange = sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, folderRows, 1);
  folderInputRange.setBackground('#fff2cc');
  sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 2, folderRows, 3)
    .setBackground('#f3f3f3')
    .setFontColor('#5f6368');
  if (preservedFolders.length > 0) {
    folderInputRange.offset(0, 0, Math.min(preservedFolders.length, folderRows), 1)
      .setValues(preservedFolders.slice(0, folderRows).map((v) => [v]));
  }

  sheet.getRange('A46:D46').merge().setValue('対象ユーザー').setFontWeight('bold');
  sheet.getRange(REINEN_SHEET_CONFIG.USER_HEADER_ROW, 1, 1, 4)
    .setValues([['メールアドレス（入力）', '表示名（自動）', 'Actor ID（自動）', '状態（自動）']])
    .setFontWeight('bold')
    .setBackground('#eeeeee');

  const userRows = 20;
  const userInputRange = sheet.getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, userRows, 1);
  userInputRange.setBackground('#fff2cc');
  sheet.getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 2, userRows, 3)
    .setBackground('#f3f3f3')
    .setFontColor('#5f6368');
  if (preservedUsers.length > 0) {
    userInputRange.offset(0, 0, Math.min(preservedUsers.length, userRows), 1)
      .setValues(preservedUsers.slice(0, userRows).map((v) => [v]));
  }

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 240);
  sheet.setColumnWidth(4, 260);
  sheet.setRowHeights(4, 8, 25);
  sheet.setRowHeight(4, 36);
  sheet.getRange('A1:D70').setVerticalAlignment('middle');
}

function readReinenNotificationConfig_(sheet) {
  const weekdayRaw = String(sheet.getRange(REINEN_SHEET_CONFIG.WEEKLY_DAY_CELL).getDisplayValue() || '').trim();
  const hourRaw = sheet.getRange(REINEN_SHEET_CONFIG.WEEKLY_HOUR_CELL).getValue();
  return {
    webAppUrl: String(sheet.getRange(REINEN_SHEET_CONFIG.WEB_APP_URL_CELL).getDisplayValue() || '').trim(),
    chatWebhookUrl: String(sheet.getRange(REINEN_SHEET_CONFIG.CHAT_WEBHOOK_URL_CELL).getDisplayValue() || '').trim(),
    weekday: normalizeWeekday_(weekdayRaw || '月曜日'),
    weekdayDisplay: displayWeekday_(weekdayRaw || '月曜日'),
    hour: normalizeHourValue_(hourRaw, 9),
  };
}

function validateReinenNotificationConfig_(config, options) {
  const opts = options || {};
  if (opts.requireWebApp && !/^https:\/\/script\.google\.com\//.test(config.webAppUrl)) {
    throw new Error('ConfigのWebアプリURLを確認してください。Apps ScriptのデプロイURLを入力します。');
  }
  if (opts.requireWebhook && !/^https:\/\/chat\.googleapis\.com\//.test(config.chatWebhookUrl)) {
    throw new Error('ConfigのChat Webhook URLを確認してください。Google Chatで作成したWebhook URLを入力します。');
  }
  if (opts.requireSchedule) {
    if (!ScriptApp.WeekDay[config.weekday]) {
      throw new Error('Configの週次通知曜日を確認してください。');
    }
    if (!Number.isInteger(config.hour) || config.hour < 0 || config.hour > 23) {
      throw new Error('Configの通知時間帯は0〜23の整数で指定してください。');
    }
  }
  return true;
}

function normalizeWeekday_(value) {
  const key = String(value || '').trim();
  return REINEN_WEEKDAY_MAP[key] || String(key).toUpperCase();
}

function displayWeekday_(value) {
  const normalized = normalizeWeekday_(value);
  const found = Object.keys(REINEN_WEEKDAY_MAP).find(
    (key) => /曜日$/.test(key) && REINEN_WEEKDAY_MAP[key] === normalized
  );
  return found || '月曜日';
}

function normalizeHourValue_(value, fallback) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 23) return numeric;
  return fallback;
}

function initializeDataSheet_(sheet) {
  const headers = [
    'score','file_name','folder_path','last_year_active_days','last_year_edit_activities',
    'other_period_active_days','other_period_edit_activities','seasonal_lift',
    'seasonal_activity_share','last_year_first_activity','last_year_last_activity',
    'expected_start','timing_label','drive_url','file_id','matched_folder_ids',
    'matched_actor_ids','generated_at',
  ];
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clear();
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#eeeeee');
  sheet.setFrozenRows(1);
}

function initializeDataSheetIfNeeded_(sheet) {
  if (sheet.getRange(1, 1).getDisplayValue() !== 'score') initializeDataSheet_(sheet);
}

function initializeStateSheet_(sheet) {
  const headers = ['file_id','file_name','year','skip_this_year','snooze_until','overdue_sent_at','updated_at'];
  if (sheet.getRange(1, 1).getDisplayValue() !== 'file_id') {
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#eeeeee');
    sheet.setFrozenRows(1);
  }
}

function refreshFolderRows_(sheet) {
  const rowCount = 20;
  const inputs = sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, rowCount, 1).getDisplayValues();
  sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 2, rowCount, 3).clearContent();

  inputs.forEach((row, index) => {
    const input = String(row[0] || '').trim();
    if (!input) return;
    const outputRow = REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW + index;
    try {
      const folderId = extractFolderId_(input);
      const name = folderId === 'root' ? 'My Drive' : DriveApp.getFolderById(folderId).getName();
      sheet.getRange(outputRow, 2, 1, 3).setValues([[name, folderId, 'OK']]);
    } catch (error) {
      sheet.getRange(outputRow, 4).setValue(`エラー: ${error.message}`);
    }
  });
}

function refreshUserRows_(sheet) {
  const rowCount = 20;
  const inputs = sheet.getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, rowCount, 1).getDisplayValues();
  sheet.getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 2, rowCount, 3).clearContent();

  inputs.forEach((row, index) => {
    const email = normalizeEmail_(row[0]);
    if (!email) return;
    const outputRow = REINEN_SHEET_CONFIG.USER_FIRST_ROW + index;
    try {
      const person = resolveDirectoryPersonByEmail_(email);
      sheet.getRange(outputRow, 2, 1, 3).setValues([[person.displayName || email, person.resourceName, 'OK']]);
    } catch (error) {
      sheet.getRange(outputRow, 4).setValue(`エラー: ${error.message}`);
    }
  });
}

function readReinenRuntimeConfig_() {
  const ss = getReinenSpreadsheet_();
  const sheet = requireConfigSheet_(ss);
  const folders = readSelectedFolders_(sheet);
  const users = readSelectedUsers_(sheet);

  if (folders.length === 0) throw new Error('Configに対象フォルダURLを1件以上入力してください。');
  if (users.length === 0) throw new Error('Configに対象ユーザーのメールアドレスを1件以上入力してください。');

  const effectiveFolders = folders.some((folder) => folder.id === 'root')
    ? [folders.find((folder) => folder.id === 'root')]
    : uniqueBy_(folders, (folder) => folder.id);

  const allowedActorIds = new Set();
  const ownEmail = normalizeEmail_(Session.getActiveUser().getEmail());
  users.forEach((user) => {
    allowedActorIds.add(user.actorId);
    if (ownEmail && user.email === ownEmail) allowedActorIds.add('people/me');
  });

  return { spreadsheet: ss, configSheet: sheet, folders: effectiveFolders, users, allowedActorIds };
}

function readSelectedFolders_(sheet) {
  return sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, 20, 4).getDisplayValues()
    .filter((row) => String(row[0] || '').trim())
    .map((row) => {
      const input = String(row[0] || '').trim();
      const id = String(row[2] || '').trim() || extractFolderId_(input);
      const name = String(row[1] || '').trim() || (id === 'root' ? 'My Drive' : DriveApp.getFolderById(id).getName());
      return { id, name, input };
    });
}

function readSelectedUsers_(sheet) {
  return sheet.getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, 20, 4).getDisplayValues()
    .filter((row) => normalizeEmail_(row[0]))
    .map((row) => {
      const email = normalizeEmail_(row[0]);
      let displayName = String(row[1] || '').trim();
      let actorId = String(row[2] || '').trim();
      if (!actorId) {
        const person = resolveDirectoryPersonByEmail_(email);
        displayName = person.displayName || email;
        actorId = person.resourceName;
      }
      if (!/^people\//.test(actorId)) {
        throw new Error(`${email}: Actor IDを解決できません。Configを更新してください。`);
      }
      return { email, displayName: displayName || email, actorId };
    });
}

function resolveDirectoryPersonByEmail_(email) {
  let response;
  try {
    response = People.People.searchDirectoryPeople({
      query: email,
      readMask: 'names,emailAddresses',
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
      pageSize: 20,
    });
  } catch (error) {
    throw new Error('People APIでユーザーを検索できません。People APIと directory.readonly 権限を確認してください。');
  }

  const normalized = normalizeEmail_(email);
  const exact = (response.people || []).find((person) =>
    (person.emailAddresses || []).some((entry) => normalizeEmail_(entry.value) === normalized)
  );
  if (!exact || !exact.resourceName) throw new Error(`${email} を社内ディレクトリで特定できませんでした。`);

  return {
    resourceName: exact.resourceName,
    displayName: exact.names && exact.names.length ? exact.names[0].displayName || '' : '',
  };
}

function getReinenSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error('SPREADSHEET_ID が未設定です。管理スプレッドシートのRe:年モノメニューを一度実行してください。');
  }
  return SpreadsheetApp.openById(id);
}

function requireActiveBoundSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('この操作はRe:年モノ管理スプレッドシートから実行してください。');
  return ss;
}

function requireConfigSheet_(ss) {
  const sheet = ss.getSheetByName(REINEN_SHEET_CONFIG.CONFIG_SHEET);
  if (!sheet) throw new Error('Configシートがありません。配布元テンプレートを確認してください。');
  return sheet;
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function extractFolderId_(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('フォルダURLまたはIDが空です。');
  if (text === 'root') return 'root';
  const urlMatch = text.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  throw new Error('Google DriveフォルダのURLまたはIDとして読み取れません。');
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqueBy_(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
