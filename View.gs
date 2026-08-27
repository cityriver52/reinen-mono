/**
 * Re:年モノ - human-readable View sheet
 *
 * Data / State は内部台帳のまま維持し、View は数式でそれらを参照する。
 * View は開始目安順で表示し、スコアは5段階の相対重要度として見せる。
 */
const REINEN_VIEW_SHEET_NAME = 'View';
const REINEN_VIEW_MAX_ROWS = 50;
const REINEN_VIEW_VERSION = '3';

function getReinenViewUrl_(spreadsheet) {
  const sheet = ensureReinenViewSheet_(spreadsheet);
  return `${spreadsheet.getUrl()}#gid=${sheet.getSheetId()}`;
}

function ensureReinenViewSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(REINEN_VIEW_SHEET_NAME) ||
    spreadsheet.insertSheet(REINEN_VIEW_SHEET_NAME);

  const marker = sheet.getRange('A1').getDisplayValue();
  const version = sheet.getRange('Z1').getDisplayValue();
  if (marker !== 'Re:年モノ' || version !== REINEN_VIEW_VERSION) {
    initializeReinenViewSheet_(sheet);
  }
  return sheet;
}

function initializeReinenViewSheet_(sheet) {
  const minimumColumns = 26;
  if (sheet.getMaxColumns() < minimumColumns) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      minimumColumns - sheet.getMaxColumns()
    );
  }

  sheet.clear();
  sheet.clearConditionalFormatRules();

  sheet.getRange('A1:G1').merge();
  sheet.getRange('A1')
    .setValue('Re:年モノ')
    .setFontSize(16)
    .setFontWeight('bold');

  sheet.getRange('A2:G2').merge();
  sheet.getRange('A2')
    .setValue('開始目安が近い順です。重要度は、この一覧内のスコアを5段階で相対表示しています。「一緒に使う」は昨年度の近接編集パターンから抽出しています。')
    .setFontColor('#5f6368');

  sheet.getRange('A4:G4')
    .setValues([['開始目安', '重要度', 'ファイル', 'フォルダ', '昨年の編集', '一緒に使う', '通知状態']])
    .setFontWeight('bold')
    .setBackground('#eeeeee');

  // H:Y は表示順を作る内部ヘルパー。Dataをexpected_start昇順、同日ならscore降順に並べる。
  sheet.getRange('H5').setFormula(
    `=IFERROR(SORT(FILTER(Data!A2:R${REINEN_VIEW_MAX_ROWS + 1},Data!B2:B${REINEN_VIEW_MAX_ROWS + 1}<>""),12,TRUE,1,FALSE),"")`
  );

  const formulas = [];
  for (let i = 0; i < REINEN_VIEW_MAX_ROWS; i += 1) {
    const viewRow = 5 + i;
    formulas.push([
      `=IF($I${viewRow}="","",TEXT($S${viewRow},"m月d日")&"ごろ")`,
      `=IF($I${viewRow}="","",REPT("●",MAX(1,ROUND($H${viewRow}/MAX($H$5:$H$${4 + REINEN_VIEW_MAX_ROWS})*5,0)))&REPT("○",5-MAX(1,ROUND($H${viewRow}/MAX($H$5:$H$${4 + REINEN_VIEW_MAX_ROWS})*5,0))))`,
      `=IF($I${viewRow}="","",HYPERLINK($U${viewRow},$I${viewRow}))`,
      `=IF($I${viewRow}="","",$J${viewRow})`,
      `=IF($I${viewRow}="","","昨年"&TEXT($Q${viewRow},"m月d日")&"～"&TEXT($R${viewRow},"m月d日")&"の間に"&$L${viewRow}&"回編集")`,
      `=IF($I${viewRow}="","",IFERROR(INDEX(Data!S:S,MATCH($V${viewRow},Data!O:O,0)),""))`,
      `=IF($I${viewRow}="","",IF(COUNTIFS(State!A:A,$V${viewRow},State!C:C,YEAR(TODAY()),State!D:D,TRUE)>0,"今年は不要",IF(SUMIFS(State!E:E,State!A:A,$V${viewRow},State!C:C,YEAR(TODAY()))>NOW(),"あとで","通知対象")))`,
    ]);
  }
  sheet.getRange(5, 1, REINEN_VIEW_MAX_ROWS, 7).setFormulas(formulas);

  sheet.getRange('Z1').setValue(REINEN_VIEW_VERSION);

  sheet.setFrozenRows(4);
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 300);
  sheet.setColumnWidth(4, 420);
  sheet.setColumnWidth(5, 250);
  sheet.setColumnWidth(6, 360);
  sheet.setColumnWidth(7, 120);
  sheet.getRange(`A4:G${4 + REINEN_VIEW_MAX_ROWS}`)
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.getRange(`B5:B${4 + REINEN_VIEW_MAX_ROWS}`)
    .setFontColor('#5b78a6')
    .setHorizontalAlignment('center');
  sheet.setRowHeights(5, REINEN_VIEW_MAX_ROWS, 68);

  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(`A4:G${4 + REINEN_VIEW_MAX_ROWS}`).createFilter();

  // 内部ヘルパー列は利用者には見せない。
  sheet.hideColumns(8, 19); // H:Z

  return sheet;
}
