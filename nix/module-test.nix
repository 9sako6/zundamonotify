{ module, pkgs }:

let
  inherit (pkgs) lib;
  evaluated = lib.evalModules {
    modules = [
      module
      {
        options = {
          environment.systemPackages = lib.mkOption {
            type = lib.types.listOf lib.types.package;
            default = [ ];
          };
          launchd.user.agents = lib.mkOption {
            type = lib.types.attrsOf lib.types.anything;
            default = { };
          };
        };
        config.services.zundamonotify.enable = true;
      }
    ];
  };
  service = evaluated.config.launchd.user.agents.zundamonotify.serviceConfig;
in
pkgs.runCommand "zundamonotify-module-test" { } ''
  test '${service.Label}' = 'com.9sako6.zundamonotify'
  test '${builtins.toString (builtins.length service.ProgramArguments)}' = '2'
  test '${builtins.elemAt service.ProgramArguments 1}' = 'serve'
  test '${builtins.toString service.RunAtLoad}' = '1'
  test '${builtins.toString service.KeepAlive}' = '1'
  touch "$out"
''
