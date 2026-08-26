/**
 * RE:年モノ - container-bound configuration
 *
 * このファイルは Google Sheets にバインドされた Apps Script で使う。
 * Config シートのチェックボックスで対象フォルダ・対象ユーザーを複数選択する。
 */

const REINEN_SHEET_CONFIG = Object.freeze({
  CONFIG_SHEET: 'Config',
  RECOMMENDATIONS_SHEET: 'おすすめ',
  ALL_USERS_CELL: 'B3',
  FOLDER_HEADER_ROW: 8,
  FOLDER_FIRST_ROW: 9,
  FOLDER_LAST_ROW: 28,
  USER_HEADER_ROW: 32,
  USER_FIRST_ROW: 33,
  USER_LAST_ROW: 52,
  PROP_BOUND_SPREADSHEET_ID: 'BOUND_SPREADSHEET_ID',
});

function onOpen() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    PropertiesService.getScriptProperties().setProperty(
      REINEN_SHEET_CONFIG.PROP_BOUND_SPREADSHEET_ID,
      active.getId()
    );
  }

  SpreadsheetApp.getUi()
    .createMenu('RE:年モノ')
    .addItem('初期設定 / Configを作成', 'setupReinenMonoWorkbook')
    .addItem('設定を検証・更新', 'refreshReinenConfig')
    .addSeparator()
    .addItem('候補を更新', 'runReinenMono')
    .addItem('週次通知を今すぐ実行', 'runWeeklyReinenDigest')
    .addSeparator()
    .addItem('履歴診断', 'diagnoseHistory')
    .addToUi();
}

function setupReinenMonoWorkbook() {
  const ss = requireBoundSpreadsheet_();
  PropertiesService.getScriptProperties().setProperty(
    REINEN_SHEET_CONFIG.PROP_BOUND_SPREADSHEET_ID,
    ss.getId()
  );

  const config = getOrCreateSheet_(ss, REINEN_SHEET_CONFIG.CONFIG_SHEET);
  const recommendations = getOrCreateSheet_(
    ss,
    REINEN_SHEET_CONFIG.RECOMMENDATIONS_SHEET
  );

  if (config.getRange('A1').getDisplayValue() !== 'RE:年モノ 設定') {
    initializeConfigSheet_(config);
  }

  if (recommendations.getRange('A1').isBlank()) {
    recommendations.getRange('A1').setValue('RE:年モノ');
    recommendations.getRange('A2').setValue('候補は実行時にここへ更新されます。');
  }

  ss.setActiveSheet(config);
  SpreadsheetApp.flush();
  return ss.getUrl();
}

function refreshReinenConfig() {
  const ss = requireBoundSpreadsheet_();
  const sheet = requireConfigSheet_(ss);

  refreshFolderRows_(sheet);
  refreshUserRows_(sheet);

  const runtime = readReinenRuntimeConfig_();
  SpreadsheetApp.flush();

  const summary =
    `対象フォルダ: ${runtime.folders.length} / ` +
    `対象ユーザー: ${runtime.allUsers ? '全ユーザー' : runtime.users.length}`;
  try {
    ss.toast(summary, 'RE:年モノ', 5);
  } catch (error) {
    console.log(summary);
  }
  return summary;
}

