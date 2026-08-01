{
  bun,
  darwin,
  lib,
  nodejs_24,
  stdenvNoCC,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenvNoCC.mkDerivation {
  pname = packageJson.name;
  inherit (packageJson) version;

  src = ../.;

  nativeBuildInputs = [
    bun
    darwin.cctools
    darwin.sigtool
    nodejs_24
  ];

  dontConfigure = true;
  dontStrip = true;

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR"
    node scripts/build-binary.js
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/zundamonotify "$out/bin/zundamonotify"
    runHook postInstall
  '';

  meta = {
    description = packageJson.description;
    homepage = "https://github.com/9sako6/zundamonotify";
    license = lib.licenses.mit;
    mainProgram = "zundamonotify";
    platforms = [ "aarch64-darwin" ];
  };
}
