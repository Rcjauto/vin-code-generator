/**
 * Vehicle History Card – Google Apps Script backend
 * (multi-product, logins in the sheet, hardened)
 *
 * Setup:
 *  1. Open your Google Sheet > Extensions > Apps Script and paste this file.
 *  2. Set ACCESS_KEY below to a long random value (24+ characters). The SAME value goes into
 *     the SCRIPT_KEY variable in Netlify. The script refuses to work with the default key.
 *  3. Check the VIN prefix of each product in PRODUCTS below against the paper notes, and set
 *     initialSerial if a product must continue from an existing number.
 *  4. Run setup() once from the editor. It creates the "Users" tab, the "AuditLog" tab and one
 *     VIN tab and one print-log tab per product, and locks Users and AuditLog to the owner.
 *  5. Open the "Users" tab and fill in ID, Password, Product and set Active to YES.
 *     Passwords you type in plain text are converted to a protected form the first time that
 *     user logs in (or when you run hashPasswords()).
 *  6. Deploy > Manage deployments > Edit > New version  (Execute as: Me, Who has access: Anyone).
 *
 * Security notes
 *  - Passwords are stored as a keyed hash. The key ("pepper") lives in Script Properties, not in
 *    the sheet, so a copy of the sheet alone cannot be used to guess passwords offline.
 *  - After 5 wrong passwords for one ID, that ID is locked for 15 minutes.
 *  - Changing a password, switching a user to NO, or changing a user's product ends that user's
 *    open sessions at once.
 *  - Every login, failed login, lockout, VIN generation and print is written to the AuditLog tab.
 *  - To change a password: type the new one in plain text in the Password cell. It is converted
 *    at the next login, or run hashPasswords() to convert it now.
 *
 * Each product has its own VIN tab, print-log tab and serial counter, so serials never mix.
 */

const CONFIG = {
  ACCESS_KEY: 'CHANGE-THIS-KEY',   // 24+ random characters; must equal SCRIPT_KEY in Netlify
  SPREADSHEET_ID: '',              // leave empty when the script is opened from the Sheet itself

  MAX_QTY: 10,
  TIMEZONE: 'Asia/Kolkata',

  MAX_LOGIN_FAILS: 5,              // wrong passwords allowed per ID ...
  LOCK_MINUTES: 15,                // ... before that ID is locked for this long

  // A filled-in value in any of these fields can belong to one vehicle only (blank is allowed).
  UNIQUE_FIELDS: ['batterySerial', 'chargerNo', 'motorNo', 'controllerNo'],
};

/**
 * VIN = prefix + monthLetter + year + fixedChar + serial
 *   year:   yearStyle 'yy'     -> last two digits of the year, e.g. 26
 *           yearStyle 'letter' -> the standard model-year letter, e.g. T for 2026
 *   serial: serialDigits long, zero padded (5 digits = 00015, 6 digits = 000015)
 * The key ("scooter", "atomplus", ...) is what you write in the Product column of the Users tab.
 * A product whose prefix starts with CHANGE cannot generate VINs (safety check).
 * Each product has its own VIN tab, print-log tab and serial counter.
 */
const PRODUCTS = {
  scooter: {
    name: 'E-Scooter',
    prefix: 'MAP1SRBP',
    fixedChar: 'L',
    yearStyle: 'yy',
    serialDigits: 5,
    initialSerial: 14,               // first VIN uses serial 15
    vinSheet: 'VINs',
    logSheet: 'PrintLog',
    counterKey: 'LAST_SERIAL',
  },
  atomplus: {
    name: 'Atom Plus',
    prefix: 'MAP4ECBP',              // example from the notes: MAP4ECBP D 23 L 01249
    fixedChar: 'L',
    yearStyle: 'yy',                 // month and year code same as the scooter
    serialDigits: 5,
    initialSerial: 0,                // first VIN uses serial 1
    vinSheet: 'VINs_AtomPlus',
    logSheet: 'PrintLog_AtomPlus',
    counterKey: 'LAST_SERIAL_ATOMPLUS',
  },
  atomdlx: {
    name: 'Atom DLX',
    prefix: 'MAP4EMBP',              // example from the notes: MAP4EMBP K T L 000567
    fixedChar: 'L',
    yearStyle: 'letter',             // one year letter (T = 2026) instead of two digits
    serialDigits: 6,
    initialSerial: 0,
    vinSheet: 'VINs_AtomDLX',
    logSheet: 'PrintLog_AtomDLX',
    counterKey: 'LAST_SERIAL_ATOMDLX',
  },
  maxmile: {
    name: 'Max Mile',
    prefix: 'MAP3TGBP',              // example from the notes: MAP3TGBP K 26 L 00007
    fixedChar: 'L',
    yearStyle: 'yy',
    serialDigits: 5,
    initialSerial: 0,
    vinSheet: 'VINs_MaxMile',
    logSheet: 'PrintLog_MaxMile',
    counterKey: 'LAST_SERIAL_MAXMILE',
  },
};

