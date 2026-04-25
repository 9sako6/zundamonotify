# zundamonotify

Codex と Claude Code の完了を、ずんだもんの音声で知らせる Mac 用ツールなのだ。

## できることなのだ

- Codex と Claude Code のローカルログをポーリングするのだ
- 作業完了を検知したら、ずんだもんの音声で知らせるのだ
- ログイン時に自動起動できるのだ

## 音声を試すのだ

### 作業完了

> みてほしいのだ

https://github.com/user-attachments/assets/918b77ff-e4e5-4b63-999b-c6e6accf6c57

### 許可リクエスト

> たすけてほしいのだ

https://github.com/user-attachments/assets/698df345-be29-4992-9177-3dfc64c3e142



## 対応環境なのだ

- macOS
- Claude Code
- Codex

## インストールするのだ

```bash
mise use -g github:9sako6/zundamonotify
```

## 使い方なのだ

自動起動を登録するのだ。

```bash
zundamonotify install
```

これでログイン時に自動起動するのだ。

状態を見るのだ。

```bash
zundamonotify status
```

自動起動を解除するのだ。

```bash
zundamonotify uninstall
```

## 更新なのだ

新しいバージョンを入れた後は、自動起動も今のバイナリに向け直すのだ。

```bash
mise install github:9sako6/zundamonotify@vX.Y.Z
zundamonotify install
zundamonotify status
```

`install` は自動起動の登録と更新を兼ねるのだ。

## ライセンスなのだ

### VOICEVOX

`assets/` 以下の音声ファイルは [VOICEVOX](https://voicevox.hiroshiba.jp/) の利用規約に従うのだ。

- VOICEVOX ソフトウェア利用規約: <https://voicevox.hiroshiba.jp/term/>
- キャラクター利用ガイドライン: <https://zunko.jp/guideline.html>

### ソースコード

MIT License なのだ。`assets/` 以下の音声ファイルには適用されないのだ。
詳しくは [LICENSE](./LICENSE) を見るのだ。
