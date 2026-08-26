/**
 * Re:年モノ - human-readable View sheet
 *
 * Data / State は内部台帳のまま維持し、View は数式でそれらを参照する。
 * そのため集計ロジック側で二重にデータを書かず、Data更新後は自動追従する。
 */
const REINEN_VIEW_SHEET_NAME = 'View';
const REINEN_VIEW_MAX_ROWS = 50;

function getReinenViewUrl_(spreadsheet) {
  const sheet = ensureReinenViewSheet_(spreadsheet);
  return `${spreadsheet.getUrl()}#gid=${sheet.getSheetId()}`;
}

function ensureReinenViewSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(REINEN_VIEW_SHEET_NAME) ||
    spreadsheet.insertSheet(REINEN_VIEW_SHEET_NAME);

  const marker = sheet.getRange('A1').getDisplayValue();
  if (marker !== 'Re:年モノ') {
    initializeReinenViewSheet_(sheet);
  }
  return sheet;
}

function initializeReinenViewSheet_(sheet) {
  sheet.clear();
  sheet.clearConditionalFormatRules();

  sheet.getRange('A1:E1').merge();
  sheet.getRange('A1')
    .setValue('Re:年モノ')
    .setFontSize(16)
    .setFontWeight('bold');

  sheet.getRange('A2:E2').merge();
  sheet.getRange('A2')
    .setValue('昨年のこの時期に動いていた候補を、見やすい項目だけ表示しています。')
    .setFontColor('#5f6368');

  sheet.getRange('A4:E4')
    .setValues([['開始目安', 'ファイル', 'フォルダ', '昨年の編集', '通知状態']])
    .setFontWeight('bold')
    .setBackground('#eeeeee');

  const formulas = [];
  for (let i = 0; i < REINEN_VIEW_MAX_ROWS; i += 1) {
    const dataRow = 2 + i;
    formulas.push([
      `=IF(Data!B${dataRow}="","",TEXT(Data!L${dataRow},"m月d日")&"ごろ")`,
      `=IF(Data!B${dataRow}="","",HYPERLINK(Data!N${dataRow},Data!B${dataRow}))`,
      `=IF(Data!B${dataRow}="","",Data!C${dataRow})`,
      `=IF(Data!B${dataRow}="","","昨年"&TEXT(Data!J${dataRow},"m月d日")&"～"&TEXT(Data!K${dataRow},"m月d日")&"の間に"&Data!E${dataRow}&"回編集")`,
      `=IF(Data!B${dataRow}="","",IF(COUNTIFS(State!A:A,Data!O${dataRow},State!C:C,YEAR(TODAY()),State!D:D,TRUE)>0,"今年は不要",IF(SUMIFS(State!E:E,State!A:A,Data!O${dataRow},State!C:C,YEAR(TODAY()))>NOW(),"あとで","通知対象")))`,
    ]);
  }
  sheet.getRange(5, 1, REINEN_VIEW_MAX_ROWS, 5).setFormulas(formulas);

  sheet.setFrozenRows(4);
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 420);
  sheet.setColumnWidth(4, 250);
  sheet.setColumnWidth(5, 120);
  sheet.getRange(`A4:E${4 + REINEN_VIEW_MAX_ROWS}`)
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.setRowHeights(5, REINEN_VIEW_MAX_ROWS, 52);

  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(`A4:E${4 + REINEN_VIEW_MAX_ROWS}`).createFilter();

  return sheet;
}
