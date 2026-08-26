/**
 * RE:年モノ - Push UX
 *
 * 方針:
 * - 普段は静かにする
 * - 週1回、開始時期が近いものを最大3件だけ Google Chat に通知
 * - 昨年の開始時期を過ぎたものは、1件につき今年1回だけ強めに通知
 * - 今年すでに編集されたファイルは Code.gs 側の推薦条件から自動的に消える
 * - 「今年は不要」「あとで」で通知を抑制できる
 *
 * Google Chat への送信は Incoming Webhook を使う。
 * フィードバック操作は Apps Script Web App の doGet() で受ける。
 */

const REINEN_UX_CONFIG = Object.freeze({
  WEEKLY_MAX_ITEMS: 3,
  UPCOMING_DAYS: 21,
  SNOOZE_DAYS: 14,
  MAX_OVERDUE_ALERTS_PER_RUN: 1,
  DEFAULT_WEEKDAY: 'MONDAY',
  DEFAULT_HOUR: 9,
  PROP_CHAT_WEBHOOK: 'CHAT_WEBHOOK_URL',
  PROP_WEB_APP_URL: 'WEB_APP_URL',
  PROP_ACTION_SECRET: 'ACTION_SECRET',
});

/**
 * Google Chat の Incoming Webhook URL を保存する。
 */
function configureChatWebhook(webhookUrl) {
  if (!webhookUrl || typeof webhookUrl !== 'string') {
    throw new Error('Google Chat の Incoming Webhook URL を指定してください。');
  }

  const value = webhookUrl.trim();
  if (!/^https:\/\/chat\.googleapis\.com\//.test(value)) {
    throw new Error('Google Chat の Incoming Webhook URL ではないようです。');
  }

  PropertiesService.getScriptProperties().setProperty(
    REINEN_UX_CONFIG.PROP_CHAT_WEBHOOK,
    value
  );
  return 'Google Chat webhook を保存しました。';
}

/**
 * Web App をデプロイした後、デプロイURLを明示保存したい場合に使う。
 * ScriptApp.getService().getUrl() が取得できる場合は設定不要。
 */
function configureReinenWebAppUrl(webAppUrl) {
  if (!webAppUrl || !/^https:\/\/script\.google\.com\//.test(webAppUrl.trim())) {
    throw new Error('Apps Script Web App のURLを指定してください。');
  }

  PropertiesService.getScriptProperties().setProperty(
    REINEN_UX_CONFIG.PROP_WEB_APP_URL,
    webAppUrl.trim()
  );
  ensureActionSecret_();
  return 'Web App URL を保存しました。';
}

/**
 * 毎週の通知トリガーを作成する。
 * Apps Script の時間主導トリガーなので、指定時刻ちょうどではなく概ねその時間帯に動く。
 */
function setupWeeklyReinenTrigger(weekday, hour) {
  const dayName = String(weekday || REINEN_UX_CONFIG.DEFAULT_WEEKDAY).toUpperCase();
  const targetHour = Number.isInteger(hour) ? hour : REINEN_UX_CONFIG.DEFAULT_HOUR;

  if (!ScriptApp.WeekDay[dayName]) {
    throw new Error('weekday は MONDAY〜SUNDAY の英字で指定してください。');
  }
  if (targetHour < 0 || targetHour > 23) {
    throw new Error('hour は 0〜23 で指定してください。');
  }

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'runWeeklyReinenDigest')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('runWeeklyReinenDigest')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[dayName])
    .atHour(targetHour)
    .create();

  return `${dayName} ${targetHour}:00ごろの週次トリガーを設定しました。`;
}

/**
 * Push UX の本体。
 * スプレッドシートは裏側の台帳として毎回更新し、ユーザーには必要なものだけ通知する。
 */
