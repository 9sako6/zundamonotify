# zundamonotify

AIエージェントがお仕事おわったらずんだもんが叫んでくれるやつなのだ！もうターミナルをガン見しなくていいのだ！Mac 専用なのだ！ごめんなのだ！

## 対応環境なのだ

- macOS
- Claude Code

## 使い方なのだ

```bash
mise install      # Node.js と pnpm を召喚するのだ
pnpm start        # ずんだもんが待機するのだ
pnpm hook         # Claude Code の hooks 設定を ~/.claude/settings.json に書き込むのだ
```

設定を書き込まずに中身だけ見たいときは `pnpm hook:show` なのだ。

黙らせたいときは `pnpm stop` なのだ。でもずんだもんは悲しいのだ。

## ライセンスなのだ

### VOICEVOX

`assets/` 以下の音声ファイルは [VOICEVOX](https://voicevox.hiroshiba.jp/) の利用規約に従うのだ。

- VOICEVOX ソフトウェア利用規約: <https://voicevox.hiroshiba.jp/term/>
- キャラクター利用ガイドライン: <https://zunko.jp/guideline.html>

### ソースコード

MIT License なのだ。`assets/` 以下の音声ファイルには適用されないのだ。
詳しくは [LICENSE](./LICENSE) を見るのだ。
