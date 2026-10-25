# 共通部分(src/)から、配布用ファイルを組み立てる
from pathlib import Path
root = Path(__file__).parent
logic = (root/"src/logic.js").read_text(encoding="utf-8")
app = (root/"src/app.html").read_text(encoding="utf-8").replace("/*__LOGIC__*/", logic)
server = (root/"src/server.js").read_text(encoding="utf-8")
(root/"index.html").write_text(app, encoding="utf-8")                      # お試し版(ダブルクリックで開く)
out = root/"google-apps-script"; out.mkdir(exist_ok=True)
(out/"index.html").write_text(app, encoding="utf-8")                      # 本番版の画面
(out/"Code.gs").write_text(logic + "\n" + server, encoding="utf-8")       # 本番版のプログラム
print("built")
