// シートの行数上限(新しいシートは1,000行)を超えても書き込めるかのテスト。実行: node test/rows_test.js
// Google のスプレッドシートを、範囲外に書くとエラーになる模擬シートで置き換えて試す
const fs = require("fs"), path = require("path");
function makeSheet(){
  const sh = { data:[], max:1000,
    getLastRow(){ return this.data.length; }, getMaxRows(){ return this.max; },
    insertRowsAfter(after, n){ this.max += n; },
    getRange(r, c, nr, nc){ const s = this;
      if (r + (nr || 1) - 1 > s.max) throw new Error("範囲の座標がシートのサイズ外です");
      return { setNumberFormat(){ return this; },
        setValues(v){ v.forEach((row, i) => { s.data[r - 1 + i] = row; }); },
        clearContent(){ for (let i = 0; i < nr; i++) s.data[r - 1 + i] = Array(nc).fill(""); while (s.data.length && s.data[s.data.length - 1].every(x => x === "")) s.data.pop(); } };
    } };
  sh.data.push(["見出し"]); return sh;
}
const sheets = {};
global.SpreadsheetApp = { getActive: () => ({ getSheetByName: n => (sheets[n] = sheets[n] || makeSheet()) }) };
eval(fs.readFileSync(path.join(__dirname, "..", "google-apps-script", "Code.gs"), "utf8"));
let ok = 0, ng = 0; const chk = (l, c) => { console.log((c ? "OK " : "NG ") + l); c ? ok++ : ng++; };
const row = Array(TABLES.history.cols.length).fill("x");
// 1,500行を書く(以前は1,000行目を超えたところでエラーになっていた)
writeTable_("history", Array(1500).fill(row));
const h = sheets[TABLES.history.sheet];
chk("1,500行を書き込める", h.getLastRow() === 1501);
chk("行は余裕をもって増える", h.getMaxRows() >= 1501 + 500);
const before = h.getMaxRows(); writeTable_("history", Array(1600).fill(row));
chk("余裕の範囲内なら行を増やさない", h.getMaxRows() === before && h.getLastRow() === 1601);
writeTable_("history", Array(10).fill(row));
chk("行が減ったら余りを消す", h.getLastRow() === 11);
// 操作ログの追記(1,000行目をまたぐ)
const lg = sheets[TABLES.log.sheet] = makeSheet(); for (let i = 1; i < 999; i++) lg.data.push(["a","b","c"]);
saveState_({ settings:{}, ledger:[], items:[], payables:[], receivables:[], log:[],
  newLog:[1,2,3,4,5].map(i => ({ at:"t", by:"me", text:"ログ" + i })) });
chk("操作ログが1,000行目をまたいでも追記できる", lg.getLastRow() === 1004 && lg.data[1003][2] === "ログ5");
process.exitCode = ng ? 1 : 0; console.log(`\n${ok}件OK / ${ng}件NG`);
