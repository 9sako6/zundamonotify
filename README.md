# zundamonotify

AIエージェントがお仕事おわったらずんだもんが叫んでくれるやつなのだ！もうターミナルをガン見しなくていいのだ！Mac 専用なのだ！ごめんなのだ！

## 対応環境なのだ

- macOS
- Claude Code
- Codex

## 使い方なのだ

```bash
zundamonotify install
```

これでログイン時に自動起動するのだ。Codex と Claude Code のローカルログをポーリングして、完了を検知したら鳴らすのだ。

状態を見るときはこれなのだ。

```bash
zundamonotify status
```

黙らせたいときはこれなのだ。でもずんだもんは悲しいのだ。

```bash
zundamonotify uninstall
```

## ライセンスなのだ

### VOICEVOX

`assets/` 以下の音声ファイルは [VOICEVOX](https://voicevox.hiroshiba.jp/) の利用規約に従うのだ。

- VOICEVOX ソフトウェア利用規約: <https://voicevox.hiroshiba.jp/term/>
- キャラクター利用ガイドライン: <https://zunko.jp/guideline.html>

### ソースコード

MIT License なのだ。`assets/` 以下の音声ファイルには適用されないのだ。
詳しくは [LICENSE](./LICENSE) を見るのだ。
