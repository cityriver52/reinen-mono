/**
 * RE:年モノ (レイネンモノ) - MVP
 *
 * 去年の同時期には編集されていたが、最近は動いていないファイルを
 * Google Drive Activity API から見つけ、スプレッドシートへ可視化する。
 */

const REINEN_CONFIG = Object.freeze({
  // 検索対象。Script Properties の SOURCE_FOLDER_ID で上書き可能。
  DEFAULT_SOURCE_FOLDER_ID: 'root',

  // ユーザーが作成した Google Drive「RE:年モノ」フォルダ。
  OUTPUT_FOLDER_ID: '1vmIYAnRsdD7GDDwoJ2bN84VQ4JQQgEDO',

  OUTPUT_SPREADSHEET_NAME: 'RE:年モノ - おすすめ',
  OUTPUT_SHEET_NAME: 'おすすめ',

  // 「去年の今ごろ」の幅。
  SEASONAL_WINDOW_DAYS: 21,

  // 最近使われていないことを判定する期間。
  RECENT_WINDOW_DAYS: 90,

  // 昨年の期間内に、最低2日以上編集されたファイルを基本候補にする。
  MIN_SEASONAL_ACTIVE_DAYS: 2,

  // 同日に編集が集中したファイルも拾えるよう、activity件数でも候補化する。
  MIN_SEASONAL_EDIT_ACTIVITIES: 3,

  // 最近1日でも編集されていたらMVPでは推薦対象外。
  MAX_RECENT_ACTIVE_DAYS: 0,

  MAX_RESULTS: 50,
  PAGE_SIZE: 100,
  MAX_PAGES: 500,
  TIME_ZONE: 'Asia/Tokyo',
});

/**
 * MVP本体。
 * 「昨年の同時期に活発」「直近90日は休眠」のファイルをランキングする。
 *
 * @return {{count:number, spreadsheetUrl:string, sourceFolderId:string}}
 */
