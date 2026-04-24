僕の名前はずんだもん

## 開発メモ

```bash
mise install
pnpm install
mise run build
mise run serve
mise run test
```

リリースは `v*` tag push で GitHub Release に `dist/zundamonotify-macos-arm64` を添付する。
利用者は `mise use -g github:9sako6/zundamonotify` で入れる想定。
