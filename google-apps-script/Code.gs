/* ============================================================
   共通ロジック(デモ版のブラウザと、Google Apps Script の両方で使う)
   ※ このファイルは build.py で index.html と Code.gs に埋め込まれます
   ============================================================ */
var STATUSES = ["検品待ち","修理・整備中","出品中","売約済み","入金済み","部品取り"];
var CHANNELS = ["自社サイト","フリマアプリ","輸出業者"];
var CHECK_KUBUN = ["対面・身分証明書等の提示","対面・署名した書面の交付","非対面・本人限定受取郵便等"];
var CHECK_METHOD = ["運転免許証","マイナンバーカード","パスポート","在留カード","署名書面","本人限定受取郵便"];
var ACTIVE_STATUSES = ["検品待ち","修理・整備中","出品中"];
var SOLD_STATUSES = ["売約済み","入金済み"];
// ボタン1つで進める「次の段階」
var NEXT_STEP = {
  "検品待ち":     { to:"修理・整備中", label:"検品完了" },
  "修理・整備中": { to:"出品中",       label:"出品済みにする" },
  "出品中":       { to:"売約済み",     label:"販売登録" },
  "売約済み":     { to:"入金済み",     label:"入金確認", admin:true },
};

function pad2(n){ return (n < 10 ? "0" : "") + n; }
function isoDate(d){ return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()); }
function parseDate(s){ var a = String(s).split("-"); return new Date(Number(a[0]), Number(a[1])-1, Number(a[2])); }
function addDaysIso(s, n){ var d = parseDate(s); d.setDate(d.getDate()+n); return isoDate(d); }
function daysBetween(a, b){ return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
function yenText(n){ return "¥" + Math.round(Number(n)||0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function str(v){ return v === null || v === undefined ? "" : String(v).trim(); }
function numOrNull(v){ if (v === "" || v === null || v === undefined) return null; var n = Number(v); return isNaN(n) ? null : n; }

function nextLedgerNo(S, date){
  var year = date.slice(0,4), max = 0;
  S.ledger.forEach(function(l){
    if (l.no.indexOf("K-" + year + "-") === 0){ var n = Number(l.no.slice(7)); if (n > max) max = n; }
  });
  return "K-" + year + "-" + ("000" + (max + 1)).slice(-4);
}

/* 在庫の状態を変えるときの共通処理(台帳の払出し欄・残高も連動させる) */
function changeItem(S, me, ctx, item, p){
  var isAdmin = me.role === "admin";
  var to = p.status !== undefined ? p.status : item.status, from = item.status;
  if (STATUSES.indexOf(to) < 0) return "状態の指定が正しくありません";
  if (to === "入金済み" && !isAdmin && from !== "入金済み") return "入金確認は管理者のみ実行できます";
  var next = {
    channel:   p.channel   !== undefined ? str(p.channel) : item.channel,
    listPrice: p.listPrice !== undefined ? numOrNull(p.listPrice) : item.listPrice,
    soldPrice: p.soldPrice !== undefined ? numOrNull(p.soldPrice) : item.soldPrice,
    payDue:    p.payDue    !== undefined ? str(p.payDue) : item.payDue,
    memo:      p.memo      !== undefined ? str(p.memo) : item.memo,
  };
  if (to === "売約済み" && (!next.channel || !next.soldPrice || !next.payDue)) return "販売登録には、販売先・販売額・入金予定日が必要です";
  item.channel = next.channel; item.listPrice = next.listPrice; item.soldPrice = next.soldPrice;
  item.payDue = next.payDue; item.memo = next.memo;
  if (isAdmin && p.partsCost !== undefined) item.partsCost = numOrNull(p.partsCost) || 0;
  if (SOLD_STATUSES.indexOf(to) >= 0){
    if (!item.soldDate) item.soldDate = ctx.today;
    var l = findLedger(S, item.ledgerNo);
    if (l) l.out = { date:item.soldDate, kubun:"売却", price:item.soldPrice, partnerType:item.channel };
  }
  if (to === "入金済み" && from === "売約済み") S.settings.balance += Number(item.soldPrice) || 0;
  if (to !== from){
    item.status = to;
    item.history.push({ at:ctx.stamp, by:me.name, from:from, to:to, note:str(p.note) });
  }
  return null;
}
function findLedger(S, no){ for (var i = 0; i < S.ledger.length; i++) if (S.ledger[i].no === no) return S.ledger[i]; return null; }
function findById(list, id){ for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i]; return null; }
function addLog(S, ctx, me, text){ S.log.unshift({ at:ctx.stamp, by:me.name, text:text }); if (S.log.length > 300) S.log.length = 300; }

/* すべての書き込みはここを通る。戻り値:エラー文(成功なら null) */
function applyAction(S, me, name, p, ctx){
  var isAdmin = me.role === "admin";
  var adminOnly = ["buy","fixLedger","payDone","recDone","addMoney","removeMoney","saveSettings"];
  if (adminOnly.indexOf(name) >= 0 && !isAdmin) return "この操作は管理者のみ実行できます";
  p = p || {};

  if (name === "buy"){
    var need = { date:"取引年月日", model:"メーカー・機種", storage:"容量", price:"代価(買取額)", addr:"相手方の住所", name:"相手方の氏名", job:"相手方の職業", age:"相手方の年齢" };
    for (var k in need) if (!str(p[k])) return need[k] + "を入力してください";
    var price = Number(p.price), age = Number(p.age);
    if (!(price > 0)) return "代価は1円以上で入力してください";
    if (!(age >= 0 && age < 130)) return "年齢を正しく入力してください";
    var no = nextLedgerNo(S, str(p.date));
    var serialTail = str(p.serial);
    var serial = serialTail ? ((p.type === "ノートパソコン" ? "S/N ****" : "IMEI ****") + serialTail) : "番号未記入";
    S.ledger.push({ no:no, date:str(p.date), kubun:str(p.kubun) || "買受け", hinmoku:str(p.type) || "スマートフォン", qty:1,
      tokucho:[str(p.model), str(p.storage), str(p.color)].filter(String).join(" ") + " / " + serial + " / 外装" + (str(p.grade) || "-") + "ランク",
      price:price, partner:{ addr:str(p.addr), name:str(p.name), job:str(p.job), age:age },
      check:{ kubun:str(p.ck) || CHECK_KUBUN[0], method:str(p.cm) || CHECK_METHOD[0] }, out:null, corrections:[],
      by:me.name, createdAt:ctx.stamp });
    S.items.push({ id:no, ledgerNo:no, type:str(p.type) || "スマートフォン", model:str(p.model), storage:str(p.storage), color:str(p.color),
      grade:str(p.grade), cost:price, partsCost:0, status:"検品待ち", channel:"", listPrice:null, soldPrice:null, soldDate:"", payDue:"", memo:"",
      history:[{ at:ctx.stamp, by:me.name, from:"", to:"検品待ち", note:"買取登録" }] });
    if (p.paidNow !== false) S.settings.balance -= price;
    addLog(S, ctx, me, "買取登録 " + no + "(" + yenText(price) + ")");
    return null;
  }
  if (name === "updateItem" || name === "nextStep"){
    var item = findById(S.items, p.id);
    if (!item) return "在庫が見つかりません";
    if (name === "nextStep"){
      var ns = NEXT_STEP[item.status];
      if (!ns) return "次のステータスはありません";
      p.status = ns.to;
    }
    return changeItem(S, me, ctx, item, p);
  }
  if (name === "fixLedger"){
    var l = findLedger(S, p.no);
    if (!l) return "台帳が見つかりません";
    var map = { "特徴":"tokucho", "代価":"price", "住所":"addr", "氏名":"name", "職業":"job", "年齢":"age" };
    var key = map[p.field];
    if (!key) return "訂正する項目が正しくありません";
    var after = str(p.after), reason = str(p.reason);
    if (!after || !reason) return "訂正後の内容と訂正理由を入力してください";
    var inPartner = ["addr","name","job","age"].indexOf(key) >= 0;
    var before = inPartner ? l.partner[key] : l[key];
    if (String(before) === after) return "内容が変わっていません";
    var val = (key === "price" || key === "age") ? Number(after) : after;
    if ((key === "price" || key === "age") && isNaN(val)) return "数字で入力してください";
    if (inPartner) l.partner[key] = val; else l[key] = val;
    if (key === "price"){ var it = findById(S.items, p.no); if (it) it.cost = val; }
    l.corrections.push({ at:ctx.stamp, by:me.name, field:p.field, before:String(before), after:after, reason:reason });
    addLog(S, ctx, me, "台帳訂正 " + p.no + "【" + p.field + "】");
    return null;
  }
  if (name === "payDone"){
    var pay = findById(S.payables, p.id);
    if (!pay || pay.done) return "支払予定が見つかりません";
    pay.done = true; S.settings.balance -= Number(pay.amount);
    addLog(S, ctx, me, "支払 " + pay.to + " " + yenText(pay.amount));
    return null;
  }
  if (name === "recDone"){
    if (String(p.id).indexOf("item:") === 0){
      var itm = findById(S.items, String(p.id).slice(5));
      if (!itm) return "在庫が見つかりません";
      var e = changeItem(S, me, ctx, itm, { status:"入金済み", note:"入金確認" });
      if (!e) addLog(S, ctx, me, "入金 " + itm.model + " " + yenText(itm.soldPrice));
      return e;
    }
    var rec = findById(S.receivables, p.id);
    if (!rec || rec.done) return "入金予定が見つかりません";
    rec.done = true; S.settings.balance += Number(rec.amount);
    addLog(S, ctx, me, "入金 " + rec.from + " " + yenText(rec.amount));
    return null;
  }
  if (name === "addMoney"){
    var amount = Number(p.amount), due = str(p.due), who = str(p.who);
    if (!due || !(amount > 0) || !who) return "日付・金額・相手先を入力してください";
    var id = (p.kind === "pay" ? "P" : "R") + ctx.stamp.replace(/\D/g, "") + Math.floor(Math.random()*1000);
    if (p.kind === "pay") S.payables.push({ id:id, due:due, to:who, desc:str(p.desc), amount:amount, done:false });
    else S.receivables.push({ id:id, due:due, from:who, desc:str(p.desc), amount:amount, done:false });
    addLog(S, ctx, me, (p.kind === "pay" ? "支払予定" : "入金予定") + "を追加 " + who + " " + yenText(amount));
    return null;
  }
  if (name === "removeMoney"){
    var list = p.kind === "pay" ? S.payables : S.receivables;
    for (var i = 0; i < list.length; i++){
      if (String(list[i].id) === String(p.id)){
        if (list[i].done) return "済みの予定は取り消せません";
        addLog(S, ctx, me, "予定を取り消し " + (list[i].to || list[i].from) + " " + yenText(list[i].amount));
        list.splice(i, 1); return null;
      }
    }
    return "予定が見つかりません";
  }
  if (name === "saveSettings"){
    var b = Number(p.balance), s = Number(p.safety);
    if (isNaN(b) || isNaN(s)) return "数字で入力してください";
    S.settings.balance = b; S.settings.safety = s;
    addLog(S, ctx, me, "口座残高・安全ラインを更新");
    return null;
  }
  return "不明な操作です";
}

/* メンバーに見せてよい範囲だけを残す(個人情報とお金の情報を外す) */
function viewFor(S, me){
  if (me.role === "admin") return S;
  return {
    settings:{}, ledger:[], payables:[], receivables:[], log:[],
    items:S.items.map(function(i){
      var c = JSON.parse(JSON.stringify(i)); c.cost = null; c.partsCost = null; return c;
    }),
  };
}

/* ============================================================
   Google Apps Script(本番版)のサーバー側
   データは、このスクリプトを作ったスプレッドシートに保存されます。
   スプレッドシートは管理者だけが開け、メンバーはアプリ経由でのみ操作します。
   ============================================================ */
var TZ = "Asia/Tokyo";
var TABLES = {
  ledger:   { sheet:"古物台帳", cols:["台帳番号","取引年月日","区別","品目","数量","特徴","代価","相手方住所","相手方氏名","職業","年齢","確認の区分","確認の方法","払出し年月日","払出し区別","払出し代価","払出し相手方","登録者","登録日時"] },
  fixes:    { sheet:"台帳の訂正履歴", cols:["台帳番号","日時","訂正者","項目","訂正前","訂正後","理由"] },
  items:    { sheet:"在庫", cols:["在庫ID","台帳番号","品目","機種","容量","色","ランク","原価","部品代","状態","販売先","出品価格","販売額","販売日","入金予定日","メモ"] },
  history:  { sheet:"在庫の更新履歴", cols:["在庫ID","日時","担当","変更前","変更後","メモ"] },
  payables: { sheet:"支払予定", cols:["ID","期日","支払先","内容","金額","済"] },
  receivables:{ sheet:"入金予定", cols:["ID","予定日","入金元","内容","金額","済"] },
  settings: { sheet:"設定", cols:["項目","値"] },
  log:      { sheet:"操作ログ", cols:["日時","担当","内容"] },
  members:  { sheet:"メンバー", cols:["ID","名前","役割","パスワード(暗号化)","ソルト","有効"] },
};

function doGet(){
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("TechMate 在庫・古物台帳")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/* ---------- 初回だけ実行:シートを作る ---------- */
function setup(){
  var ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(function(k){
    var t = TABLES[k], sh = ss.getSheetByName(t.sheet);
    if (!sh) sh = ss.insertSheet(t.sheet);
    sh.getRange(1, 1, 1, t.cols.length).setValues([t.cols]).setFontWeight("bold").setBackground("#e9e8e3");
    sh.getRange(1, 1, sh.getMaxRows(), t.cols.length).setNumberFormat("@"); // すべて文字として保存(日付の自動変換を防ぐ)
    sh.setFrozenRows(1);
  });
  var st = ss.getSheetByName(TABLES.settings.sheet);
  if (st.getLastRow() < 2) st.getRange(2, 1, 2, 2).setValues([["balance","0"],["safety","300000"]]);
  var first = ss.getSheetByName("シート1"); if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  return "セットアップが完了しました";
}

/* ---------- 読み書き ---------- */
function ctxNow(){ var d = new Date(); return { today:Utilities.formatDate(d, TZ, "yyyy-MM-dd"), stamp:Utilities.formatDate(d, TZ, "yyyy-MM-dd HH:mm") }; }
function readTable(key){
  var t = TABLES[key], sh = SpreadsheetApp.getActive().getSheetByName(t.sheet);
  if (!sh) throw new Error("シート「" + t.sheet + "」がありません。setup を実行してください");
  var n = sh.getLastRow() - 1; if (n < 1) return [];
  return sh.getRange(2, 1, n, t.cols.length).getDisplayValues();
}
function writeTable(key, rows){
  var t = TABLES[key], sh = SpreadsheetApp.getActive().getSheetByName(t.sheet);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, t.cols.length).clearContent();
  if (rows.length){
    var r = sh.getRange(2, 1, rows.length, t.cols.length);
    r.setNumberFormat("@"); r.setValues(rows.map(function(row){ return row.map(function(v){ return v === null || v === undefined ? "" : String(v); }); }));
  }
}
function n0(v){ return v === "" ? null : Number(v); }

function loadState(){
  var S = { settings:{ balance:0, safety:300000 }, ledger:[], items:[], payables:[], receivables:[], log:[] };
  readTable("settings").forEach(function(r){ if (r[0]) S.settings[r[0]] = Number(r[1]) || 0; });
  var fixes = {}; readTable("fixes").forEach(function(r){ (fixes[r[0]] = fixes[r[0]] || []).push({ at:r[1], by:r[2], field:r[3], before:r[4], after:r[5], reason:r[6] }); });
  S.ledger = readTable("ledger").filter(function(r){ return r[0]; }).map(function(r){
    return { no:r[0], date:r[1], kubun:r[2], hinmoku:r[3], qty:Number(r[4]) || 1, tokucho:r[5], price:Number(r[6]) || 0,
      partner:{ addr:r[7], name:r[8], job:r[9], age:Number(r[10]) || 0 }, check:{ kubun:r[11], method:r[12] },
      out:r[13] ? { date:r[13], kubun:r[14], price:n0(r[15]), partnerType:r[16] } : null,
      corrections:fixes[r[0]] || [], by:r[17], createdAt:r[18] };
  });
  var hist = {}; readTable("history").forEach(function(r){ (hist[r[0]] = hist[r[0]] || []).push({ at:r[1], by:r[2], from:r[3], to:r[4], note:r[5] }); });
  S.items = readTable("items").filter(function(r){ return r[0]; }).map(function(r){
    return { id:r[0], ledgerNo:r[1], type:r[2], model:r[3], storage:r[4], color:r[5], grade:r[6], cost:Number(r[7]) || 0, partsCost:Number(r[8]) || 0,
      status:r[9], channel:r[10], listPrice:n0(r[11]), soldPrice:n0(r[12]), soldDate:r[13], payDue:r[14], memo:r[15], history:hist[r[0]] || [] };
  });
  S.payables = readTable("payables").filter(function(r){ return r[0]; }).map(function(r){ return { id:r[0], due:r[1], to:r[2], desc:r[3], amount:Number(r[4]) || 0, done:r[5] === "済" }; });
  S.receivables = readTable("receivables").filter(function(r){ return r[0]; }).map(function(r){ return { id:r[0], due:r[1], from:r[2], desc:r[3], amount:Number(r[4]) || 0, done:r[5] === "済" }; });
  S.log = readTable("log").map(function(r){ return { at:r[0], by:r[1], text:r[2] }; }).reverse().slice(0, 300);
  return S;
}
function saveState(S, oldLogCount){
  writeTable("settings", Object.keys(S.settings).map(function(k){ return [k, S.settings[k]]; }));
  writeTable("ledger", S.ledger.map(function(l){ var o = l.out || {};
    return [l.no,l.date,l.kubun,l.hinmoku,l.qty,l.tokucho,l.price,l.partner.addr,l.partner.name,l.partner.job,l.partner.age,l.check.kubun,l.check.method,o.date,o.kubun,o.price,o.partnerType,l.by,l.createdAt]; }));
  var fx = []; S.ledger.forEach(function(l){ l.corrections.forEach(function(c){ fx.push([l.no,c.at,c.by,c.field,c.before,c.after,c.reason]); }); });
  writeTable("fixes", fx);
  writeTable("items", S.items.map(function(i){ return [i.id,i.ledgerNo,i.type,i.model,i.storage,i.color,i.grade,i.cost,i.partsCost,i.status,i.channel,i.listPrice,i.soldPrice,i.soldDate,i.payDue,i.memo]; }));
  var hs = []; S.items.forEach(function(i){ i.history.forEach(function(h){ hs.push([i.id,h.at,h.by,h.from,h.to,h.note]); }); });
  writeTable("history", hs);
  writeTable("payables", S.payables.map(function(p){ return [p.id,p.due,p.to,p.desc,p.amount,p.done ? "済" : ""]; }));
  writeTable("receivables", S.receivables.map(function(p){ return [p.id,p.due,p.from,p.desc,p.amount,p.done ? "済" : ""]; }));
  // 操作ログは追記のみ(消さない)
  var added = S.log.length - oldLogCount;
  if (added > 0){
    var sh = SpreadsheetApp.getActive().getSheetByName(TABLES.log.sheet);
    var rows = S.log.slice(0, added).reverse().map(function(l){ return [l.at, l.by, l.text]; });
    var r = sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3); r.setNumberFormat("@"); r.setValues(rows);
  }
}

/* ---------- ログイン ---------- */
function hashPw(salt, pw){
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ":" + pw, Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ("0" + (b & 255).toString(16)).slice(-2); }).join("");
}
function readMembers(){ return readTable("members").filter(function(r){ return r[0]; }).map(function(r){ return { id:r[0], name:r[1], role:r[2], hash:r[3], salt:r[4], active:r[5] !== "停止" }; }); }
function writeMembers(list){ writeTable("members", list.map(function(m){ return [m.id, m.name, m.role, m.hash, m.salt, m.active ? "有効" : "停止"]; })); }
function setupStatus(){ return { needsAdmin: readMembers().length === 0 }; }
function createAdmin(id, name, pw){
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (readMembers().length) throw new Error("管理者はすでに登録されています");
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(id)) throw new Error("IDは半角英数字3〜20文字にしてください");
    if (String(pw).length < 8) throw new Error("パスワードは8文字以上にしてください");
    var salt = Utilities.getUuid();
    writeMembers([{ id:id, name:name || id, role:"admin", hash:hashPw(salt, pw), salt:salt, active:true }]);
    return true;
  } finally { lock.releaseLock(); }
}
function login(id, pw){
  var m = readMembers().filter(function(x){ return x.id === id && x.active; })[0];
  if (!m || hashPw(m.salt, pw) !== m.hash){ Utilities.sleep(800); throw new Error("IDまたはパスワードが違います"); }
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put("tok_" + token, m.id, 21600); // 6時間で自動ログアウト
  return { token:token, me:{ id:m.id, name:m.name, role:m.role } };
}
function logout(token){ CacheService.getScriptCache().remove("tok_" + token); return true; }
function auth(token){
  var id = token && CacheService.getScriptCache().get("tok_" + token);
  var m = id && readMembers().filter(function(x){ return x.id === id && x.active; })[0];
  if (!m) throw new Error("ログインの有効期限が切れました。もう一度ログインしてください");
  return { id:m.id, name:m.name, role:m.role };
}

