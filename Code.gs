/**
 * Vehicle History Card – Google Apps Script backend
 *
 * Setup:
 *  1. Create a Google Sheet. Open Extensions > Apps Script and paste this file.
 *  2. Change ACCESS_KEY below to your own secret.
 *  3. Run setup() once from the editor and approve the permissions.
 *  4. Deploy > New deployment > Web app
 *       Execute as: Me   |   Who has access: Anyone
 *  5. Copy the Web app URL into API_URL at the top of index.html.
 *
 * After changing this file, use Deploy > Manage deployments > Edit > New version.
 */

const CONFIG = {
  ACCESS_KEY: 'CHANGE-THIS-KEY',   // typed on the login screen of the website
  SPREADSHEET_ID: '',              // leave empty when the script is opened from the Sheet itself

  // VIN = PREFIX + monthLetter + yy + FIXED_CHAR + 5-digit serial
  PREFIX: 'MAP1SRBP',
  FIXED_CHAR: 'L',
  INITIAL_SERIAL: 14,              // first VIN uses serial 15
  MAX_SERIAL: 99999,
  MAX_QTY: 10,
  TIMEZONE: 'Asia/Kolkata',

  // A filled-in value in any of these fields can belong to one vehicle only (blank is allowed).
  UNIQUE_FIELDS: ['batterySerial', 'chargerNo', 'motorNo', 'controllerNo'],
};

// No "I" in the month codes, same as the original script.
const MONTH_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M'];

const SHEET_VIN = 'VINs';
const SHEET_LOG = 'PrintLog';

const VIN_HEADERS = [
  'Serial', 'VIN', 'Generated At', 'Battery Make', 'Battery Serial No', 'Charger No',
  'Motor No', 'Controller No', 'Colour', 'EV Model', 'Print Count',
  'First Printed At', 'Last Printed At', 'Status',
];
const LOG_HEADERS = ['Timestamp', 'VIN', 'Print No', 'Type', 'Print ID', 'Reason'];

const COL = {
  serial: 1, vin: 2, generatedAt: 3, batteryMake: 4, batterySerial: 5, chargerNo: 6,
  motorNo: 7, controllerNo: 8, colour: 9, evModel: 10, printCount: 11,
  firstPrinted: 12, lastPrinted: 13, status: 14,
};

const FIELD_LABELS = {
  batterySerial: 'Battery serial no.',
  chargerNo: 'Charger no.',
  motorNo: 'Motor no.',
  controllerNo: 'Controller no.',
};

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function setup() {
  ensureSheets_();
}

function doGet() {
  return json_({ ok: true, service: 'Vehicle History Card API' });
}

function doPost(e) {
  let lock = null;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!req || req.key !== CONFIG.ACCESS_KEY) {
      return json_({ ok: false, error: 'Invalid access key.' });
    }

    // One request at a time: serials and print counts can never be handed out twice.
    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    ensureSheets_();

    let result;
    switch (req.action) {
      case 'ping':     result = {}; break;
      case 'generate': result = generate_(req); break;
      case 'save':     result = save_(req); break;
      case 'print':    result = print_(req); break;
      case 'list':     result = list_(req); break;
      default: throw new Error('Unknown action.');
    }
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function generate_(req) {
  const qty = parseInt(req.qty, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > CONFIG.MAX_QTY) {
    throw new Error('Quantity must be between 1 and ' + CONFIG.MAX_QTY + '.');
  }

  const sh = sheet_(SHEET_VIN);
  const props = PropertiesService.getScriptProperties();

  // The counter never goes backwards, even if rows are deleted from the sheet.
  const last = Math.max(
    Number(props.getProperty('LAST_SERIAL')) || 0,
    sheetMaxSerial_(sh),
    CONFIG.INITIAL_SERIAL
  );
  if (last + qty > CONFIG.MAX_SERIAL) {
    throw new Error('Serial limit reached (' + CONFIG.MAX_SERIAL + '). Contact the administrator.');
  }

  const now = new Date();
  const monthIndex = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M')) - 1;
  const yy = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yy');

  const rows = [];
  for (let i = 1; i <= qty; i++) {
    const serial = last + i;
    rows.push([serial, buildVin_(MONTH_CODES[monthIndex], yy, serial), now,
      '', '', '', '', '', '', '', 0, '', '', 'GENERATED']);
  }

  sh.getRange(sh.getLastRow() + 1, 1, rows.length, VIN_HEADERS.length).setValues(rows);
  props.setProperty('LAST_SERIAL', String(last + qty));
  SpreadsheetApp.flush();

  return { records: rows.map(rowToRecord_) };
}

