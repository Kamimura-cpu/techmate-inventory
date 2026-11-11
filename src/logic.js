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
