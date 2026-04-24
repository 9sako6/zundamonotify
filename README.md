# zundamonotify

AIエージェントがお仕事おわったらずんだもんが叫んでくれるやつなのだ！もうターミナルをガン見しなくていいのだ！Mac 専用なのだ！ごめんなのだ！

## 対応環境なのだ

- macOS
- Claude Code
- Codex

## 使い方なのだ

```bash
mise install      # Node.js と pnpm を召喚するのだ
pnpm start        # ずんだもんが待機するのだ
pnpm hook         # Claude Code の設定を書くのだ
```

Codex は `pnpm start` 中に sessions を見て、完了を検知したら鳴らすのだ。

設定を書き込まずに中身だけ見たいときは `pnpm hook:show` なのだ。Claude Code 用の `settings.json` の例を見せるのだ。

黙らせたいときは `pnpm stop` なのだ。でもずんだもんは悲しいのだ。

## ライセンスなのだ

### VOICEVOX

`assets/` 以下の音声ファイルは [VOICEVOX](https://voicevox.hiroshiba.jp/) の利用規約に従うのだ。

- VOICEVOX ソフトウェア利用規約: <https://voicevox.hiroshiba.jp/term/>
- キャラクター利用ガイドライン: <https://zunko.jp/guideline.html>

### ソースコード

MIT License なのだ。`assets/` 以下の音声ファイルには適用されないのだ。
詳しくは [LICENSE](./LICENSE) を見るのだ。
