/**
 * sheet-shortcut — Google Apps Script webhook
 * ---------------------------------------------------------------------------
 * Bound to your "Internships" spreadsheet. Deploy as a Web App
 * (Execute as: Me, Who has access: Anyone with the link). All requests must
 * carry the shared SECRET below, so the public URL alone is not enough to
 * read or write your sheet.
 *
 * Columns expected (row 1 headers): Company | Date Submitted | Link | Status
 *
 * Endpoints:
 *   GET  ?token=SECRET&limit=25      -> { ok, rows: [{row, company, date, link, status}] }
 *   POST {token, action:"append", company, date, link, status}
 *                                    -> { ok, row }
 *   POST {token, action:"update", row, company, date, link, status}
 *                                    -> { ok }
 */

// 1) Paste a long random string here (also put the SAME value in the app config).
//    Generate one with:  openssl rand -hex 24    (or any password generator)
var SECRET = 'REPLACE_WITH_A_LONG_RANDOM_TOKEN';

// 2) Which sheet/tab to write to. Leave as the active sheet, or set a name.
var SHEET_NAME = ''; // '' = first/active sheet; otherwise e.g. 'Applications'

var COLS = { COMPANY: 1, DATE: 2, LINK: 3, STATUS: 4 }; // 1-indexed columns
var FIRST_DATA_ROW = 2; // row 1 is headers

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  // constant-ish comparison; tokens are short so timing risk is negligible here
  return typeof token === 'string' && token.length > 0 && token === SECRET;
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!checkToken_(p.token)) return json_({ ok: false, error: 'unauthorized' });

    var sh = sheet_();
    var last = sh.getLastRow();
    if (last < FIRST_DATA_ROW) return json_({ ok: true, rows: [] });

    var limit = Math.max(1, Math.min(parseInt(p.limit, 10) || 25, 200));
    var start = Math.max(FIRST_DATA_ROW, last - limit + 1);
    var count = last - start + 1;
    var values = sh.getRange(start, 1, count, 4).getValues();

    var rows = [];
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      rows.push({
        row: start + i,
        company: String(v[0]),
        date: formatDate_(v[1]),
        link: String(v[2]),
        status: String(v[3])
      });
    }
    rows.reverse(); // newest first
    return json_({ ok: true, rows: rows });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });

    var sh = sheet_();
    var action = body.action || 'append';

    if (action === 'append') {
      var rowNum = Math.max(sh.getLastRow() + 1, FIRST_DATA_ROW);
      writeRow_(sh, rowNum, body);
      return json_({ ok: true, row: rowNum });
    }

    if (action === 'update') {
      var row = parseInt(body.row, 10);
      if (!row || row < FIRST_DATA_ROW) return json_({ ok: false, error: 'bad row' });
      writeRow_(sh, row, body);
      return json_({ ok: true });
    }

    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function writeRow_(sh, row, body) {
  // Only overwrite fields that were provided, so a partial edit won't blank others.
  if (body.company !== undefined) sh.getRange(row, COLS.COMPANY).setValue(body.company);
  if (body.date !== undefined)    sh.getRange(row, COLS.DATE).setValue(body.date);
  if (body.link !== undefined)    sh.getRange(row, COLS.LINK).setValue(body.link);
  if (body.status !== undefined)  sh.getRange(row, COLS.STATUS).setValue(body.status);
}

function formatDate_(v) {
  if (v instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v);
}
