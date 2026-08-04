{ lib, rustPlatform }:

let
  manifest = builtins.fromTOML (builtins.readFile ../Cargo.toml);
in
rustPlatform.buildRustPackage {
  inherit (manifest.package) version;
  pname = manifest.package.name;

  src = ../.;

  cargoLock.lockFile = ../Cargo.lock;

  meta = {
    inherit (manifest.package) description;
    homepage = "https://github.com/9sako6/zundamonotify";
    license = lib.licenses.mit;
    mainProgram = "zundamonotify";
    platforms = [ "aarch64-darwin" ];
  };
}