function save_(req) {
  const vin = String(req.vin || '').trim();
  const d = req.details || {};
  const clean = {
    batteryMake: clean_(d.batteryMake),
    batterySerial: clean_(d.batterySerial),
    chargerNo: clean_(d.chargerNo),
    motorNo: clean_(d.motorNo),
    controllerNo: clean_(d.controllerNo),
    colour: clean_(d.colour),
    evModel: clean_(d.evModel),
  };

  // Battery, charger, motor and controller numbers are optional: the officer may write them by hand on the printed card.

  const sh = sheet_(SHEET_VIN);
  const rowNum = findRow_(sh, vin);
  if (!rowNum) throw new Error('VIN not found.');

  const row = sh.getRange(rowNum, 1, 1, VIN_HEADERS.length).getValues()[0];
  if (Number(row[COL.printCount - 1]) > 0) {
    throw new Error('This card was already printed. Its details are locked.');
  }

  // The same battery / motor / controller / charger can never sit on two vehicles.
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const all = sh.getRange(2, 1, lastRow - 1, VIN_HEADERS.length).getValues();
    CONFIG.UNIQUE_FIELDS.forEach(function (f) {
      const mine = clean[f].toUpperCase();
      if (!mine) return; // blank is allowed on any number of vehicles
      for (let i = 0; i < all.length; i++) {
        const other = all[i];
        if (String(other[COL.vin - 1]) === vin) continue;
        if (String(other[COL[f] - 1]).trim().toUpperCase() === mine) {
          throw new Error(FIELD_LABELS[f] + ' "' + clean[f] + '" is already used on ' + other[COL.vin - 1] + '.');
        }
      }
    });
  }

  sh.getRange(rowNum, COL.batteryMake, 1, 7).setValues([[
    clean.batteryMake, clean.batterySerial, clean.chargerNo, clean.motorNo,
    clean.controllerNo, clean.colour, clean.evModel,
  ]]);
  sh.getRange(rowNum, COL.status).setValue('READY');
  SpreadsheetApp.flush();

  return { record: rowToRecord_(sh.getRange(rowNum, 1, 1, VIN_HEADERS.length).getValues()[0]) };
}

function print_(req) {
  const vin = String(req.vin || '').trim();
  const reason = clean_(req.reason);

  const sh = sheet_(SHEET_VIN);
  const rowNum = findRow_(sh, vin);
  if (!rowNum) throw new Error('VIN not found.');

  const row = sh.getRange(rowNum, 1, 1, VIN_HEADERS.length).getValues()[0];
  const count = Number(row[COL.printCount - 1]) || 0;
  const next = count + 1;
  if (next > 1 && reason.length < 3) {
    throw new Error('A reason is required to reprint this card.');
  }

  const now = new Date();
  const type = next === 1 ? 'ORIGINAL' : 'REPRINT';
  const printId = vin.slice(-5) + '-P' + ('0' + next).slice(-2) + '-' +
    Utilities.getUuid().replace(/-/g, '').slice(0, 4).toUpperCase();

  sh.getRange(rowNum, COL.printCount).setValue(next);
  if (next === 1) sh.getRange(rowNum, COL.firstPrinted).setValue(now);
  sh.getRange(rowNum, COL.lastPrinted).setValue(now);
  sh.getRange(rowNum, COL.status).setValue('PRINTED');

  sheet_(SHEET_LOG).appendRow([now, vin, next, type, printId, reason]);
  SpreadsheetApp.flush();

  return {
    record: rowToRecord_(sh.getRange(rowNum, 1, 1, VIN_HEADERS.length).getValues()[0]),
    print: {
      no: next,
      type: type,
      id: printId,
      at: Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm'),
    },
  };
}