function initializeConfigSheet_(sheet) {
  sheet.clear();
  sheet.clearConditionalFormatRules();

  sheet.getRange('A1:E1').merge();
  sheet.getRange('A1').setValue('RE:年モノ 設定');
  sheet.getRange('A1').setFontSize(16).setFontWeight('bold');

  sheet.getRange('A3').setValue('全ユーザーを対象');
  sheet.getRange(REINEN_SHEET_CONFIG.ALL_USERS_CELL).insertCheckboxes();
  sheet.getRange(REINEN_SHEET_CONFIG.ALL_USERS_CELL).setValue(false);
  sheet
    .getRange('C3:E3')
    .merge()
    .setValue('ONの場合、下のユーザー指定を無視して対象フォルダ内の全ユーザーを集計します。');

  sheet.getRange('A6:D6').merge().setValue('対象フォルダ');
  sheet.getRange('A6').setFontWeight('bold');
  sheet
    .getRange(REINEN_SHEET_CONFIG.FOLDER_HEADER_ROW, 1, 1, 4)
    .setValues([['有効', '表示名', 'フォルダURL または ID', '状態']])
    .setFontWeight('bold')
    .setBackground('#eeeeee');
  sheet
    .getRange(
      REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW,
      1,
      REINEN_SHEET_CONFIG.FOLDER_LAST_ROW - REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW + 1,
      1
    )
    .insertCheckboxes();

  sheet.getRange('A30:E30').merge().setValue('対象ユーザー');
  sheet.getRange('A30').setFontWeight('bold');
  sheet
    .getRange(REINEN_SHEET_CONFIG.USER_HEADER_ROW, 1, 1, 5)
    .setValues([['有効', '表示名', 'メールアドレス', 'Actor ID', '状態']])
    .setFontWeight('bold')
    .setBackground('#eeeeee');
  sheet
    .getRange(
      REINEN_SHEET_CONFIG.USER_FIRST_ROW,
      1,
      REINEN_SHEET_CONFIG.USER_LAST_ROW - REINEN_SHEET_CONFIG.USER_FIRST_ROW + 1,
      1
    )
    .insertCheckboxes();

  const ownEmail = String(Session.getActiveUser().getEmail() || '').trim();
  if (ownEmail) {
    sheet.getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1).setValue(true);
    sheet.getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 3).setValue(ownEmail);
  }

  sheet.getRange('A54:E55').merge();
  sheet
    .getRange('A54')
    .setValue(
      '使い方: フォルダURLとメールアドレスを入力 → 有効にチェック → 「RE:年モノ > 設定を検証・更新」。\n' +
        'ユーザーのActor IDは社内ディレクトリから自動解決します。'
    )
    .setWrap(true)
    .setFontColor('#5f6368');

  sheet.setFrozenRows(3);
  sheet.setColumnWidth(1, 70);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidth(3, 420);
  sheet.setColumnWidth(4, 220);
  sheet.setColumnWidth(5, 260);
  sheet.getRange('A1:E55').setVerticalAlignment('middle');
}

function refreshFolderRows_(sheet) {
  const rowCount =
    REINEN_SHEET_CONFIG.FOLDER_LAST_ROW -
    REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW +
    1;
  const values = sheet
    .getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, rowCount, 4)
    .getValues();

  values.forEach((row, index) => {
    const enabled = row[0] === true;
    const input = String(row[2] || '').trim();
    if (!enabled && !input) return;

    const outputRow = REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW + index;
    try {
      const folderId = extractFolderId_(input);
      const name = folderId === 'root' ? 'My Drive' : DriveApp.getFolderById(folderId).getName();
      sheet.getRange(outputRow, 2).setValue(name);
      sheet.getRange(outputRow, 4).setValue(`OK / ${folderId}`);
    } catch (error) {
      sheet.getRange(outputRow, 4).setValue(`エラー: ${error.message}`);
    }
  });
}

function refreshUserRows_(sheet) {
  const allUsers = sheet.getRange(REINEN_SHEET_CONFIG.ALL_USERS_CELL).getValue() === true;
  if (allUsers) return;

  const rowCount =
    REINEN_SHEET_CONFIG.USER_LAST_ROW - REINEN_SHEET_CONFIG.USER_FIRST_ROW + 1;
  const values = sheet
    .getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, rowCount, 5)
    .getValues();

  values.forEach((row, index) => {
    const enabled = row[0] === true;
    const email = normalizeEmail_(row[2]);
    if (!enabled && !email) return;

    const outputRow = REINEN_SHEET_CONFIG.USER_FIRST_ROW + index;
    if (!email) {
      sheet.getRange(outputRow, 5).setValue('エラー: メールアドレスがありません');
      return;
    }

    try {
      const person = resolveDirectoryPersonByEmail_(email);
      sheet.getRange(outputRow, 2).setValue(person.displayName || email);
      sheet.getRange(outputRow, 4).setValue(person.resourceName);
      sheet.getRange(outputRow, 5).setValue('OK');
    } catch (error) {
      sheet.getRange(outputRow, 5).setValue(`エラー: ${error.message}`);
    }
  });
}