// No "I" in the month codes, same as the original script.
const MONTH_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M'];

// Standard model-year letters (no I, O, Q, U, Z, 0). 2010 = A ... 2026 = T, 2027 = V, 2030 = Y, 2031 = 1.
const YEAR_LETTERS = 'ABCDEFGHJKLMNPRSTVWXY123456789';
function yearLetter_(year) {
  return YEAR_LETTERS.charAt((((year - 2010) % 30) + 30) % 30);
}

const SHEET_USERS = 'Users';
const SHEET_AUDIT = 'AuditLog';
const USER_HEADERS = ['ID', 'Password', 'Product', 'Active'];
const AUDIT_HEADERS = ['Timestamp', 'Event', 'ID', 'Product', 'Detail'];
const HASH_PREFIX = 'hmac:';
const OLD_HASH_PREFIX = 'sha256:';   // from an earlier version; those users must type the password again

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

const BAD_LOGIN = 'Invalid ID or password.';

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function setup() {
  ensureUsersSheet_();
  ensureAuditSheet_();
  Object.keys(PRODUCTS).forEach(function (id) { ensureSheets_(PRODUCTS[id]); });
  getPepper_(); // creates the password key once
}

/**
 * Converts every plain-text password in the Users tab to the protected form now.
 * Optional: a plain password is also converted automatically at that user's next login.
 */
function hashPasswords() {
  const sh = sheet_(SHEET_USERS);
  const last = sh.getLastRow();
  if (last < 2) return;
  const range = sh.getRange(2, 1, last - 1, 2);
  const vals = range.getValues();
  let changed = 0;
  vals.forEach(function (r) {
    const id = String(r[0]).trim();
    const pw = String(r[1]).trim();
    if (!id || !pw) return;
    if (pw.indexOf(HASH_PREFIX) === 0) return;
    if (pw.indexOf(OLD_HASH_PREFIX) === 0) {
      Logger.log('User "' + id + '" has an old-style password. Type a new password in the cell.');
      return;
    }
    r[1] = hashPw_(id, pw);
    changed++;
  });
  range.setValues(vals);
  SpreadsheetApp.flush();
  Logger.log(changed + ' password(s) converted.');
}

function doGet() {
  return json_({ ok: true, service: 'Vehicle History Card API' });
}