/* ---------- 画面から呼ばれる窓口 ---------- */
function getAll(token){ var me = auth(token); return JSON.stringify(viewFor(loadState(), me)); }
function act(token, name, payload){
  var me = auth(token);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var S = loadState(), before = S.log.length, ctx = ctxNow();
    var err = applyAction(S, me, name, payload, ctx);
    if (err) throw new Error(err);
    saveState(S, before);
    return JSON.stringify(viewFor(S, me));
  } finally { lock.releaseLock(); }
}
function members(token, name, p){
  var me = auth(token);
  if (me.role !== "admin") throw new Error("メンバー管理は管理者のみ実行できます");
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var list = readMembers();
    p = p || {};
    if (name === "add"){
      if (!/^[a-zA-Z0-9_-]{3,20}$/.test(p.id || "")) throw new Error("IDは半角英数字3〜20文字にしてください");
      if (list.some(function(m){ return m.id === p.id; })) throw new Error("そのIDはすでに使われています");
      if (String(p.pw || "").length < 8) throw new Error("パスワードは8文字以上にしてください");
      var salt = Utilities.getUuid();
      list.push({ id:p.id, name:p.name || p.id, role:p.role === "admin" ? "admin" : "member", hash:hashPw(salt, p.pw), salt:salt, active:true });
    } else if (name === "password"){
      var m = list.filter(function(x){ return x.id === p.id; })[0]; if (!m) throw new Error("メンバーが見つかりません");
      if (String(p.pw || "").length < 8) throw new Error("パスワードは8文字以上にしてください");
      m.salt = Utilities.getUuid(); m.hash = hashPw(m.salt, p.pw);
    } else if (name === "toggle"){
      var t = list.filter(function(x){ return x.id === p.id; })[0]; if (!t) throw new Error("メンバーが見つかりません");
      if (t.id === me.id) throw new Error("自分自身は停止できません");
      t.active = !t.active;
    }
    if (name !== "list") writeMembers(list);
    return list.map(function(m){ return { id:m.id, name:m.name, role:m.role, active:m.active }; });
  } finally { lock.releaseLock(); }
}
