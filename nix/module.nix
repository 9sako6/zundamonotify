{ self }:

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.zundamonotify;
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  options.services.zundamonotify.enable = lib.mkEnableOption "zundamonotify";

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ package ];

    launchd.user.agents.zundamonotify.serviceConfig = {
      Label = "com.9sako6.zundamonotify";
      ProgramArguments = [
        "${package}/bin/zundamonotify"
        "serve"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/dev/null";
      StandardErrorPath = "/dev/null";
    };
  };
}