function doPost(e) {
  let lock = null;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    const problem = configProblem_();
    if (problem) return json_({ ok: false, error: problem });
    if (!req || !safeEq_(req.key, CONFIG.ACCESS_KEY)) {
      return json_({ ok: false, error: 'Invalid access key.' });
    }

    // One request at a time: serials, print counts and login counters can never be handed out twice.
    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    if (req.action === 'login') return json_(login_(req));

    // Every other action needs a live session: the user must still be active, still on the same
    // product and still have the same password as when the session started.
    const user = authorize_(req.id, req.product, req.ver);
    if (!user) return json_({ ok: false, code: 'AUTH', error: 'Session expired. Please log in again.' });
    const productId = user.product;
    const p = PRODUCTS[productId];

    ensureSheets_(p);

    let result;
    switch (req.action) {
      case 'ping':
        result = { product: { id: productId, name: p.name, serialDigits: p.serialDigits } };
        break;
      case 'generate':
        result = generate_(req, p);
        audit_('GENERATE', user.id, productId, result.records.length + ' VIN(s): ' +
          result.records[0].vin + (result.records.length > 1 ? ' to ' + result.records[result.records.length - 1].vin : ''));
        break;
      case 'save':
        result = save_(req, p);
        break;
      case 'print':
        result = print_(req, p);
        audit_(result.print.no > 1 ? 'REPRINT' : 'PRINT', user.id, productId,
          result.record.vin + ' print ' + result.print.no + (req.reason ? ' - ' + clean_(req.reason) : ''));
        break;
      case 'list':
        result = list_(req, p);
        break;
      default:
        throw new Error('Unknown action.');
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
/* Security helpers                                                    */
/* ------------------------------------------------------------------ */

function configProblem_() {
  const k = String(CONFIG.ACCESS_KEY || '');
  if (k === 'CHANGE-THIS-KEY' || k.length < 24) {
    return 'The server key is not set. Set ACCESS_KEY in Code.gs to a long random value (24+ characters).';
  }
  return '';
}

/** Compares two strings without stopping at the first difference. */
function safeEq_(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** The password key. Created once, kept in Script Properties (never in the sheet). */
function getPepper_() {
  const props = PropertiesService.getScriptProperties();
  let pepper = props.getProperty('PEPPER');
  if (!pepper) {
    pepper = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PEPPER', pepper);
  }
  return pepper;
}

function hashPw_(id, pw) {
  const sig = Utilities.computeHmacSha256Signature(
    String(id).trim().toLowerCase() + '|' + String(pw).trim(), getPepper_());
  return HASH_PREFIX + hex_(sig);
}

/** A short fingerprint of the stored password cell. It changes whenever the password changes. */
function userVer_(stored) {
  return hex_(Utilities.computeHmacSha256Signature('ver|' + String(stored), getPepper_())).slice(0, 16);
}

function cellSafe_(v) {
  const s = String(v == null ? '' : v).slice(0, 120);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function audit_(event, id, product, detail) {
  try {
    const sh = ensureAuditSheet_();
    sh.appendRow([new Date(), event, cellSafe_(id), cellSafe_(product), cellSafe_(detail)]);
  } catch (ignore) {
    // The audit log must never stop real work.
  }
}

/** Only the owner can edit this tab. */
function lockSheetToOwner_(sh, description) {
  try {
    if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0) return;
    const prot = sh.protect().setDescription(description);
    const me = Session.getEffectiveUser();
    prot.addEditor(me);
    prot.removeEditors(prot.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
    if (prot.canDomainEdit()) prot.setDomainEdit(false);
  } catch (ignore) {
    // Protection is a bonus layer; the logins still work if it cannot be set.
  }
}

/* ------------------------------------------------------------------ */
/* Users and sessions                                                  */
/* ------------------------------------------------------------------ */

function readUsers_() {
  const sh = spreadsheet_().getSheetByName(SHEET_USERS);
  if (!sh || sh.getLastRow() < 2) return { sh: sh, users: [] };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, USER_HEADERS.length).getValues();
  const users = rows.map(function (r, i) {
    return {
      rowNum: i + 2,
      id: String(r[0]).trim().toLowerCase(),
      stored: String(r[1]).trim(),
      product: String(r[2]).trim().toLowerCase(),
      active: String(r[3]).trim().toUpperCase() === 'YES',
    };
  }).filter(function (u) {
    return u.id && u.stored && u.active && Object.prototype.hasOwnProperty.call(PRODUCTS, u.product);
  });
  return { sh: sh, users: users };
}

function login_(req) {
  const wantId = String(req.id == null ? '' : req.id).trim().toLowerCase().slice(0, 100);
  const wantPw = String(req.password == null ? '' : req.password).trim().slice(0, 100);
  const cache = CacheService.getScriptCache();
  const cacheKey = 'f:' + wantId;

  if (!wantId || !wantPw) return { ok: false, error: BAD_LOGIN };

  // Locked after too many wrong passwords, whether or not the ID exists.
  const fails = Number(cache.get(cacheKey)) || 0;
  if (fails >= CONFIG.MAX_LOGIN_FAILS) {
    audit_('LOGIN_LOCKED', wantId, '', 'attempt while locked');
    return { ok: false, error: 'Too many wrong attempts. Try again in ' + CONFIG.LOCK_MINUTES + ' minutes.' };
  }

  const data = readUsers_();
  let user = null;
  data.users.forEach(function (u) { if (!user && u.id === wantId) user = u; });

  // Always compute the hash so a wrong ID and a wrong password take about the same time.
  const attempt = hashPw_(wantId, wantPw);
  let ok = false;
  let upgrade = false;
  if (user) {
    if (user.stored.indexOf(HASH_PREFIX) === 0) {
      ok = safeEq_(user.stored, attempt);
    } else if (user.stored.indexOf(OLD_HASH_PREFIX) === 0) {
      ok = false; // old-style hash cannot be checked; the administrator must type a new password
    } else {
      ok = safeEq_(user.stored, wantPw);
      upgrade = ok;
    }
  }

  if (!ok) {
    cache.put(cacheKey, String(fails + 1), CONFIG.LOCK_MINUTES * 60);
    audit_('LOGIN_FAIL', wantId, '', (fails + 1) + ' wrong attempt(s)');
    return { ok: false, error: BAD_LOGIN };
  }

  // Each product has its own page. The password was right, so it is safe to say where this login belongs.
  const site = String(req.site == null ? '' : req.site).trim().toLowerCase().slice(0, 40);
  if (site && site !== user.product) {
    audit_('LOGIN_WRONG_PAGE', wantId, user.product, 'tried the ' + site + ' page');
    return { ok: false, error: 'This login is not for ' +
      (Object.prototype.hasOwnProperty.call(PRODUCTS, site) ? PRODUCTS[site].name : 'this page') +
      '. Open your own product page.' };
  }

  cache.remove(cacheKey);
  let stored = user.stored;
  if (upgrade) {
    data.sh.getRange(user.rowNum, 2).setValue(attempt); // plain password becomes the protected form
    SpreadsheetApp.flush();
    stored = attempt;
  }

  audit_('LOGIN_OK', wantId, user.product, '');
  return {
    ok: true,
    product: { id: user.product, name: PRODUCTS[user.product].name, serialDigits: PRODUCTS[user.product].serialDigits },
    ver: userVer_(stored),
  };
}

/** Checks that the session's user is still allowed. Returns { id, product } or null. */
function authorize_(id, product, ver) {
  const wantId = String(id == null ? '' : id).trim().toLowerCase();
  const wantProd = String(product == null ? '' : product).trim().toLowerCase();
  const wantVer = String(ver == null ? '' : ver);
  if (!wantId || !wantProd || !wantVer) return null;

  const data = readUsers_();
  let found = null;
  data.users.forEach(function (u) {
    if (found || u.id !== wantId || u.product !== wantProd) return;
    if (safeEq_(userVer_(u.stored), wantVer)) found = { id: u.id, product: u.product };
  });
  return found;
}

function ensureUsersSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(SHEET_USERS);
  if (!sh) sh = ss.insertSheet(SHEET_USERS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Plain text so passwords like 007123 keep their leading zeros.
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
    // One empty, switched-off row per product: fill in the ID and password, then set Active to YES.
    sh.getRange(2, 1, Object.keys(PRODUCTS).length, USER_HEADERS.length).setValues(
      Object.keys(PRODUCTS).map(function (id) { return [id, '', id, 'NO']; }));
    sh.setColumnWidth(1, 140);
    sh.setColumnWidth(2, 300);
  }
  // Refreshed on every setup() run, so newly added products appear in the Product dropdown.
  sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(PRODUCTS), true).setAllowInvalid(false).build());
  sh.getRange(2, 4, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['YES', 'NO'], true).setAllowInvalid(false).build());
  lockSheetToOwner_(sh, 'Logins - owner only');
  return sh;
}

function ensureAuditSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(SHEET_AUDIT);
  if (!sh) sh = ss.insertSheet(SHEET_AUDIT);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
    sh.setColumnWidth(5, 380);
    lockSheetToOwner_(sh, 'Audit log - owner only');
  }
  return sh;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function generate_(req, p) {
  if (!p.prefix || String(p.prefix).indexOf('CHANGE') === 0) {
    throw new Error('The VIN prefix for ' + p.name + ' is not set yet. Set it in PRODUCTS in Code.gs and deploy a new version.');
  }
  const qty = parseInt(req.qty, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > CONFIG.MAX_QTY) {
    throw new Error('Quantity must be between 1 and ' + CONFIG.MAX_QTY + '.');
  }

  const sh = sheet_(p.vinSheet);
  const props = PropertiesService.getScriptProperties();

  // The counter never goes backwards, even if rows are deleted from the sheet.
  const last = Math.max(
    Number(props.getProperty(p.counterKey)) || 0,
    sheetMaxSerial_(sh),
    p.initialSerial
  );
  const maxSerial = Math.pow(10, p.serialDigits) - 1;
  if (last + qty > maxSerial) {
    throw new Error('Serial limit reached (' + maxSerial + '). Contact the administrator.');
  }

  const now = new Date();
  const monthIndex = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M')) - 1;
  const yearPart = p.yearStyle === 'letter'
    ? yearLetter_(Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy')))
    : Utilities.formatDate(now, CONFIG.TIMEZONE, 'yy');

  const rows = [];
  for (let i = 1; i <= qty; i++) {
    const serial = last + i;
    rows.push([serial, buildVin_(p, MONTH_CODES[monthIndex], yearPart, serial), now,
      '', '', '', '', '', '', '', 0, '', '', 'GENERATED']);
  }

  sh.getRange(sh.getLastRow() + 1, 1, rows.length, VIN_HEADERS.length).setValues(rows);
  props.setProperty(p.counterKey, String(last + qty));
  SpreadsheetApp.flush();

  return { records: rows.map(rowToRecord_) };
}

function save_(req, p) {
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

  const sh = sheet_(p.vinSheet);
  const rowNum = findRow_(sh, vin);
  if (!rowNum) throw new Error('VIN not found.');

  const row = sh.getRange(rowNum, 1, 1, VIN_HEADERS.length).getValues()[0];
  if (Number(row[COL.printCount - 1]) > 0) {
    throw new Error('This card was already printed. Its details are locked.');
  }

  // The same battery / motor / controller / charger can never sit on two vehicles of this product.
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

function print_(req, p) {
  const vin = String(req.vin || '').trim();
  const reason = clean_(req.reason);

  const sh = sheet_(p.vinSheet);
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

  sheet_(p.logSheet).appendRow([now, vin, next, type, printId, reason]);
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

function list_(req, p) {
  const limit = Math.min(Math.max(parseInt(req.limit, 10) || 100, 1), 500);
  const sh = sheet_(p.vinSheet);
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

function buildVin_(p, monthCode, yearPart, serial) {
  return p.prefix + monthCode + yearPart + p.fixedChar + String(serial).padStart(p.serialDigits, '0');
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

function ensureSheets_(p) {
  const ss = spreadsheet_();

  let vin = ss.getSheetByName(p.vinSheet);
  if (!vin) vin = ss.insertSheet(p.vinSheet);
  if (vin.getLastRow() === 0) {
    vin.getRange(1, 1, 1, VIN_HEADERS.length).setValues([VIN_HEADERS]).setFontWeight('bold');
    vin.setFrozenRows(1);
    // Plain text so numbers like 007123 keep their leading zeros.
    vin.getRange(1, COL.vin, vin.getMaxRows(), 1).setNumberFormat('@');
    vin.getRange(1, COL.batteryMake, vin.getMaxRows(), 7).setNumberFormat('@');
    vin.getRange(1, COL.generatedAt, vin.getMaxRows(), 1).setNumberFormat('dd/MM/yyyy HH:mm');
    vin.getRange(1, COL.firstPrinted, vin.getMaxRows(), 2).setNumberFormat('dd/MM/yyyy HH:mm');
  }

  let log = ss.getSheetByName(p.logSheet);
  if (!log) log = ss.insertSheet(p.logSheet);
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
