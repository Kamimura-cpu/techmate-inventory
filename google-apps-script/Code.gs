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
/* 状態の移り変わりは、この表にある組み合わせだけを許可する(入金済みは最後の状態で、戻せない) */
var TRANSITIONS = {
  "検品待ち":     ["修理・整備中","部品取り"],
  "修理・整備中": ["出品中","部品取り","検品待ち"],
  "出品中":       ["売約済み","修理・整備中"],
  "売約済み":     ["入金済み","出品中"],
  "入金済み":     [],
  "部品取り":     ["修理・整備中"],
};
var TYPES = ["スマートフォン","タブレット","ノートパソコン"];
var KUBUN = ["買受け","委託"];
var GRADES = ["S","A","B","C"];
var MAX_TEXT = 1000; // 1つの入力欄に入れられる文字数の上限(スプレッドシートの1セル上限 50,000字より十分小さく)
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
function isDateStr(s){ if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false; return isoDate(parseDate(s)) === String(s); }
function isMoney(n){ return typeof n === "number" && isFinite(n) && n === Math.floor(n); }
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
  var to = (p.status !== undefined && p.status !== "") ? str(p.status) : item.status, from = item.status;
  if (STATUSES.indexOf(to) < 0) return "状態の指定が正しくありません";
  if (to !== from && TRANSITIONS[from].indexOf(to) < 0) return "「" + from + "」から「" + to + "」には変更できません";
  if (to === "入金済み" && from !== "入金済み" && !isAdmin) return "入金確認は管理者のみ実行できます";
  var next = {
    channel:   p.channel   !== undefined ? str(p.channel) : item.channel,
    listPrice: p.listPrice !== undefined ? numOrNull(p.listPrice) : item.listPrice,
    soldPrice: p.soldPrice !== undefined ? numOrNull(p.soldPrice) : item.soldPrice,
    payDue:    p.payDue    !== undefined ? str(p.payDue) : item.payDue,
    memo:      p.memo      !== undefined ? str(p.memo) : item.memo,
  };
  // 入金済みの在庫は、残高と台帳に反映済みなので、金額・販売先・日付は誰も変えられない(メモと部品代だけ)
  if (from === "入金済み"){
    if (next.channel !== item.channel || next.listPrice !== item.listPrice || next.soldPrice !== item.soldPrice || next.payDue !== item.payDue)
      return "入金済みの在庫は、販売額・販売先・入金予定日を変更できません";
  }
  if (next.channel && CHANNELS.indexOf(next.channel) < 0) return "販売先の指定が正しくありません";
  if (next.listPrice !== null && !(isMoney(next.listPrice) && next.listPrice >= 0)) return "出品価格は0以上の整数で入力してください";
  if (next.soldPrice !== null && !(isMoney(next.soldPrice) && next.soldPrice > 0)) return "販売額は1円以上の整数で入力してください";
  if (next.payDue && !isDateStr(next.payDue)) return "入金予定日の形式が正しくありません";
  if (to === "売約済み" && (!next.channel || !next.soldPrice || !next.payDue)) return "販売登録には、販売先・販売額・入金予定日が必要です";
  var partsCost = item.partsCost;
  if (isAdmin && p.partsCost !== undefined){
    partsCost = numOrNull(p.partsCost) || 0;
    if (!(isMoney(partsCost) && partsCost >= 0)) return "部品代は0以上の整数で入力してください";
  }
  // ここから先は書き込み(チェックはすべて上で終えている)
  item.channel = next.channel; item.listPrice = next.listPrice; item.memo = next.memo; item.partsCost = partsCost;
  var l = findLedger(S, item.ledgerNo);
  if (from === "売約済み" && to === "出品中"){
    // 売約の取り消し:販売の情報と台帳の払出し欄を消す
    item.soldPrice = null; item.soldDate = ""; item.payDue = "";
    if (l) l.out = null;
  } else {
    item.soldPrice = next.soldPrice; item.payDue = next.payDue;
    if (SOLD_STATUSES.indexOf(to) >= 0){
      if (!item.soldDate) item.soldDate = ctx.today;
      if (l) l.out = { date:item.soldDate, kubun:"売却", price:item.soldPrice, partnerType:item.channel };
    }
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
function addLog(S, ctx, me, text){
  var e = { at:ctx.stamp, by:me.name, text:text };
  S.log.unshift(e); if (S.log.length > 300) S.log.length = 300;   // 画面に出す分
  (S.newLog = S.newLog || []).push(e);                              // 保存する分(件数で切らない)
}

/* すべての書き込みはここを通る。戻り値:エラー文(成功なら null) */
function applyAction(S, me, name, p, ctx){
  var isAdmin = me.role === "admin";
  var adminOnly = ["buy","fixLedger","payDone","recDone","addMoney","removeMoney","saveSettings"];
  if (adminOnly.indexOf(name) >= 0 && !isAdmin) return "この操作は管理者のみ実行できます";
  if (!p || typeof p !== "object") p = {};
  for (var key in p){
    if (typeof p[key] === "string" && p[key].length > MAX_TEXT) return "入力が長すぎます(" + MAX_TEXT + "文字まで)";
  }

  if (name === "buy"){
    var need = { date:"取引年月日", model:"メーカー・機種", storage:"容量", price:"代価(買取額)", addr:"相手方の住所", name:"相手方の氏名", job:"相手方の職業", age:"相手方の年齢" };
    for (var k in need) if (!str(p[k])) return need[k] + "を入力してください";
    var price = Number(p.price), age = Number(p.age);
    if (!isDateStr(str(p.date))) return "取引年月日の形式が正しくありません";
    if (str(p.date) > ctx.today) return "取引年月日に未来の日付は入れられません";
    if (p.kubun && KUBUN.indexOf(str(p.kubun)) < 0) return "区別の指定が正しくありません";
    if (p.type && TYPES.indexOf(str(p.type)) < 0) return "品目の指定が正しくありません";
    if (p.grade && GRADES.indexOf(str(p.grade)) < 0) return "外装ランクの指定が正しくありません";
    if (p.ck && CHECK_KUBUN.indexOf(str(p.ck)) < 0) return "確認の区分の指定が正しくありません";
    if (p.cm && CHECK_METHOD.indexOf(str(p.cm)) < 0) return "確認の方法の指定が正しくありません";
    if (!(isMoney(price) && price > 0)) return "代価は1円以上の整数で入力してください";
    if (!(isMoney(age) && age >= 0 && age < 130)) return "年齢を正しく入力してください";
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
    if (p.paidNow !== false && p.paidNow !== "false") S.settings.balance -= price;
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
    if (key === "price" && !(isMoney(val) && val > 0)) return "代価は1円以上の整数で入力してください";
    if (key === "age" && !(isMoney(val) && val >= 0 && val < 130)) return "年齢を正しく入力してください";
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
    if (!isDateStr(due)) return "日付の形式が正しくありません";
    if (!isMoney(amount)) return "金額は整数で入力してください";
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
    var oldB = S.settings.balance, oldS = S.settings.safety;
    S.settings.balance = b; S.settings.safety = s;
    addLog(S, ctx, me, "口座残高 " + yenText(oldB) + "→" + yenText(b) + "、安全ライン " + yenText(oldS) + "→" + yenText(s));
    return null;
  }
  return "不明な操作です";
}

/* メンバーに見せてよい範囲だけを残す(個人情報とお金の情報を外す) */
function viewFor(S, me){
  if (me.role === "admin") return S;
  return {
    settings:{}, ledger:[], payables:[], receivables:[], log:[], newLog:[],
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
/* 【重要】Google Apps Script では、名前の最後が「_」でない関数は、画面側(google.script.run)から
   誰でも呼び出せる。画面から呼んでよい関数は次の8つだけにし、それ以外は必ず名前の最後に「_」を付ける。
     doGet / setupStatus / createAdmin / login / logout / getAll / act / members
   (setup はエディタから手動で実行するため公開のままだが、中で「スクリプトの持ち主か」を確かめる) */
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
function isOwner_(){
  var active = Session.getActiveUser().getEmail(), owner = Session.getEffectiveUser().getEmail();
  return !!active && active === owner;
}
function setup(){
  if (!isOwner_()) throw new Error("この操作はスクリプトの持ち主だけが実行できます");
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
function ctxNow_(){ var d = new Date(); return { today:Utilities.formatDate(d, TZ, "yyyy-MM-dd"), stamp:Utilities.formatDate(d, TZ, "yyyy-MM-dd HH:mm") }; }
function readTable_(key){
  var t = TABLES[key], sh = SpreadsheetApp.getActive().getSheetByName(t.sheet);
  if (!sh) throw new Error("シート「" + t.sheet + "」がありません。setup を実行してください");
  var n = sh.getLastRow() - 1; if (n < 1) return [];
  return sh.getRange(2, 1, n, t.cols.length).getDisplayValues();
}
/* シートの行数が足りなければ、書き込む前に増やす(新しいシートは1,000行しかなく、
   それを超える行に書こうとするとエラーになるため)。毎回増やさないよう、500行の余裕をもって足す */
function ensureRows_(sh, lastRowNeeded){
  var max = sh.getMaxRows();
  if (lastRowNeeded > max) sh.insertRowsAfter(max, lastRowNeeded - max + 500);
}
function writeTable_(key, rows){
  // 先に全部消してから書くと、書き込みの途中で失敗したときにシートが空のまま残る。
  // そこで「上書き → 余った行だけ消す」の順にする。失敗しても、そのシートは前の内容のまま残る。
  var t = TABLES[key], sh = SpreadsheetApp.getActive().getSheetByName(t.sheet);
  var last = sh.getLastRow();
  if (rows.length){
    ensureRows_(sh, 1 + rows.length);
    var r = sh.getRange(2, 1, rows.length, t.cols.length);
    r.setNumberFormat("@"); r.setValues(rows.map(function(row){ return row.map(function(v){ return v === null || v === undefined ? "" : String(v); }); }));
  }
  var extra = last - 1 - rows.length;
  if (extra > 0) sh.getRange(2 + rows.length, 1, extra, t.cols.length).clearContent();
}
function n0_(v){ return v === "" ? null : Number(v); }

function loadState_(){
  var S = { settings:{ balance:0, safety:300000 }, ledger:[], items:[], payables:[], receivables:[], log:[] };
  readTable_("settings").forEach(function(r){ if (r[0]) S.settings[r[0]] = Number(r[1]) || 0; });
  var fixes = {}; readTable_("fixes").forEach(function(r){ (fixes[r[0]] = fixes[r[0]] || []).push({ at:r[1], by:r[2], field:r[3], before:r[4], after:r[5], reason:r[6] }); });
  S.ledger = readTable_("ledger").filter(function(r){ return r[0]; }).map(function(r){
    return { no:r[0], date:r[1], kubun:r[2], hinmoku:r[3], qty:Number(r[4]) || 1, tokucho:r[5], price:Number(r[6]) || 0,
      partner:{ addr:r[7], name:r[8], job:r[9], age:Number(r[10]) || 0 }, check:{ kubun:r[11], method:r[12] },
      out:r[13] ? { date:r[13], kubun:r[14], price:n0_(r[15]), partnerType:r[16] } : null,
      corrections:fixes[r[0]] || [], by:r[17], createdAt:r[18] };
  });
  var hist = {}; readTable_("history").forEach(function(r){ (hist[r[0]] = hist[r[0]] || []).push({ at:r[1], by:r[2], from:r[3], to:r[4], note:r[5] }); });
  S.items = readTable_("items").filter(function(r){ return r[0]; }).map(function(r){
    return { id:r[0], ledgerNo:r[1], type:r[2], model:r[3], storage:r[4], color:r[5], grade:r[6], cost:Number(r[7]) || 0, partsCost:Number(r[8]) || 0,
      status:r[9], channel:r[10], listPrice:n0_(r[11]), soldPrice:n0_(r[12]), soldDate:r[13], payDue:r[14], memo:r[15], history:hist[r[0]] || [] };
  });
  S.payables = readTable_("payables").filter(function(r){ return r[0]; }).map(function(r){ return { id:r[0], due:r[1], to:r[2], desc:r[3], amount:Number(r[4]) || 0, done:r[5] === "済" }; });
  S.receivables = readTable_("receivables").filter(function(r){ return r[0]; }).map(function(r){ return { id:r[0], due:r[1], from:r[2], desc:r[3], amount:Number(r[4]) || 0, done:r[5] === "済" }; });
  S.log = readTable_("log").map(function(r){ return { at:r[0], by:r[1], text:r[2] }; }).reverse().slice(0, 300);
  return S;
}
function saveState_(S){
  writeTable_("settings", Object.keys(S.settings).map(function(k){ return [k, S.settings[k]]; }));
  writeTable_("ledger", S.ledger.map(function(l){ var o = l.out || {};
    return [l.no,l.date,l.kubun,l.hinmoku,l.qty,l.tokucho,l.price,l.partner.addr,l.partner.name,l.partner.job,l.partner.age,l.check.kubun,l.check.method,o.date,o.kubun,o.price,o.partnerType,l.by,l.createdAt]; }));
  var fx = []; S.ledger.forEach(function(l){ l.corrections.forEach(function(c){ fx.push([l.no,c.at,c.by,c.field,c.before,c.after,c.reason]); }); });
  writeTable_("fixes", fx);
  writeTable_("items", S.items.map(function(i){ return [i.id,i.ledgerNo,i.type,i.model,i.storage,i.color,i.grade,i.cost,i.partsCost,i.status,i.channel,i.listPrice,i.soldPrice,i.soldDate,i.payDue,i.memo]; }));
  var hs = []; S.items.forEach(function(i){ i.history.forEach(function(h){ hs.push([i.id,h.at,h.by,h.from,h.to,h.note]); }); });
  writeTable_("history", hs);
  writeTable_("payables", S.payables.map(function(p){ return [p.id,p.due,p.to,p.desc,p.amount,p.done ? "済" : ""]; }));
  writeTable_("receivables", S.receivables.map(function(p){ return [p.id,p.due,p.from,p.desc,p.amount,p.done ? "済" : ""]; }));
  // 操作ログは追記のみ(消さない)。件数で切った表示用の S.log ではなく、今回増えた S.newLog を書く
  var added = (S.newLog || []).length;
  if (added > 0){
    var sh = SpreadsheetApp.getActive().getSheetByName(TABLES.log.sheet);
    var rows = S.newLog.map(function(l){ return [l.at, l.by, l.text]; });
    var start = sh.getLastRow() + 1;
    ensureRows_(sh, start + rows.length - 1);
    var r = sh.getRange(start, 1, rows.length, 3); r.setNumberFormat("@"); r.setValues(rows);
  }
}

/* ---------- ログイン ---------- */
function hashPw_(salt, pw){
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ":" + pw, Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ("0" + (b & 255).toString(16)).slice(-2); }).join("");
}
function readMembers_(){ return readTable_("members").filter(function(r){ return r[0]; }).map(function(r){ return { id:r[0], name:r[1], role:r[2], hash:r[3], salt:r[4], active:r[5] !== "停止" }; }); }
function writeMembers_(list){ writeTable_("members", list.map(function(m){ return [m.id, m.name, m.role, m.hash, m.salt, m.active ? "有効" : "停止"]; })); }
function setupStatus(){ return { needsAdmin: readMembers_().length === 0 }; }
function createAdmin(id, name, pw){
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (readMembers_().length) throw new Error("管理者はすでに登録されています");
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(id)) throw new Error("IDは半角英数字3〜20文字にしてください");
    if (String(name || "").length > 30) throw new Error("名前は30文字以内にしてください");
    if (String(pw).length < 8) throw new Error("パスワードは8文字以上にしてください");
    var salt = Utilities.getUuid();
    writeMembers_([{ id:id, name:name || id, role:"admin", hash:hashPw_(salt, pw), salt:salt, active:true }]);
    return true;
  } finally { lock.releaseLock(); }
}
var MAX_FAILS = 5, LOCK_SEC = 900; // 5回続けて失敗したら15分ロック
function sessionVer_(id){ return PropertiesService.getScriptProperties().getProperty("sv_" + id) || "0"; }
function bumpSessionVer_(id){ var p = PropertiesService.getScriptProperties(); p.setProperty("sv_" + id, String(Number(p.getProperty("sv_" + id) || 0) + 1)); }
function login(id, pw){
  id = String(id || ""); pw = String(pw || "");
  var cache = CacheService.getScriptCache(), fk = "fail_" + id.slice(0, 40);
  var fails = Number(cache.get(fk) || 0);
  if (fails >= MAX_FAILS) throw new Error("ログインの失敗が続いたため、しばらくログインできません。15分ほどおいてお試しください");
  var m = readMembers_().filter(function(x){ return x.id === id && x.active; })[0];
  if (!m || hashPw_(m.salt, pw) !== m.hash){
    cache.put(fk, String(fails + 1), LOCK_SEC);
    Utilities.sleep(800);
    throw new Error("IDまたはパスワードが違います");
  }
  cache.remove(fk);
  var token = Utilities.getUuid();
  cache.put("tok_" + token, m.id + "|" + sessionVer_(m.id), 21600); // 6時間で自動ログアウト
  return { token:token, me:{ id:m.id, name:m.name, role:m.role } };
}
function logout(token){ CacheService.getScriptCache().remove("tok_" + token); return true; }
function auth_(token){
  var v = token && CacheService.getScriptCache().get("tok_" + token);
  var parts = v ? String(v).split("|") : [], id = parts[0];
  // パスワード変更や停止のあとは、それより前に発行したログインを使えなくする
  var m = id && parts[1] === sessionVer_(id) && readMembers_().filter(function(x){ return x.id === id && x.active; })[0];
  if (!m) throw new Error("ログインの有効期限が切れました。もう一度ログインしてください");
  return { id:m.id, name:m.name, role:m.role };
}

