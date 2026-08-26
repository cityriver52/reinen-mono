/**
 * RE:年モノ (レイネンモノ) - core
 *
 * Google Drive Activity API から「昨年同時期に活発だったが、最近は動いていない」
 * ファイルを抽出する。対象フォルダ・対象ユーザーは Config.gs の Config シートから読む。
 */

const REINEN_CONFIG = Object.freeze({
  OUTPUT_SHEET_NAME: 'おすすめ',
  SEASONAL_WINDOW_DAYS: 21,
  RECENT_WINDOW_DAYS: 90,
  MIN_SEASONAL_ACTIVE_DAYS: 2,
  MIN_SEASONAL_EDIT_ACTIVITIES: 3,
  MAX_RECENT_ACTIVE_DAYS: 0,
  MAX_RESULTS: 50,
  PAGE_SIZE: 100,
  MAX_PAGES: 500,
  TIME_ZONE: 'Asia/Tokyo',
});

/**
 * Configに従って候補を抽出し、バインド先スプレッドシートの「おすすめ」を更新する。
 */
function runReinenMono() {
  const runtime = readReinenRuntimeConfig_();
  const now = new Date();
  const windows = buildWindows_(now);

  const seasonalStats = queryEditStatsForRuntime_(
    runtime,
    windows.seasonalStart,
    windows.seasonalEnd
  );
  const recentStats = queryEditStatsForRuntime_(
    runtime,
    windows.recentStart,
    windows.recentEnd
  );

  const recommendations = buildRecommendations_(seasonalStats, recentStats, now)
    .sort((a, b) => b.score - a.score)
    .slice(0, REINEN_CONFIG.MAX_RESULTS);

  const spreadsheet = getOrCreateOutputSpreadsheet_();
  writeRecommendations_(spreadsheet, recommendations, windows, runtime);

  const result = {
    count: recommendations.length,
    spreadsheetUrl: spreadsheet.getUrl(),
    folders: runtime.folders.map((folder) => folder.name),
    users: runtime.allUsers
      ? ['全ユーザー']
      : runtime.users.map((user) => user.displayName || user.email),
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 約1年前のEDIT履歴が、現在のConfig条件で取得できるか診断する。
 */
function diagnoseHistory() {
  const runtime = readReinenRuntimeConfig_();
  const now = new Date();
  const center = shiftYears_(now, -1);
  const start = addDays_(center, -30);
  const end = addDays_(center, 31);

  const stats = queryEditStatsForRuntime_(runtime, start, end);
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
      sourceFolders: item.sourceFolders,
    }));

  const result = {
    folders: runtime.folders,
    users: runtime.allUsers ? 'ALL' : runtime.users,
    start: start.toISOString(),
    endExclusive: end.toISOString(),
    filesFound: values.length,
    editActivitiesFound: totalActivities,
    top20: top,
    note:
      values.length === 0
        ? '0件でした。Config条件が狭すぎないか、対象ユーザーのActor IDが正しいか、当時確実に編集した既知ファイルで確認してください。'
        : 'Configで選択したフォルダ・ユーザー条件に一致する約1年前のEDIT activityを取得できています。',
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 複数の対象フォルダを問い合わせ、重複を除きながら統合する。
 */
function queryEditStatsForRuntime_(runtime, start, end) {
  const stats = {};
  const seenEventKeys = new Set();

  runtime.folders.forEach((folder) => {
    queryEditStats_(
      folder,
      start,
      end,
      runtime.allowedActorIds,
      stats,
      seenEventKeys
    );
  });

  return stats;
}

/**
 * 1つの対象フォルダ配下のEDITを取得し、Actor条件に合うものだけを集計する。
 * Drive Activity API自体はActorをquery filterに指定できないため、取得後に絞り込む。
 */
function queryEditStats_(
  folder,
  start,
  end,
  allowedActorIds,
  stats,
  seenEventKeys
) {
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
      ancestorName: `items/${folder.id}`,
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
      const actorKeys = getActivityActorKeys_(activity);
      if (!activityMatchesAllowedActors_(actorKeys, allowedActorIds)) continue;

      const activityTime = getActivityTime_(activity);
      if (!activityTime) continue;

      const dayKey = Utilities.formatDate(
        activityTime,
        REINEN_CONFIG.TIME_ZONE,
        'yyyy-MM-dd'
      );
      const seenInActivity = new Set();

      for (const target of activity.targets || []) {
        const item = target.driveItem;
        if (!item || !item.name || item.driveFolder) continue;

        const fileId = item.name.replace(/^items\//, '');
        if (!fileId || seenInActivity.has(fileId)) continue;
        seenInActivity.add(fileId);

        // 同じ親子フォルダをConfigで重複選択した場合も二重計上しない。
        const eventKey = [
          fileId,
          activityTime.toISOString(),
          actorKeys.slice().sort().join(','),
        ].join('|');
        if (seenEventKeys.has(eventKey)) continue;
        seenEventKeys.add(eventKey);

        if (!stats[fileId]) {
          stats[fileId] = {
            fileId,
            title: item.title || '(無題)',
            editActivities: 0,
            activeDaySet: new Set(),
            sourceFolderSet: new Set(),
            firstActivity: null,
            lastActivity: null,
          };
        }

        const stat = stats[fileId];
        stat.editActivities += 1;
        stat.activeDaySet.add(dayKey);
        stat.sourceFolderSet.add(folder.name);
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
}

function activityMatchesAllowedActors_(actorKeys, allowedActorIds) {
  if (allowedActorIds === null) return true;
  if (!actorKeys.length) return false;
  return actorKeys.some((actorKey) => allowedActorIds.has(actorKey));
}

/**
 * DriveActivity.actors と、必要に応じて actions[].actor の KnownUser を収集する。
 */
function getActivityActorKeys_(activity) {
  const keys = new Set();
  (activity.actors || []).forEach((actor) => addActorKeys_(keys, actor));
  (activity.actions || []).forEach((action) => {
    if (action.actor) addActorKeys_(keys, action.actor);
  });
  return Array.from(keys);
}

function addActorKeys_(set, actor) {
  const known = actor && actor.user && actor.user.knownUser;
  if (!known) return;
  if (known.personName) set.add(known.personName);
  if (known.isCurrentUser) set.add('people/me');
}

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
      sourceFolders: past.sourceFolders,
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

function writeRecommendations_(spreadsheet, recommendations, windows, runtime) {
  let sheet = spreadsheet.getSheetByName(REINEN_CONFIG.OUTPUT_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(REINEN_CONFIG.OUTPUT_SHEET_NAME);

  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.clear();
  sheet.setFrozenRows(0);

  const folderSummary = runtime.folders.map((folder) => folder.name).join(', ');
  const userSummary = runtime.allUsers
    ? '全ユーザー'
    : runtime.users.map((user) => user.displayName || user.email).join(', ');

  const infoRows = [
    ['RE:年モノ', '去年の仕事が、今年を教えてくれる。'],
    ['実行日時', new Date()],
    ['対象フォルダ', folderSummary],
    ['対象ユーザー', userSummary],
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
    '検出元フォルダ',
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
      (item.sourceFolders || []).join(', '),
      item.seasonalActiveDays,
      item.seasonalEditActivities,
      item.recentActiveDays,
      item.firstActivity || '',
      item.lastActivity || '',
      item.timingLabel,
      item.url,
      item.fileId,
    ]);

    sheet
      .getRange(headerRow + 1, 1, rows.length, headers.length)
      .setValues(rows);
    sheet
      .getRange(headerRow + 1, 7, rows.length, 2)
      .setNumberFormat('yyyy-mm-dd hh:mm');
    sheet
      .getRange(headerRow, 1, rows.length + 1, headers.length)
      .createFilter();
  }

  sheet.setFrozenRows(headerRow);
  sheet.autoResizeColumns(1, headers.length);
  sheet.setColumnWidth(2, 320);
  sheet.setColumnWidth(3, 240);
  sheet.setColumnWidth(9, 180);
  sheet.setColumnWidth(10, 320);
}

/**
 * container-bound版では出力先 = バインド先スプレッドシート。
 */
function getOrCreateOutputSpreadsheet_() {
  return requireBoundSpreadsheet_();
}

function validateConfiguration_() {
  return readReinenRuntimeConfig_();
}

function finalizeStats_(stat) {
  return {
    fileId: stat.fileId,
    title: stat.title,
    editActivities: stat.editActivities,
    activeDays: stat.activeDaySet ? stat.activeDaySet.size : stat.activeDays || 0,
    sourceFolders: stat.sourceFolderSet
      ? Array.from(stat.sourceFolderSet)
      : stat.sourceFolders || [],
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
    seasonalEnd: addDays_(seasonalCenter, REINEN_CONFIG.SEASONAL_WINDOW_DAYS + 1),
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
