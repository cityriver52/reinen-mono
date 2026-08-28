const GRAPH_SPREADSHEET_ID = '1AD8G5ugPDvlkQMZ4Pq3XWYlTT5nWjPxoS62xPGuYVZ4';
const GRAPH_TIME_ZONE = 'Asia/Tokyo';

const GRAPH_SETTINGS = Object.freeze({
  configSheet: 'Config',
  cacheSheet: 'GraphCache',
  folderFirstRow: 4,
  folderLastRow: 23,
  userFirstRow: 4,
  userLastRow: 23,
  fiscalYearCell: 'E4',
  pageSize: 100,
  maxPages: 600,
  cooccurrenceWindowDays: 7,
  cooccurrenceHalfLifeDays: 3,
  minMatches: 2,
  minScore: 0.08,
  maxNodes: 250,
  maxEdges: 1500,
  cacheMaxAgeHours: 24,
  cacheChunkChars: 45000,
});

function getGraphSpreadsheet_() {
  return SpreadsheetApp.openById(GRAPH_SPREADSHEET_ID);
}

function readGraphRuntimeConfig_() {
  const ss = getGraphSpreadsheet_();
  const sheet = ss.getSheetByName(GRAPH_SETTINGS.configSheet);
  if (!sheet) throw new Error('Configシートがありません。');

  const rowCount = GRAPH_SETTINGS.folderLastRow - GRAPH_SETTINGS.folderFirstRow + 1;
  const rows = sheet
    .getRange(GRAPH_SETTINGS.folderFirstRow, 1, rowCount, 6)
    .getDisplayValues();

  const folderInputs = rows
    .map((row) => String(row[0] || '').trim())
    .filter(Boolean);
  const userEmails = rows
    .map((row) => normalizeGraphEmail_(row[2]))
    .filter(Boolean);

  const fiscalYearRaw = String(sheet.getRange(GRAPH_SETTINGS.fiscalYearCell).getDisplayValue() || '').trim();
  const fiscalYear = fiscalYearRaw
    ? parseGraphFiscalYear_(fiscalYearRaw)
    : defaultGraphFiscalYear_();

  const folders = uniqueGraphBy_(folderInputs.map((input) => {
    const id = extractGraphFolderId_(input);
    const name = id === 'root' ? 'My Drive' : DriveApp.getFolderById(id).getName();
    return { id, name, input };
  }), (item) => item.id);

  const users = uniqueGraphBy_(userEmails.map((email) => {
    const person = resolveGraphPersonByEmail_(email);
    return {
      email,
      displayName: person.displayName || email,
      actorId: person.resourceName,
    };
  }), (item) => item.actorId);

  if (folders.length === 0) {
    throw new Error('ConfigのA4:A23に対象フォルダURLまたはIDを入力してください。');
  }
  if (users.length === 0) {
    throw new Error('ConfigのC4:C23に対象ユーザーのメールアドレスを入力してください。');
  }

  const ownEmail = normalizeGraphEmail_(Session.getActiveUser().getEmail());
  const allowedActorIds = new Set(users.map((user) => user.actorId));
  if (users.some((user) => ownEmail && user.email === ownEmail)) {
    allowedActorIds.add('people/me');
  }

  const comparisonStart = makeGraphTokyoDate_(fiscalYear, 4, 1);
  const comparisonEnd = makeGraphTokyoDate_(fiscalYear + 1, 4, 1);

  writeResolvedGraphConfig_(sheet, folders, users, fiscalYear);

  return {
    spreadsheet: ss,
    sheet,
    folders,
    users,
    allowedActorIds,
    fiscalYear,
    comparisonStart,
    comparisonEnd,
  };
}

function writeResolvedGraphConfig_(sheet, folders, users, fiscalYear) {
  const rowCount = GRAPH_SETTINGS.folderLastRow - GRAPH_SETTINGS.folderFirstRow + 1;
  const folderMap = new Map(folders.map((item) => [item.input, item]));
  const userMap = new Map(users.map((item) => [item.email, item]));
  const rows = sheet
    .getRange(GRAPH_SETTINGS.folderFirstRow, 1, rowCount, 6)
    .getDisplayValues();

  const folderNames = [];
  const userNames = [];
  rows.forEach((row) => {
    const folderInput = String(row[0] || '').trim();
    const email = normalizeGraphEmail_(row[2]);
    folderNames.push([folderInput && folderMap.has(folderInput) ? folderMap.get(folderInput).name : '']);
    userNames.push([email && userMap.has(email) ? userMap.get(email).displayName : '']);
  });

  sheet.getRange(GRAPH_SETTINGS.folderFirstRow, 2, rowCount, 1).setValues(folderNames);
  sheet.getRange(GRAPH_SETTINGS.userFirstRow, 4, rowCount, 1).setValues(userNames);
  if (!String(sheet.getRange(GRAPH_SETTINGS.fiscalYearCell).getDisplayValue() || '').trim()) {
    sheet.getRange(GRAPH_SETTINGS.fiscalYearCell).setValue(fiscalYear);
  }
}

function resolveGraphPersonByEmail_(email) {
  let response;
  try {
    response = People.People.searchDirectoryPeople({
      query: email,
      readMask: 'names,emailAddresses',
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
      pageSize: 20,
    });
  } catch (error) {
    throw new Error('People APIでユーザーを検索できません。People APIとdirectory.readonly権限を確認してください。');
  }

  const normalized = normalizeGraphEmail_(email);
  const exact = (response.people || []).find((person) =>
    (person.emailAddresses || []).some((entry) => normalizeGraphEmail_(entry.value) === normalized)
  );
  if (!exact || !exact.resourceName) {
    throw new Error(`${email} を社内ディレクトリで特定できませんでした。`);
  }

  return {
    resourceName: exact.resourceName,
    displayName: exact.names && exact.names.length ? exact.names[0].displayName || '' : '',
  };
}

function extractGraphFolderId_(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('フォルダURLまたはIDが空です。');
  if (text === 'root') return 'root';
  const match = text.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  throw new Error(`${text} をGoogle Driveフォルダとして読み取れません。`);
}

function parseGraphFiscalYear_(value) {
  const match = String(value).match(/(20\d{2})/);
  if (!match) throw new Error('比較年度は2025のような西暦年度で指定してください。');
  return Number(match[1]);
}

function defaultGraphFiscalYear_() {
  const center = new Date();
  center.setFullYear(center.getFullYear() - 1);
  const year = Number(Utilities.formatDate(center, GRAPH_TIME_ZONE, 'yyyy'));
  const month = Number(Utilities.formatDate(center, GRAPH_TIME_ZONE, 'M'));
  return month >= 4 ? year : year - 1;
}

function makeGraphTokyoDate_(year, month, day) {
  return new Date(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+09:00`
  );
}

function normalizeGraphEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqueGraphBy_(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