function runReinenMono() {
  validateConfiguration_();

  const now = new Date();
  const sourceFolderId = getSourceFolderId_();
  const windows = buildWindows_(now);

  const seasonalStats = queryEditStats_(
    sourceFolderId,
    windows.seasonalStart,
    windows.seasonalEnd
  );

  const recentStats = queryEditStats_(
    sourceFolderId,
    windows.recentStart,
    windows.recentEnd
  );

  const recommendations = buildRecommendations_(
    seasonalStats,
    recentStats,
    now
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, REINEN_CONFIG.MAX_RESULTS);

  const spreadsheet = getOrCreateOutputSpreadsheet_();
  writeRecommendations_(spreadsheet, recommendations, windows, sourceFolderId);

  const result = {
    count: recommendations.length,
    spreadsheetUrl: spreadsheet.getUrl(),
    sourceFolderId,
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 検索対象フォルダを設定する。
 * My Drive 全体なら 'root' を指定。
 * 共有フォルダを対象にしたい場合は、そのフォルダIDを指定する。
 *
 * @param {string} folderId
 * @return {string}
 */
function configureSourceFolder(folderId) {
  if (!folderId || typeof folderId !== 'string') {
    throw new Error('folderId を指定してください。My Drive 全体なら "root" です。');
  }

  const normalized = folderId.trim();

  if (normalized !== 'root') {
    // ここでアクセス権とフォルダの存在を早めに検証する。
    DriveApp.getFolderById(normalized).getName();
  }

  PropertiesService.getScriptProperties().setProperty(
    'SOURCE_FOLDER_ID',
    normalized
  );

  console.log(`SOURCE_FOLDER_ID = ${normalized}`);
  return normalized;
}

/**
 * 約1年前の履歴が実環境で取得できるかを確認する診断用関数。
 * 期間は「1年前の今日」を中心に±30日。
 *
 * 0件でも「保持されていない」とは断定できない。
 * その期間に実際に編集された既知ファイルと照合すること。
 *
 * @return {Object}
 */
function diagnoseHistory() {
  validateConfiguration_();

  const now = new Date();
  const center = shiftYears_(now, -1);
  const start = addDays_(center, -30);
  const end = addDays_(center, 31); // endはexclusive
  const sourceFolderId = getSourceFolderId_();

  const stats = queryEditStats_(sourceFolderId, start, end);
  const values = Object.values(stats);
  const totalActivities = values.reduce(
    (sum, item) => sum + item.editActivities,
    0
  );

  const top = values
    .map(finalizeStats_)
    .sort((a, b) => {
      if (b.activeDays !== a.activeDays) return b.activeDays - a.activeDays;
      return b.editActivities - a.editActivities;
    })
    .slice(0, 20)
    .map((item) => ({
      title: item.title,
      fileId: item.fileId,
      activeDays: item.activeDays,
      editActivities: item.editActivities,
      firstActivity: item.firstActivity,
      lastActivity: item.lastActivity,
    }));

  const result = {
    sourceFolderId,
    start: start.toISOString(),
    endExclusive: end.toISOString(),
    filesFound: values.length,
    editActivitiesFound: totalActivities,
    top20: top,
    note:
      values.length === 0
        ? '0件でした。履歴保持不足とは断定できないため、当時確実に編集した既知ファイルで追加確認してください。'
        : '約1年前のEDIT activityを取得できています。既知の例年モノが含まれるか確認してください。',
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Drive Activity APIから指定期間のEDITを取得し、ファイルID単位に集計する。
 * consolidationStrategy:none を明示し、可能な限り個々のactivityとして取得する。
 *
 * @param {string} ancestorFolderId
 * @param {Date} start
 * @param {Date} end exclusive
 * @return {Object<string, Object>}
 */
function queryEditStats_(ancestorFolderId, start, end) {
  const stats = {};
  let pageToken = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > REINEN_CONFIG.MAX_PAGES) {
      throw new Error(
        `Drive Activity API のページ数が ${REINEN_CONFIG.MAX_PAGES} を超えました。対象フォルダまたは期間を絞ってください。`
      );
    }

    const request = {
      ancestorName: `items/${ancestorFolderId}`,
      consolidationStrategy: { none: {} },
      pageSize: REINEN_CONFIG.PAGE_SIZE,
      filter:
        'detail.action_detail_case:EDIT ' +
        `time >= "${start.toISOString()}" ` +
        `time < "${end.toISOString()}"`,
    };

    if (pageToken) request.pageToken = pageToken;

    const response = DriveActivity.Activity.query(request);
    const activities = response.activities || [];

    for (const activity of activities) {
      const activityTime = getActivityTime_(activity);
      if (!activityTime) continue;

      const dayKey = Utilities.formatDate(
        activityTime,
        REINEN_CONFIG.TIME_ZONE,
        'yyyy-MM-dd'
      );

      // no-consolidationでもAPI側で自然にグループ化されるケースはあり得るため、
      // 1 activity 内の同一ファイルは1回だけ数える。
      const seenInActivity = new Set();

      for (const target of activity.targets || []) {
        const item = target.driveItem;
        if (!item || !item.name) continue;
        if (item.driveFolder) continue;

        const fileId = item.name.replace(/^items\//, '');
        if (!fileId || seenInActivity.has(fileId)) continue;
        seenInActivity.add(fileId);

        if (!stats[fileId]) {
          stats[fileId] = {
            fileId,
            title: item.title || '(無題)',
            editActivities: 0,
            activeDaySet: new Set(),
            firstActivity: null,
            lastActivity: null,
          };
        }

        const stat = stats[fileId];
        stat.editActivities += 1;
        stat.activeDaySet.add(dayKey);

        if (item.title) stat.title = item.title;

        if (!stat.firstActivity || activityTime < stat.firstActivity) {
          stat.firstActivity = activityTime;
        }
        if (!stat.lastActivity || activityTime > stat.lastActivity) {
          stat.lastActivity = activityTime;
        }
      }
    }

    pageToken = response.nextPageToken || null;
  } while (pageToken);

  return stats;
}

/**
 * 昨年同時期は活発だが最近は休眠しているファイルを推薦候補にする。
 *
 * スコアは説明可能性を優先したMVP用:
 *   活動日数 * 100 + min(activity件数, 50) * 5
 *
 * @param {Object<string, Object>} seasonalStats
 * @param {Object<string, Object>} recentStats
 * @param {Date} now
 * @return {Array<Object>}
 */
function buildRecommendations_(seasonalStats, recentStats, now) {
  const recommendations = [];

  for (const fileId of Object.keys(seasonalStats)) {
    const past = finalizeStats_(seasonalStats[fileId]);
    const recent = recentStats[fileId]
      ? finalizeStats_(recentStats[fileId])
      : {
          activeDays: 0,
          editActivities: 0,
          firstActivity: null,
          lastActivity: null,
        };

    const seasonalEnough =
      past.activeDays >= REINEN_CONFIG.MIN_SEASONAL_ACTIVE_DAYS ||
      past.editActivities >= REINEN_CONFIG.MIN_SEASONAL_EDIT_ACTIVITIES;

    if (!seasonalEnough) continue;
    if (recent.activeDays > REINEN_CONFIG.MAX_RECENT_ACTIVE_DAYS) continue;

    const expectedStart = past.firstActivity
      ? shiftYears_(past.firstActivity, 1)
      : null;

    const score =
      past.activeDays * 100 + Math.min(past.editActivities, 50) * 5;

    recommendations.push({
      score,
      fileId,
      title: past.title,
      seasonalActiveDays: past.activeDays,
      seasonalEditActivities: past.editActivities,
      recentActiveDays: recent.activeDays,
      recentEditActivities: recent.editActivities,
      firstActivity: past.firstActivity,
      lastActivity: past.lastActivity,
      expectedStart,
      timingLabel: describeTiming_(expectedStart, now),
      url: `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`,
    });
  }

  return recommendations;
}

/**
 * スプレッドシートへ結果を書き出す。
 */
function writeRecommendations_(
  spreadsheet,
  recommendations,
  windows,
  sourceFolderId
) {
  let sheet = spreadsheet.getSheetByName(REINEN_CONFIG.OUTPUT_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(REINEN_CONFIG.OUTPUT_SHEET_NAME);
  }

  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.clear();
  sheet.setFrozenRows(0);

  const infoRows = [
    ['RE:年モノ', '去年の仕事が、今年を教えてくれる。'],
    ['実行日時', new Date()],
    ['検索対象フォルダID', sourceFolderId],
    [
      '昨年同時期',
      `${formatDate_(windows.seasonalStart)} ～ ${formatDate_(addDays_(windows.seasonalEnd, -1))}`,
    ],
    [
      '最近',
      `${formatDate_(windows.recentStart)} ～ ${formatDate_(addDays_(windows.recentEnd, -1))}`,
    ],
    [
      '抽出条件',
      `昨年: 活動${REINEN_CONFIG.MIN_SEASONAL_ACTIVE_DAYS}日以上 または EDIT ${REINEN_CONFIG.MIN_SEASONAL_EDIT_ACTIVITIES}件以上 / 最近: 活動${REINEN_CONFIG.MAX_RECENT_ACTIVE_DAYS}日以下`,
    ],
    ['候補件数', recommendations.length],
    ['', ''],
  ];

  sheet.getRange(1, 1, infoRows.length, 2).setValues(infoRows);
  sheet.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sheet.getRange(2, 2).setNumberFormat('yyyy-mm-dd hh:mm');

  const headers = [
    '優先度',
    'ファイル名',
    '昨年の活動日数',
    '昨年のEDIT activity',
    `直近${REINEN_CONFIG.RECENT_WINDOW_DAYS}日の活動日数`,
    '昨年の活動開始',
    '昨年の最終活動',
    '今年の目安',
    'Driveリンク',
    'File ID',
  ];

  const headerRow = infoRows.length + 1;
  sheet.getRange(headerRow, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange(headerRow, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#e8eaed');

  if (recommendations.length > 0) {
    const rows = recommendations.map((item) => [
      item.score,
      item.title,
      item.seasonalActiveDays,
      item.seasonalEditActivities,
      item.recentActiveDays,
      item.firstActivity || '',
      item.lastActivity || '',
      item.timingLabel,
      item.url,
      item.fileId,
    ]);

    const dataRange = sheet.getRange(
      headerRow + 1,
      1,
      rows.length,
      headers.length
    );
    dataRange.setValues(rows);

    sheet
      .getRange(headerRow + 1, 6, rows.length, 2)
      .setNumberFormat('yyyy-mm-dd hh:mm');

    sheet
      .getRange(headerRow, 1, rows.length + 1, headers.length)
      .createFilter();
  }

  sheet.setFrozenRows(headerRow);
  sheet.autoResizeColumns(1, headers.length);

  // ファイル名とURLは見やすさのため上限を設ける。
  sheet.setColumnWidth(2, 320);
  sheet.setColumnWidth(8, 180);
  sheet.setColumnWidth(9, 320);

  sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setVerticalAlignment('middle');
}

/**
 * 出力先スプレッドシートを取得。初回のみ作成し、指定Driveフォルダへ移動する。
 *
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getOrCreateOutputSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const storedId = properties.getProperty('OUTPUT_SPREADSHEET_ID');

  if (storedId) {
    try {
      return SpreadsheetApp.openById(storedId);
    } catch (error) {
      console.warn(`既存の出力スプレッドシートを開けないため再作成します: ${error.message}`);
      properties.deleteProperty('OUTPUT_SPREADSHEET_ID');
    }
  }

  const spreadsheet = SpreadsheetApp.create(
    REINEN_CONFIG.OUTPUT_SPREADSHEET_NAME
  );

  const outputFolder = DriveApp.getFolderById(REINEN_CONFIG.OUTPUT_FOLDER_ID);
  const outputFile = DriveApp.getFileById(spreadsheet.getId());
  outputFile.moveTo(outputFolder);

  properties.setProperty('OUTPUT_SPREADSHEET_ID', spreadsheet.getId());
  return spreadsheet;
}

function validateConfiguration_() {
  // 出力フォルダが存在し、実行ユーザーから見えることを確認。
  DriveApp.getFolderById(REINEN_CONFIG.OUTPUT_FOLDER_ID).getName();

  const sourceFolderId = getSourceFolderId_();
  if (sourceFolderId !== 'root') {
    DriveApp.getFolderById(sourceFolderId).getName();
  }
}

function getSourceFolderId_() {
  return (
    PropertiesService.getScriptProperties().getProperty('SOURCE_FOLDER_ID') ||
    REINEN_CONFIG.DEFAULT_SOURCE_FOLDER_ID
  );
}

function finalizeStats_(stat) {
  return {
    fileId: stat.fileId,
    title: stat.title,
    editActivities: stat.editActivities,
    activeDays: stat.activeDaySet ? stat.activeDaySet.size : stat.activeDays || 0,
    firstActivity: stat.firstActivity,
    lastActivity: stat.lastActivity,
  };
}

function getActivityTime_(activity) {
  if (activity.timestamp) return new Date(activity.timestamp);

  if (activity.timeRange) {
    const value = activity.timeRange.endTime || activity.timeRange.startTime;
    if (value) return new Date(value);
  }

  return null;
}

function buildWindows_(now) {
  const seasonalCenter = shiftYears_(now, -1);

  return {
    seasonalStart: addDays_(seasonalCenter, -REINEN_CONFIG.SEASONAL_WINDOW_DAYS),
    seasonalEnd: addDays_(
      seasonalCenter,
      REINEN_CONFIG.SEASONAL_WINDOW_DAYS + 1
    ),
    recentStart: addDays_(now, -REINEN_CONFIG.RECENT_WINDOW_DAYS),
    recentEnd: addDays_(now, 1),
  };
}

function describeTiming_(expectedStart, now) {
  if (!expectedStart) return '';

  const days = diffCalendarDays_(expectedStart, now);

  if (days < 0) return `あと${Math.abs(days)}日くらい`;
  if (days === 0) return '昨年は今日ごろ開始';
  return `昨年は${days}日前ごろ開始`;
}

/**
 * expected - now のカレンダー日差。
 * expectedが未来なら負、過去なら正になるようdescribeTiming_用に返す。
 */
function diffCalendarDays_(expected, now) {
  const expectedMidnight = new Date(
    Utilities.formatDate(expected, REINEN_CONFIG.TIME_ZONE, 'yyyy/MM/dd')
  );
  const nowMidnight = new Date(
    Utilities.formatDate(now, REINEN_CONFIG.TIME_ZONE, 'yyyy/MM/dd')
  );

  return Math.round(
    (nowMidnight.getTime() - expectedMidnight.getTime()) / (24 * 60 * 60 * 1000)
  );
}

function addDays_(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function shiftYears_(date, years) {
  const value = new Date(date);
  value.setFullYear(value.getFullYear() + years);
  return value;
}

function formatDate_(date) {
  return Utilities.formatDate(date, REINEN_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}
