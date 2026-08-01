{ self }:

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.zundamonotify;
  defaultPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  options.services.zundamonotify = {
    enable = lib.mkEnableOption "zundamonotify";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage;
      defaultText = lib.literalExpression "zundamonotify.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "The zundamonotify package to run.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 12378;
      description = "The local HTTP port used by zundamonotify.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    launchd.user.agents.zundamonotify.serviceConfig = {
      Label = "com.9sako6.zundamonotify";
      ProgramArguments = [
        "${cfg.package}/bin/zundamonotify"
        "serve"
        "--port"
        (builtins.toString cfg.port)
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/dev/null";
      StandardErrorPath = "/dev/null";
    };
  };
}
