/**
 * Re:年モノ - Push UX
 *
 * 配布先ごとに変わる WebアプリURL / Chat Webhook URL / 曜日 / 時間帯は Config シート。
 * 内部閾値とACTION_SECRETだけ Script Properties で管理する。
 */
function getReinenUxSettings_() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheet = getReinenSpreadsheet_();
  const configSheet = requireConfigSheet_(spreadsheet);
  const visible = readReinenNotificationConfig_(configSheet);

  return {
    weeklyMaxItems: getIntProperty_(props, 'WEEKLY_MAX_ITEMS', 3),
    upcomingDays: getIntProperty_(props, 'UPCOMING_DAYS', 21),
    snoozeDays: getIntProperty_(props, 'SNOOZE_DAYS', 14),
    maxOverdueAlertsPerRun: getIntProperty_(props, 'MAX_OVERDUE_ALERTS_PER_RUN', 1),
    weekday: visible.weekday,
    weekdayDisplay: visible.weekdayDisplay,
    hour: visible.hour,
    chatWebhookUrl: visible.chatWebhookUrl,
    webAppUrl: visible.webAppUrl,
    actionSecret: String(props.getProperty('ACTION_SECRET') || '').trim(),
  };
}

function setupWeeklyReinenTrigger() {
  const settings = getReinenUxSettings_();
  validateReinenNotificationConfig_(settings, {
    requireWebApp: true,
    requireWebhook: true,
    requireSchedule: true,
  });

  if (!ScriptApp.WeekDay[settings.weekday]) {
    throw new Error('Configの週次通知曜日を確認してください。');
  }
  if (settings.hour < 0 || settings.hour > 23) {
    throw new Error('Configの通知時間帯は0〜23で設定してください。');
  }

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'runWeeklyReinenDigest')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('runWeeklyReinenDigest')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[settings.weekday])
    .atHour(settings.hour)
    .create();

  return `${settings.weekdayDisplay} ${settings.hour}:00ごろの週次トリガーを設定しました。`;
}

function runWeeklyReinenDigest() {
  const runtime = readReinenRuntimeConfig_();
  const core = getReinenCoreSettings_();
  const ux = getReinenUxSettings_();
  const now = new Date();
  const windows = buildWindows_(now, core);

  validateReinenNotificationConfig_(ux, {
    requireWebApp: true,
    requireWebhook: true,
    requireSchedule: false,
  });

  const stats = querySeasonalityStatsForConfig_(runtime, windows, core);
  let recommendations = buildRecommendations_(stats, now, windows, core)
    .sort((a, b) => b.score - a.score)
    .slice(0, core.maxResults);
  recommendations = hydrateRecommendationLocations_(recommendations);

  writeDataSheet_(runtime.spreadsheet, recommendations, now);

  const year = Number(
    Utilities.formatDate(now, REINEN_TIME_ZONE, 'yyyy')
  );
  const stateMap = loadStateMap_(runtime.spreadsheet);

  const eligible = recommendations
    .filter((item) =>
      !isUxSuppressedByState_(
        stateMap.get(stateKey_(item.fileId, year)),
        now
      )
    )
    .map((item) => ({
      ...item,
      daysUntilExpectedStart: daysUntilExpectedStart_(item.expectedStart, now),
    }));

  const overdue = eligible
    .filter((item) => item.daysUntilExpectedStart < 0)
    .filter((item) => {
      const state = stateMap.get(stateKey_(item.fileId, year));
      return !state || !state.overdueSentAt;
    })
    .sort(
      (a, b) =>
        a.daysUntilExpectedStart - b.daysUntilExpectedStart ||
        b.score - a.score
    )
    .slice(0, ux.maxOverdueAlertsPerRun);

  const upcoming = eligible
    .filter(
      (item) =>
        item.daysUntilExpectedStart >= 0 &&
        item.daysUntilExpectedStart <= ux.upcomingDays
    )
    .sort(
      (a, b) =>
        a.daysUntilExpectedStart - b.daysUntilExpectedStart ||
        b.score - a.score
    )
    .slice(0, ux.weeklyMaxItems);

  const result = {
    totalCandidates: recommendations.length,
    weeklyItems: upcoming.length,
    overdueAlerts: 0,
    chatConfigured: Boolean(ux.chatWebhookUrl),
  };

  for (const item of overdue) {
    sendChatPayload_(
      buildOverdueCard_(item, runtime.spreadsheet.getUrl(), year, ux),
      ux
    );
    upsertState_(runtime.spreadsheet, item, year, {
      overdueSentAt: new Date(),
    });
    result.overdueAlerts += 1;
  }

  if (upcoming.length > 0) {
    sendChatPayload_(
      buildWeeklyDigestCard_(
        upcoming,
        runtime.spreadsheet.getUrl(),
        year,
        ux
      ),
      ux
    );
  }

  console.log(JSON.stringify(result, null, 2));
  return result;
}

