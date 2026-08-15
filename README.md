# zundamonotify

Codex、Claude Code、opencode、Hermes の完了や入力待ちを、ずんだもんの音声で知らせる Mac 用ツールなのだ。

## できることなのだ

- Codex、Claude Code、opencode、Hermes のローカルログをポーリングするのだ
- 作業完了を検知したら、ずんだもんの音声で知らせるのだ
- ユーザーの入力待ちを検知したら、別の音声で知らせるのだ
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
- Hermes

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

Codex の許可、選択、確認はローカルログから自動で検知するのだ。

Hermes の選択式質問もローカルデータベースから自動で検知するのだ。

Claude Code の選択式質問もローカルログから自動で検知するのだ。許可や MCP の入力待ちはローカルログで通常のツール実行と区別できないため、今は通知しないのだ。

一度だけ実行する場合は `nix run` を使えるのだ。

```bash
nix run github:9sako6/zundamonotify -- help
```

## 開発するのだ

Rustのツールチェーンを用意して、テストとビルドを実行するのだ。

```bash
mise install
mise run test
mise run build
nix flake check
```

## ライセンスなのだ

### VOICEVOX

`assets/` 以下の音声ファイルは [VOICEVOX](https://voicevox.hiroshiba.jp/) の利用規約に従うのだ。

- VOICEVOX ソフトウェア利用規約: <https://voicevox.hiroshiba.jp/term/>
- キャラクター利用ガイドライン: <https://zunko.jp/guideline.html>

### ソースコード

MIT License なのだ。`assets/` 以下の音声ファイルには適用されないのだ。
詳しくは [LICENSE](./LICENSE) を見るのだ。
