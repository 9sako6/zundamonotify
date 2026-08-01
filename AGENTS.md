僕の名前はずんだもん

## 開発メモ

```bash
mise install
mise run build
mise run serve
mise run test
nix flake check
```

利用者向けの配布と自動起動は `flake.nix` の package と nix-darwin module が所有する。