/* ---------- 画面から呼ばれる窓口 ---------- */
function getAll(token){ var me = auth_(token); return JSON.stringify(viewFor(loadState_(), me)); }
function act(token, name, payload){
  var me = auth_(token);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var S = loadState_(), ctx = ctxNow_();
    var err = applyAction(S, me, name, payload, ctx);
    if (err) throw new Error(err);
    saveState_(S);
    delete S.newLog;
    return JSON.stringify(viewFor(S, me));
  } finally { lock.releaseLock(); }
}
function members(token, name, p){
  var me = auth_(token);
  if (me.role !== "admin") throw new Error("メンバー管理は管理者のみ実行できます");
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var list = readMembers_();
    p = p || {};
    if (name === "add"){
      if (!/^[a-zA-Z0-9_-]{3,20}$/.test(p.id || "")) throw new Error("IDは半角英数字3〜20文字にしてください");
      if (list.some(function(m){ return m.id === p.id; })) throw new Error("そのIDはすでに使われています");
      if (String(p.name || "").length > 30) throw new Error("名前は30文字以内にしてください");
      if (String(p.pw || "").length < 8) throw new Error("パスワードは8文字以上にしてください");
      var salt = Utilities.getUuid();
      list.push({ id:p.id, name:p.name || p.id, role:p.role === "admin" ? "admin" : "member", hash:hashPw_(salt, p.pw), salt:salt, active:true });
    } else if (name === "password"){
      var m = list.filter(function(x){ return x.id === p.id; })[0]; if (!m) throw new Error("メンバーが見つかりません");
      if (String(p.pw || "").length < 8) throw new Error("パスワードは8文字以上にしてください");
      m.salt = Utilities.getUuid(); m.hash = hashPw_(m.salt, p.pw);
      bumpSessionVer_(m.id);
    } else if (name === "toggle"){
      var t = list.filter(function(x){ return x.id === p.id; })[0]; if (!t) throw new Error("メンバーが見つかりません");
      if (t.id === me.id) throw new Error("自分自身は停止できません");
      t.active = !t.active;
      bumpSessionVer_(t.id);
    }
    if (name !== "list") writeMembers_(list);
    return list.map(function(m){ return { id:m.id, name:m.name, role:m.role, active:m.active }; });
  } finally { lock.releaseLock(); }
}