function readReinenRuntimeConfig_() {
  const ss = requireBoundSpreadsheet_();
  const sheet = requireConfigSheet_(ss);
  const folders = readSelectedFolders_(sheet);
  const allUsers = sheet.getRange(REINEN_SHEET_CONFIG.ALL_USERS_CELL).getValue() === true;
  const users = allUsers ? [] : readSelectedUsers_(sheet);

  if (folders.length === 0) {
    throw new Error('Configで対象フォルダを1件以上有効にしてください。');
  }
  if (!allUsers && users.length === 0) {
    throw new Error('Configで対象ユーザーを1件以上有効にするか、「全ユーザーを対象」をONにしてください。');
  }

  const effectiveFolders = folders.some((folder) => folder.id === 'root')
    ? folders.filter((folder) => folder.id === 'root').slice(0, 1)
    : uniqueBy_(folders, (folder) => folder.id);

  const allowedActorIds = new Set();
  if (!allUsers) {
    const ownEmail = normalizeEmail_(Session.getActiveUser().getEmail());
    users.forEach((user) => {
      allowedActorIds.add(user.actorId);
      if (ownEmail && user.email === ownEmail) allowedActorIds.add('people/me');
    });
  }

  return {
    spreadsheet: ss,
    configSheet: sheet,
    folders: effectiveFolders,
    allUsers,
    users,
    allowedActorIds: allUsers ? null : allowedActorIds,
  };
}

function readSelectedFolders_(sheet) {
  const rowCount =
    REINEN_SHEET_CONFIG.FOLDER_LAST_ROW - REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW + 1;
  return sheet
    .getRange(REINEN_SHEET_CONFIG.FOLDER_FIRST_ROW, 1, rowCount, 4)
    .getValues()
    .filter((row) => row[0] === true)
    .map((row) => {
      const id = extractFolderId_(row[2]);
      const name = String(row[1] || '').trim() ||
        (id === 'root' ? 'My Drive' : DriveApp.getFolderById(id).getName());
      return { id, name };
    });
}

function readSelectedUsers_(sheet) {
  const rowCount =
    REINEN_SHEET_CONFIG.USER_LAST_ROW - REINEN_SHEET_CONFIG.USER_FIRST_ROW + 1;
  const rows = sheet
    .getRange(REINEN_SHEET_CONFIG.USER_FIRST_ROW, 1, rowCount, 5)
    .getValues();

  return rows
    .map((row, index) => ({ row, sheetRow: REINEN_SHEET_CONFIG.USER_FIRST_ROW + index }))
    .filter(({ row }) => row[0] === true)
    .map(({ row, sheetRow }) => {
      const email = normalizeEmail_(row[2]);
      if (!email) throw new Error(`Config ${sheetRow}行目: メールアドレスがありません。`);

      let actorId = String(row[3] || '').trim();
      let displayName = String(row[1] || '').trim();
      if (!actorId) {
        const person = resolveDirectoryPersonByEmail_(email);
        actorId = person.resourceName;
        displayName = person.displayName || displayName || email;
        sheet.getRange(sheetRow, 2).setValue(displayName);
        sheet.getRange(sheetRow, 4).setValue(actorId);
        sheet.getRange(sheetRow, 5).setValue('OK');
      }

      if (!/^people\//.test(actorId)) {
        throw new Error(`Config ${sheetRow}行目: Actor ID が不正です。設定を検証・更新してください。`);
      }
      return { email, actorId, displayName: displayName || email };
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
      'People APIで社内ユーザーを検索できません。People APIと directory.readonly 権限、社内ディレクトリ共有設定を確認してください。'
    );
  }

  const normalized = normalizeEmail_(email);
  const people = response.people || [];
  const exact = people.find((person) =>
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
      exact.names && exact.names.length ? exact.names[0].displayName || '' : '',
  };
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

function requireBoundSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    PropertiesService.getScriptProperties().setProperty(
      REINEN_SHEET_CONFIG.PROP_BOUND_SPREADSHEET_ID,
      active.getId()
    );
    return active;
  }

  const storedId = PropertiesService.getScriptProperties().getProperty(
    REINEN_SHEET_CONFIG.PROP_BOUND_SPREADSHEET_ID
  );
  if (storedId) {
    return SpreadsheetApp.openById(storedId);
  }

  throw new Error(
    'バインド先スプレッドシートを特定できません。スプレッドシートを開いて「RE:年モノ > 初期設定 / Configを作成」を一度実行してください。'
  );
}

function requireConfigSheet_(ss) {
  const sheet = ss.getSheetByName(REINEN_SHEET_CONFIG.CONFIG_SHEET);
  if (!sheet) {
    throw new Error('Configシートがありません。「RE:年モノ > 初期設定 / Configを作成」を実行してください。');
  }
  return sheet;
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
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
