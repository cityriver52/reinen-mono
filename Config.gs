/**
 * Re:年モノ - container-bound configuration / menu UX
 *
 * 日常運用では Apps Script エディタを開かない。
 * Config シートへ対象フォルダURL / ID と対象ユーザーメールを入力し、
 * カスタムメニューから設定反映・集計・通知・トリガー設定を実行する。
 */

const REINEN_SHEET_CONFIG = Object.freeze({
  CONFIG_SHEET: 'Config',
  DATA_SHEET: 'Data',
  STATE_SHEET: 'State',
  FOLDER_HEADER_ROW: 6,
  FOLDER_FIRST_ROW: 7,
  FOLDER_LAST_ROW: 26,
  USER_HEADER_ROW: 30,
  USER_FIRST_ROW: 31,
  USER_LAST_ROW: 50,
});

const REINEN_PROPERTY_DEFAULTS = Object.freeze({
  SPREADSHEET_ID: '',
  CHAT_WEBHOOK_URL: '',
  WEB_APP_URL: '',
  ACTION_SECRET: '__GENERATE__',
  WEEKLY_DAY: 'MONDAY',
  WEEKLY_HOUR: '9',
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
  'SEASONAL_COMPARISON_DAYS',
  'MIN_SEASONAL_ACTIVITY_SHARE',
]);

function onOpen() {
  const ui = SpreadsheetApp.getUi();

  const setupMenu = ui.createMenu('セットアップ')
    .addItem('初期セットアップ / 再構築', 'menuInitialSetup_')
    .addItem('① Configを検証・反映', 'menuRefreshConfig_')
    .addItem('履歴診断', 'menuDiagnoseHistory_');

  const operationMenu = ui.createMenu('集計・通知')
    .addItem('② 集計を更新', 'menuRunReinenMono_')
    .addItem('③ Chatテスト通知', 'menuSendTestNotification_')
    .addItem('④ 週次通知を今すぐ実行', 'menuRunWeeklyDigest_')
    .addItem('⑤ 週次トリガーを設定', 'menuSetupWeeklyTrigger_');

  ui.createMenu('Re:年モノ')
    .addSubMenu(setupMenu)
    .addSubMenu(operationMenu)
    .addToUi();
}

/**
 * 初回・再構築用。
 * Config入力は保持し、Script Properties / Data / State を整える。
 */
function setupReinenMonoWorkbook() {
  const ss = requireActiveBoundSpreadsheet_();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  setupScriptProperties_();

  const config = getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.CONFIG_SHEET);
  const preserved = captureExistingConfigInputs_(config);
  initializeConfigSheet_(config, preserved);
  initializeDataSheet_(getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.DATA_SHEET));
  initializeStateSheet_(getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.STATE_SHEET));

  const legacyData = ss.getSheetByName('おすすめ');
  if (legacyData) ss.deleteSheet(legacyData);

  ss.setActiveSheet(config);
  SpreadsheetApp.flush();
  ss.toast(
    'セットアップ完了。黄色セルへ入力後「Re:年モノ > セットアップ > ① Configを検証・反映」を実行してください。',
    'Re:年モノ',
    8
  );
  return ss.getUrl();
}

