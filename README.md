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
pnpm hook         # Claude Code / Codex を見つけて、どれに設定するか聞いてくるのだ
```

`pnpm hook` は `claude` と `codex` コマンドを探して、入ってるやつだけ候補に出すのだ。
両方入ってたら「Claude Code だけ」「Codex だけ」「両方」を選べるのだ。

設定を書き込まずに中身だけ見たいときは `pnpm hook:show` なのだ。Claude Code 用の `settings.json` と Codex 用の `config.toml` の例をまとめて見せるのだ。

黙らせたいときは `pnpm stop` なのだ。でもずんだもんは悲しいのだ。

## ライセンスなのだ

### VOICEVOX

`assets/` 以下の音声ファイルは [VOICEVOX](https://voicevox.hiroshiba.jp/) の利用規約に従うのだ。

- VOICEVOX ソフトウェア利用規約: <https://voicevox.hiroshiba.jp/term/>
- キャラクター利用ガイドライン: <https://zunko.jp/guideline.html>

### ソースコード

MIT License なのだ。`assets/` 以下の音声ファイルには適用されないのだ。
詳しくは [LICENSE](./LICENSE) を見るのだ。