function sendTestReinenNotification() {
  const ux = getReinenUxSettings_();
  validateReinenNotificationConfig_(ux, {
    requireWebhook: true,
    requireWebApp: false,
    requireSchedule: false,
  });

  sendChatPayload_(
    {
      cardsV2: [
        {
          cardId: `reinen-test-${Date.now()}`,
          card: {
            header: {
              title: 'Re:年モノ',
              subtitle: '通知の準備ができました。',
            },
            sections: [
              {
                widgets: [
                  {
                    textParagraph: {
                      text: 'このカードが見えていれば、Google Chat へのプッシュ経路は正常です。',
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
    ux
  );
  return 'テスト通知を送信しました。';
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || '';
  const fileId = params.fileId || '';
  const fileName = params.fileName || '';
  const year = Number(params.year || 0);
  const signature = params.sig || '';

  if (!['skip', 'snooze'].includes(action) || !fileId || !year || !signature) {
    return renderActionResult_('操作を確認できませんでした。', false);
  }
  if (!verifyActionSignature_(action, fileId, year, signature)) {
    return renderActionResult_('このリンクは無効です。', false);
  }

  const spreadsheet = getReinenSpreadsheet_();
  const item = { fileId, title: fileName || fileId };

  if (action === 'skip') {
    upsertState_(spreadsheet, item, year, { skipThisYear: true });
    return renderActionResult_('今年はこのRe:年モノを通知しません。', true);
  }

  const ux = getReinenUxSettings_();
  upsertState_(spreadsheet, item, year, {
    snoozeUntil: addDays_(new Date(), ux.snoozeDays),
  });
  return renderActionResult_(
    `${ux.snoozeDays}日後まで、このRe:年モノを静かにしておきます。`,
    true
  );
}

function buildWeeklyDigestCard_(items, spreadsheetUrl, year, ux) {
  const widgets = [];

  items.forEach((item) => {
    const timing =
      item.daysUntilExpectedStart === 0
        ? '昨年は今日ごろ開始'
        : `昨年の開始時期まであと${item.daysUntilExpectedStart}日くらい`;

    const pathText = item.folderPath
      ? `<br><font color=\"#5f6368\">フォルダ: ${escapeCardText_(item.folderPath)}</font>`
      : '';

    widgets.push({
      decoratedText: {
        topLabel: timing,
        text:
          `<b>${escapeCardText_(item.title)}</b>` +
          pathText +
          `<br>昨年同時期は${item.seasonalActiveDays}日活動（他時期比 ${item.seasonalLift.toFixed(1)}倍）。`,
        wrapText: true,
      },
    });
    widgets.push({
      buttonList: {
        buttons: buildItemButtons_(item, year, ux),
      },
    });
    widgets.push({ divider: {} });
  });

  widgets.push({
    buttonList: {
      buttons: [
        {
          text: '集計スプシを見る',
          onClick: { openLink: { url: spreadsheetUrl } },
        },
      ],
    },
  });

  return {
    cardsV2: [
      {
        cardId: `weekly-${Date.now()}`,
        card: {
          header: {
            title: '今週のRe:年モノ',
            subtitle: `そろそろ使いそうなものを最大${ux.weeklyMaxItems}件。`,
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

function buildOverdueCard_(item, spreadsheetUrl, year, ux) {
  const buttons = buildItemButtons_(item, year, ux);
  buttons.push({
    text: '集計スプシを見る',
    onClick: { openLink: { url: spreadsheetUrl } },
  });

  const pathText = item.folderPath
    ? `<br><font color=\"#5f6368\">フォルダ: ${escapeCardText_(item.folderPath)}</font>`
    : '';

  return {
    cardsV2: [
      {
        cardId: `overdue-${Date.now()}-${item.fileId}`,
        card: {
          header: {
            title: `昨年の開始時期から約${Math.abs(item.daysUntilExpectedStart)}日経っています。`,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text:
                      `<b>${escapeCardText_(item.title)}</b>` +
                      pathText +
                      `<br>昨年同時期は${item.seasonalActiveDays}日活動（他時期比 ${item.seasonalLift.toFixed(1)}倍）。`,
                  },
                },
                { buttonList: { buttons } },
              ],
            },
          ],
        },
      },
    ],
  };
}

function buildItemButtons_(item, year, ux) {
  const buttons = [
    {
      text: '開く',
      onClick: { openLink: { url: item.url } },
    },
  ];

  if (!ux.webAppUrl) return buttons;

  buttons.push({
    text: '今年は不要',
    onClick: {
      openLink: { url: buildActionUrl_('skip', item, year, ux) },
    },
  });
  buttons.push({
    text: 'あとで',
    onClick: {
      openLink: { url: buildActionUrl_('snooze', item, year, ux) },
    },
  });
  return buttons;
}

function sendChatPayload_(payload, ux) {
  if (!ux.chatWebhookUrl) {
    throw new Error('ConfigのChat Webhook URLが未設定です。');
  }

  const response = UrlFetchApp.fetch(ux.chatWebhookUrl, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error(
      `Google Chat への送信に失敗しました (${status}): ${response.getContentText()}`
    );
  }
  return response.getContentText();
}

function loadStateMap_(spreadsheet) {
  const sheet = getOrCreateSheet_(spreadsheet, REINEN_SHEET_CONFIG.STATE_SHEET);
  initializeStateSheet_(sheet);
  const map = new Map();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;

  sheet.getRange(2, 1, lastRow - 1, 7).getValues().forEach((row, index) => {
    const fileId = String(row[0] || '').trim();
    const year = Number(row[2] || 0);
    if (!fileId || !year) return;
    map.set(stateKey_(fileId, year), {
      rowNumber: index + 2,
      fileId,
      fileName: String(row[1] || ''),
      year,
      skipThisYear: row[3] === true,
      snoozeUntil: coerceDateOrNull_(row[4]),
      overdueSentAt: coerceDateOrNull_(row[5]),
      updatedAt: coerceDateOrNull_(row[6]),
    });
  });
  return map;
}

function upsertState_(spreadsheet, item, year, patch) {
  const sheet = getOrCreateSheet_(spreadsheet, REINEN_SHEET_CONFIG.STATE_SHEET);
  initializeStateSheet_(sheet);
  const existing =
    loadStateMap_(spreadsheet).get(stateKey_(item.fileId, year)) || {
      rowNumber: sheet.getLastRow() + 1,
      fileId: item.fileId,
      fileName: item.title || item.fileId,
      year,
      skipThisYear: false,
      snoozeUntil: null,
      overdueSentAt: null,
    };

  if (Object.prototype.hasOwnProperty.call(patch, 'skipThisYear')) {
    existing.skipThisYear = Boolean(patch.skipThisYear);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'snoozeUntil')) {
    existing.snoozeUntil = patch.snoozeUntil || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'overdueSentAt')) {
    existing.overdueSentAt = patch.overdueSentAt || null;
  }

  existing.fileName = item.title || existing.fileName || item.fileId;
  sheet.getRange(existing.rowNumber, 1, 1, 7).setValues([
    [
      existing.fileId,
      existing.fileName,
      year,
      existing.skipThisYear,
      existing.snoozeUntil || '',
      existing.overdueSentAt || '',
      new Date(),
    ],
  ]);
  sheet.getRange(existing.rowNumber, 5, 1, 3).setNumberFormat('yyyy-mm-dd hh:mm');
}

function isUxSuppressedByState_(state, now) {
  return Boolean(
    state &&
      (state.skipThisYear ||
        (state.snoozeUntil && state.snoozeUntil > now))
  );
}

function stateKey_(fileId, year) {
  return `${year}|${fileId}`;
}

function coerceDateOrNull_(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function daysUntilExpectedStart_(expectedStart, now) {
  return expectedStart
    ? -diffCalendarDays_(expectedStart, now)
    : Number.MAX_SAFE_INTEGER;
}

function buildActionUrl_(action, item, year, ux) {
  const sig = signAction_(action, item.fileId, year, ux);
  return (
    `${ux.webAppUrl}?action=${encodeURIComponent(action)}` +
    `&fileId=${encodeURIComponent(item.fileId)}` +
    `&fileName=${encodeURIComponent(item.title || '')}` +
    `&year=${encodeURIComponent(year)}` +
    `&sig=${encodeURIComponent(sig)}`
  );
}

function signAction_(action, fileId, year, ux) {
  if (!ux.actionSecret) {
    throw new Error('ACTION_SECRET が未設定です。Re:年モノメニューを一度実行してください。');
  }
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(
      `${action}|${fileId}|${year}`,
      ux.actionSecret
    )
  ).replace(/=+$/, '');
}

function verifyActionSignature_(action, fileId, year, signature) {
  return signAction_(action, fileId, year, getReinenUxSettings_()) === signature;
}

function escapeCardText_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderActionResult_(message, success) {
  return HtmlService.createHtmlOutput(
    `<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Re:年モノ</title></head>` +
      `<body style=\"font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 20px;line-height:1.7\">` +
      `<h2>${success ? '設定しました' : '操作できませんでした'}</h2>` +
      `<p>${escapeHtml_(message)}</p><p>この画面は閉じて大丈夫です。</p></body></html>`
  );
}

function escapeHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