function list_(req) {
  const limit = Math.min(Math.max(parseInt(req.limit, 10) || 100, 1), 500);
  const sh = sheet_(SHEET_VIN);
  const lastRow = sh.getLastRow();
  let records = [];
  if (lastRow > 1) {
    const rows = sh.getRange(2, 1, lastRow - 1, VIN_HEADERS.length).getValues();
    records = rows.map(rowToRecord_).reverse().slice(0, limit);
  }
  return { records: records };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function buildVin_(monthCode, yy, serial) {
  return CONFIG.PREFIX + monthCode + yy + CONFIG.FIXED_CHAR + String(serial).padStart(5, '0');
}

function clean_(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);
  if (/^[=+\-@]/.test(s)) throw new Error('Values cannot start with = + - or @.');
  return s;
}

function fmt_(v, pattern) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, pattern || 'dd/MM/yy HH:mm');
  return String(v);
}

function rowToRecord_(r) {
  return {
    serial: Number(r[COL.serial - 1]),
    vin: String(r[COL.vin - 1]),
    generatedAt: fmt_(r[COL.generatedAt - 1], 'dd/MM/yy HH:mm'),
    generatedDate: fmt_(r[COL.generatedAt - 1], 'dd/MM/yy'),
    batteryMake: String(r[COL.batteryMake - 1] || ''),
    batterySerial: String(r[COL.batterySerial - 1] || ''),
    chargerNo: String(r[COL.chargerNo - 1] || ''),
    motorNo: String(r[COL.motorNo - 1] || ''),
    controllerNo: String(r[COL.controllerNo - 1] || ''),
    colour: String(r[COL.colour - 1] || ''),
    evModel: String(r[COL.evModel - 1] || ''),
    printCount: Number(r[COL.printCount - 1]) || 0,
    firstPrinted: fmt_(r[COL.firstPrinted - 1]),
    lastPrinted: fmt_(r[COL.lastPrinted - 1]),
    status: String(r[COL.status - 1] || ''),
  };
}

function findRow_(sh, vin) {
  if (!vin) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const vins = sh.getRange(2, COL.vin, lastRow - 1, 1).getValues();
  for (let i = 0; i < vins.length; i++) {
    if (String(vins[i][0]) === vin) return i + 2;
  }
  return 0;
}

function sheetMaxSerial_(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const vals = sh.getRange(2, COL.serial, lastRow - 1, 1).getValues();
  let max = 0;
  for (let i = 0; i < vals.length; i++) {
    const n = Number(vals[i][0]);
    if (n > max) max = n;
  }
  return max;
}

function spreadsheet_() {
  return CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setup() once.');
  return sh;
}

function ensureSheets_() {
  const ss = spreadsheet_();

  let vin = ss.getSheetByName(SHEET_VIN);
  if (!vin) vin = ss.insertSheet(SHEET_VIN);
  if (vin.getLastRow() === 0) {
    vin.getRange(1, 1, 1, VIN_HEADERS.length).setValues([VIN_HEADERS]).setFontWeight('bold');
    vin.setFrozenRows(1);
    // Plain text so numbers like 007123 keep their leading zeros.
    vin.getRange(1, COL.vin, vin.getMaxRows(), 1).setNumberFormat('@');
    vin.getRange(1, COL.batteryMake, vin.getMaxRows(), 7).setNumberFormat('@');
    vin.getRange(1, COL.generatedAt, vin.getMaxRows(), 1).setNumberFormat('dd/MM/yyyy HH:mm');
    vin.getRange(1, COL.firstPrinted, vin.getMaxRows(), 2).setNumberFormat('dd/MM/yyyy HH:mm');
  }

  let log = ss.getSheetByName(SHEET_LOG);
  if (!log) log = ss.insertSheet(SHEET_LOG);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    log.setFrozenRows(1);
    log.getRange(1, 1, log.getMaxRows(), 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
