# zundamonotify

Codex、Claude Code、opencode の完了を、ずんだもんの音声で知らせる Mac 用ツールなのだ。

## できることなのだ

- Codex、Claude Code、opencode のローカルログをポーリングするのだ
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

- macOS（Apple Silicon）
- Claude Code
- Codex
- opencode

## nix-darwin でインストールするのだ

既存の flake に input を追加するのだ。

```nix
inputs.zundamonotify = {
  url = "github:9sako6/zundamonotify";
};
```

`darwinSystem` の `modules` に module と設定を追加するのだ。

```nix
modules = [
  zundamonotify.darwinModules.default
  {
    services.zundamonotify.enable = true;
  }
];
```

module がコマンドのインストールと自動起動をまとめて管理するのだ。

## 使い方なのだ

状態を見るのだ。

```bash
zundamonotify status
```

一度だけ実行する場合は `nix run` を使えるのだ。

```bash
nix run github:9sako6/zundamonotify -- --help
```

## ライセンスなのだ

### VOICEVOX

`assets/` 以下の音声ファイルは [VOICEVOX](https://voicevox.hiroshiba.jp/) の利用規約に従うのだ。

- VOICEVOX ソフトウェア利用規約: <https://voicevox.hiroshiba.jp/term/>
- キャラクター利用ガイドライン: <https://zunko.jp/guideline.html>

### ソースコード

MIT License なのだ。`assets/` 以下の音声ファイルには適用されないのだ。
詳しくは [LICENSE](./LICENSE) を見るのだ。