/**
 * Config反映時にも不足インフラを補完する。
 * これにより、通常は別途セットアップ関数をエディタから実行する必要がない。
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
  refreshFolderRows_(sheet);
  refreshUserRows_(sheet);

  const runtime = readReinenRuntimeConfig_();
  SpreadsheetApp.flush();
  const summary = `対象フォルダ: ${runtime.folders.length} / 対象ユーザー: ${runtime.users.length}`;
  ss.toast(summary, 'Re:年モノ', 6);
  return summary;
}

// ---------- menu wrappers ----------

function menuInitialSetup_() {
  return runMenuAction_('初期セットアップ', () => setupReinenMonoWorkbook());
}

function menuRefreshConfig_() {
  return runMenuAction_('Config反映', () => refreshReinenConfig());
}

function menuRunReinenMono_() {
  return runMenuAction_('集計更新', () => {
    ensureReinenInfrastructure_();
    const result = runReinenMono();
    return `候補 ${result.count}件（比較年度: ${result.comparisonFiscalYear}年度）`;
  });
}

function menuSendTestNotification_() {
  return runMenuAction_('Chatテスト通知', () => {
    ensureReinenInfrastructure_();
    return sendTestReinenNotification();
  });
}

function menuRunWeeklyDigest_() {
  return runMenuAction_('週次通知', () => {
    ensureReinenInfrastructure_();
    const result = runWeeklyReinenDigest();
    return `通常 ${result.weeklyItems}件 / 開始時期超過 ${result.overdueAlerts}件`;
  });
}

function menuSetupWeeklyTrigger_() {
  return runMenuAction_('週次トリガー設定', () => {
    ensureReinenInfrastructure_();
    return setupWeeklyReinenTrigger();
  });
}

function menuDiagnoseHistory_() {
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
    const message = typeof result === 'string'
      ? result
      : `${label}が完了しました。`;
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
  const result = { folders: [], users: [] };
  if (!sheet) return result;

  try {
    const marker = sheet.getRange('A1').getDisplayValue();
    const newHeader = sheet.getRange(REINEN_SHEET_CONFIG.FOLDER_HEADER_ROW, 1).getDisplayValue();
    if (marker === 'Re:年モノ 設定' && newHeader.indexOf('フォルダURL') >= 0) {
      result.folders = sheet
        .getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, 20, 1)
        .getDisplayValues()
        .flat()
        .map((v) => String(v || '').trim())
        .filter(Boolean);
      result.users = sheet
        .getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, 20, 1)
        .getDisplayValues()
        .flat()
        .map((v) => normalizeEmail_(v))
        .filter(Boolean);
      return result;
    }
  } catch (error) {}

  // 古いレイアウトからの移行
  try {
    result.folders = sheet.getRange(9, 3, 20, 1).getDisplayValues().flat()
      .map((v) => String(v || '').trim()).filter(Boolean);
    result.users = sheet.getRange(33, 3, 20, 1).getDisplayValues().flat()
      .map((v) => normalizeEmail_(v)).filter(Boolean);
  } catch (error) {}
  return result;
}

function initializeConfigSheet_(sheet, preserved) {
  const preservedFolders = (preserved && preserved.folders) || [];
  const preservedUsers = (preserved && preserved.users) || [];
  sheet.clear();
  sheet.clearConditionalFormatRules();

  sheet.getRange('A1:D1').merge();
  sheet.getRange('A1')
    .setValue('Re:年モノ 設定')
    .setFontSize(16)
    .setFontWeight('bold');

  sheet.getRange('A2:D2').merge();
  sheet.getRange('A2')
    .setValue('黄色のセルだけ入力します。入力後はメニュー「Re:年モノ > セットアップ > ① Configを検証・反映」を実行してください。Apps Scriptファイルを開く必要はありません。')
    .setWrap(true)
    .setFontColor('#5f6368');

  sheet.getRange('A4:D4').merge().setValue('対象フォルダ').setFontWeight('bold');
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
    folderInputRange
      .offset(0, 0, Math.min(preservedFolders.length, folderRows), 1)
      .setValues(preservedFolders.slice(0, folderRows).map((v) => [v]));
  }

  sheet.getRange('A28:D28').merge().setValue('対象ユーザー').setFontWeight('bold');
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
    userInputRange
      .offset(0, 0, Math.min(preservedUsers.length, userRows), 1)
      .setValues(preservedUsers.slice(0, userRows).map((v) => [v]));
  }

  sheet.getRange('A52:D54').merge();
  sheet.getRange('A52')
    .setValue([
      '基本操作',
      '1. 黄色セルへフォルダURLとメールアドレスを入力',
      '2. Re:年モノ > セットアップ > ① Configを検証・反映',
      '3. Re:年モノ > 集計・通知 > ② 集計を更新',
      '初回のメニュー実行時だけGoogleの権限確認が表示されることがあります。',
    ].join('\n'))
    .setWrap(true)
    .setFontColor('#5f6368');

  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 420);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidth(3, 240);
  sheet.setColumnWidth(4, 260);
  sheet.setRowHeight(2, 42);
  sheet.setRowHeights(52, 3, 28);
  sheet.getRange('A1:D54').setVerticalAlignment('middle');
}

function initializeDataSheet_(sheet) {
  const headers = [
    'score',
    'file_name',
    'folder_path',
    'last_year_active_days',
    'last_year_edit_activities',
    'other_period_active_days',
    'other_period_edit_activities',
    'seasonal_lift',
    'seasonal_activity_share',
    'last_year_first_activity',
    'last_year_last_activity',
    'expected_start',
    'timing_label',
    'drive_url',
    'file_id',
    'matched_folder_ids',
    'matched_actor_ids',
    'generated_at',
  ];
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clear();
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#eeeeee');
  sheet.setFrozenRows(1);
}

function initializeDataSheetIfNeeded_(sheet) {
  if (sheet.getRange(1, 1).getDisplayValue() !== 'score') {
    initializeDataSheet_(sheet);
  }
}

function initializeStateSheet_(sheet) {
  const headers = [
    'file_id',
    'file_name',
    'year',
    'skip_this_year',
    'snooze_until',
    'overdue_sent_at',
    'updated_at',
  ];
  if (sheet.getRange(1, 1).getDisplayValue() !== 'file_id') {
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#eeeeee');
    sheet.setFrozenRows(1);
  }
}

function refreshFolderRows_(sheet) {
  const rowCount = 20;
  const inputs = sheet
    .getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, rowCount, 1)
    .getDisplayValues();
  sheet
    .getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 2, rowCount, 3)
    .clearContent();

  inputs.forEach((row, index) => {
    const input = String(row[0] || '').trim();
    if (!input) return;
    const outputRow = REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW + index;
    try {
      const folderId = extractFolderId_(input);
      const name = folderId === 'root'
        ? 'My Drive'
        : DriveApp.getFolderById(folderId).getName();
      sheet.getRange(outputRow, 2, 1, 3).setValues([[name, folderId, 'OK']]);
    } catch (error) {
      sheet.getRange(outputRow, 4).setValue(`エラー: ${error.message}`);
    }
  });
}

function refreshUserRows_(sheet) {
  const rowCount = 20;
  const inputs = sheet
    .getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, rowCount, 1)
    .getDisplayValues();
  sheet
    .getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 2, rowCount, 3)
    .clearContent();

  inputs.forEach((row, index) => {
    const email = normalizeEmail_(row[0]);
    if (!email) return;
    const outputRow = REINEN_SHEET_CONFIG.USER_FIRST_ROW + index;
    try {
      const person = resolveDirectoryPersonByEmail_(email);
      sheet.getRange(outputRow, 2, 1, 3)
        .setValues([[person.displayName || email, person.resourceName, 'OK']]);
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

  if (folders.length === 0) {
    throw new Error('Configに対象フォルダURLを1件以上入力してください。');
  }
  if (users.length === 0) {
    throw new Error('Configに対象ユーザーのメールアドレスを1件以上入力してください。');
  }

  const effectiveFolders = folders.some((folder) => folder.id === 'root')
    ? [folders.find((folder) => folder.id === 'root')]
    : uniqueBy_(folders, (folder) => folder.id);

  const allowedActorIds = new Set();
  const ownEmail = normalizeEmail_(Session.getActiveUser().getEmail());
  users.forEach((user) => {
    allowedActorIds.add(user.actorId);
    if (ownEmail && user.email === ownEmail) allowedActorIds.add('people/me');
  });

  return {
    spreadsheet: ss,
    configSheet: sheet,
    folders: effectiveFolders,
    users,
    allowedActorIds,
  };
}

function readSelectedFolders_(sheet) {
  return sheet
    .getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, 20, 4)
    .getDisplayValues()
    .filter((row) => String(row[0] || '').trim())
    .map((row) => {
      const input = String(row[0] || '').trim();
      const id = String(row[2] || '').trim() || extractFolderId_(input);
      const name = String(row[1] || '').trim() || (
        id === 'root' ? 'My Drive' : DriveApp.getFolderById(id).getName()
      );
      return { id, name, input };
    });
}

function readSelectedUsers_(sheet) {
  return sheet
    .getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, 20, 4)
    .getDisplayValues()
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
    throw new Error(
      'People APIでユーザーを検索できません。People APIと directory.readonly 権限を確認してください。'
    );
  }

  const normalized = normalizeEmail_(email);
  const exact = (response.people || []).find((person) =>
    (person.emailAddresses || []).some(
      (entry) => normalizeEmail_(entry.value) === normalized
    )
  );

  if (!exact || !exact.resourceName) {
    throw new Error(`${email} を社内ディレクトリで特定できませんでした。`);
  }

  return {
    resourceName: exact.resourceName,
    displayName:
      exact.names && exact.names.length
        ? exact.names[0].displayName || ''
        : '',
  };
}

function getReinenSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error(
      'SPREADSHEET_ID が未設定です。スプレッドシートを開き、Re:年モノメニューから初期セットアップを実行してください。'
    );
  }
  return SpreadsheetApp.openById(id);
}

function requireActiveBoundSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('この操作はRe:年モノ管理スプレッドシートから実行してください。');
  }
  return ss;
}

function requireConfigSheet_(ss) {
  const sheet = ss.getSheetByName(REINEN_SHEET_CONFIG.CONFIG_SHEET);
  if (!sheet) {
    throw new Error(
      'Configシートがありません。Re:年モノ > セットアップ > 初期セットアップ / 再構築 を実行してください。'
    );
  }
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