function runWeeklyReinenDigest() {
  validateConfiguration_();

  const snapshot = buildReinenSnapshotForUx_();
  const spreadsheet = getOrCreateOutputSpreadsheet_();
  writeRecommendations_(
    spreadsheet,
    snapshot.recommendations,
    snapshot.windows,
    snapshot.sourceFolderId
  );

  const now = snapshot.now;
  const year = Number(
    Utilities.formatDate(now, REINEN_CONFIG.TIME_ZONE, 'yyyy')
  );

  const eligible = snapshot.recommendations
    .filter((item) => !isUxSuppressed_(item.fileId, year, now))
    .map((item) => ({
      ...item,
      daysUntilExpectedStart: daysUntilExpectedStart_(item.expectedStart, now),
    }));

  const overdue = eligible
    .filter((item) => item.daysUntilExpectedStart < 0)
    .filter((item) => !wasOverdueAlertSent_(item.fileId, year))
    .sort((a, b) => {
      if (a.daysUntilExpectedStart !== b.daysUntilExpectedStart) {
        return a.daysUntilExpectedStart - b.daysUntilExpectedStart;
      }
      return b.score - a.score;
    })
    .slice(0, REINEN_UX_CONFIG.MAX_OVERDUE_ALERTS_PER_RUN);

  const upcoming = eligible
    .filter(
      (item) =>
        item.daysUntilExpectedStart >= 0 &&
        item.daysUntilExpectedStart <= REINEN_UX_CONFIG.UPCOMING_DAYS
    )
    .sort((a, b) => {
      if (a.daysUntilExpectedStart !== b.daysUntilExpectedStart) {
        return a.daysUntilExpectedStart - b.daysUntilExpectedStart;
      }
      return b.score - a.score;
    })
    .slice(0, REINEN_UX_CONFIG.WEEKLY_MAX_ITEMS);

  const result = {
    totalCandidates: snapshot.recommendations.length,
    weeklyItems: upcoming.length,
    overdueAlerts: 0,
    spreadsheetUrl: spreadsheet.getUrl(),
    chatConfigured: Boolean(getChatWebhook_()),
  };

  if (!getChatWebhook_()) {
    console.log(
      'CHAT_WEBHOOK_URL が未設定のため通知は送りません。スプレッドシートだけ更新しました。'
    );
    return result;
  }

  for (const item of overdue) {
    sendChatPayload_(buildOverdueCard_(item, spreadsheet.getUrl(), year));
    markOverdueAlertSent_(item.fileId, year);
    result.overdueAlerts += 1;
  }

  if (upcoming.length > 0) {
    sendChatPayload_(buildWeeklyDigestCard_(upcoming, spreadsheet.getUrl(), year));
  }

  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Webhook疎通確認。実ファイルは通知しない。
 */
function sendTestReinenNotification() {
  const payload = {
    text: 'RE:年モノ テスト通知',
    cardsV2: [
      {
        cardId: `reinen-test-${Date.now()}`,
        card: {
          header: {
            title: 'RE:年モノ',
            subtitle: '通知の準備ができました。',
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: 'この通知が見えていれば、Google Chat へのプッシュ経路は正常です。',
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };

  sendChatPayload_(payload);
  return 'テスト通知を送信しました。';
}

/**
 * Chatカードの「今年は不要」「あとで」から呼ばれるWeb Appエンドポイント。
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || '';
  const fileId = params.fileId || '';
  const year = Number(params.year || 0);
  const signature = params.sig || '';

  if (!['skip', 'snooze'].includes(action) || !fileId || !year || !signature) {
    return renderActionResult_('操作を確認できませんでした。', false);
  }

  if (!verifyActionSignature_(action, fileId, year, signature)) {
    return renderActionResult_('このリンクは無効か、期限切れです。', false);
  }

  if (action === 'skip') {
    PropertiesService.getScriptProperties().setProperty(
      skipKey_(fileId, year),
      new Date().toISOString()
    );
    return renderActionResult_('今年はこのRE:年モノを通知しません。', true);
  }

  const snoozeUntil = addDays_(new Date(), REINEN_UX_CONFIG.SNOOZE_DAYS);
  PropertiesService.getScriptProperties().setProperty(
    snoozeKey_(fileId),
    snoozeUntil.toISOString()
  );
  return renderActionResult_(
    `${REINEN_UX_CONFIG.SNOOZE_DAYS}日後まで、このRE:年モノを静かにしておきます。`,
    true
  );
}

function buildReinenSnapshotForUx_() {
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

  const recommendations = buildRecommendations_(seasonalStats, recentStats, now)
    .sort((a, b) => b.score - a.score)
    .slice(0, REINEN_CONFIG.MAX_RESULTS);

  return { now, sourceFolderId, windows, recommendations };
}

function buildWeeklyDigestCard_(items, spreadsheetUrl, year) {
  const widgets = [];

  items.forEach((item) => {
    const timing =
      item.daysUntilExpectedStart === 0
        ? '昨年は今日ごろ開始'
        : `昨年の開始時期まであと${item.daysUntilExpectedStart}日くらい`;

    widgets.push({
      decoratedText: {
        topLabel: timing,
        text:
          `<b>${escapeCardText_(item.title)}</b><br>` +
          `昨年は ${formatDate_(item.firstActivity)}〜${formatDate_(item.lastActivity)} に ` +
          `${item.seasonalActiveDays}日活動。直近${REINEN_CONFIG.RECENT_WINDOW_DAYS}日は動きなし。`,
        wrapText: true,
      },
    });

    widgets.push({
      buttonList: {
        buttons: buildItemButtons_(item, year),
      },
    });

    widgets.push({ divider: {} });
  });

  widgets.push({
    buttonList: {
      buttons: [
        {
          text: 'もっと見る',
          onClick: { openLink: { url: spreadsheetUrl } },
        },
      ],
    },
  });

  return {
    text: `今週のRE:年モノ ${items.length}件`,
    cardsV2: [
      {
        cardId: `weekly-${Date.now()}`,
        card: {
          header: {
            title: '今週のRE:年モノ',
            subtitle: 'そろそろ使いそうなものだけ、最大3件。',
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

function buildOverdueCard_(item, spreadsheetUrl, year) {
  const daysLate = Math.abs(item.daysUntilExpectedStart);
  const buttons = buildItemButtons_(item, year);
  buttons.push({
    text: '一覧を見る',
    onClick: { openLink: { url: spreadsheetUrl } },
  });

  return {
    text: `去年なら、もう始まっていました: ${item.title}`,
    cardsV2: [
      {
        cardId: `overdue-${Date.now()}-${item.fileId}`,
        card: {
          header: {
            title: '去年なら、もう始まっていました',
            subtitle: `昨年の開始時期から約${daysLate}日経っています。`,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text:
                      `<b>${escapeCardText_(item.title)}</b><br>` +
                      `昨年は ${formatDate_(item.firstActivity)} から動き始め、` +
                      `${item.seasonalActiveDays}日活動していました。` +
                      `今年は直近${REINEN_CONFIG.RECENT_WINDOW_DAYS}日、編集がありません。`,
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

function buildItemButtons_(item, year) {
  const buttons = [
    {
      text: '開く',
      onClick: { openLink: { url: item.url } },
    },
  ];

  const webAppUrl = getWebAppUrl_();
  if (!webAppUrl) return buttons;

  buttons.push({
    text: '今年は不要',
    onClick: {
      openLink: {
        url: buildActionUrl_('skip', item.fileId, year),
      },
    },
  });
  buttons.push({
    text: 'あとで',
    onClick: {
      openLink: {
        url: buildActionUrl_('snooze', item.fileId, year),
      },
    },
  });

  return buttons;
}

function sendChatPayload_(payload) {
  const webhookUrl = getChatWebhook_();
  if (!webhookUrl) {
    throw new Error('CHAT_WEBHOOK_URL が未設定です。configureChatWebhook() を実行してください。');
  }

  const response = UrlFetchApp.fetch(webhookUrl, {
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

function getChatWebhook_() {
  return PropertiesService.getScriptProperties().getProperty(
    REINEN_UX_CONFIG.PROP_CHAT_WEBHOOK
  );
}

function getWebAppUrl_() {
  return (
    ScriptApp.getService().getUrl() ||
    PropertiesService.getScriptProperties().getProperty(
      REINEN_UX_CONFIG.PROP_WEB_APP_URL
    ) ||
    ''
  );
}

function isUxSuppressed_(fileId, year, now) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(skipKey_(fileId, year))) return true;

  const snoozeValue = properties.getProperty(snoozeKey_(fileId));
  if (!snoozeValue) return false;

  const until = new Date(snoozeValue);
  if (!Number.isFinite(until.getTime()) || until <= now) {
    properties.deleteProperty(snoozeKey_(fileId));
    return false;
  }

  return true;
}

function wasOverdueAlertSent_(fileId, year) {
  return Boolean(
    PropertiesService.getScriptProperties().getProperty(overdueKey_(fileId, year))
  );
}

function markOverdueAlertSent_(fileId, year) {
  PropertiesService.getScriptProperties().setProperty(
    overdueKey_(fileId, year),
    new Date().toISOString()
  );
}

function skipKey_(fileId, year) {
  return `UX_SKIP_${year}_${fileId}`;
}

function snoozeKey_(fileId) {
  return `UX_SNOOZE_${fileId}`;
}

function overdueKey_(fileId, year) {
  return `UX_OVERDUE_SENT_${year}_${fileId}`;
}

function daysUntilExpectedStart_(expectedStart, now) {
  if (!expectedStart) return Number.MAX_SAFE_INTEGER;
  return -diffCalendarDays_(expectedStart, now);
}

function buildActionUrl_(action, fileId, year) {
  const baseUrl = getWebAppUrl_();
  if (!baseUrl) return '';

  const signature = signAction_(action, fileId, year);
  const params = [
    `action=${encodeURIComponent(action)}`,
    `fileId=${encodeURIComponent(fileId)}`,
    `year=${encodeURIComponent(year)}`,
    `sig=${encodeURIComponent(signature)}`,
  ].join('&');

  return `${baseUrl}?${params}`;
}

function signAction_(action, fileId, year) {
  const secret = ensureActionSecret_();
  const raw = `${action}|${fileId}|${year}`;
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(raw, secret)
  ).replace(/=+$/, '');
}

function verifyActionSignature_(action, fileId, year, signature) {
  return signAction_(action, fileId, year) === signature;
}

function ensureActionSecret_() {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty(REINEN_UX_CONFIG.PROP_ACTION_SECRET);
  if (!secret) {
    secret = `${Utilities.getUuid()}-${Utilities.getUuid()}`;
    properties.setProperty(REINEN_UX_CONFIG.PROP_ACTION_SECRET, secret);
  }
  return secret;
}

function escapeCardText_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderActionResult_(message, success) {
  const title = success ? '設定しました' : '操作できませんでした';
  const safeMessage = escapeHtml_(message);
  return HtmlService.createHtmlOutput(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>RE:年モノ</title></head><body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 20px;line-height:1.7">` +
      `<h2>${title}</h2><p>${safeMessage}</p><p>この画面は閉じて大丈夫です。</p></body></html>`
  );
}

function escapeHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
