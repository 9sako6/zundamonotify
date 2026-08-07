{
  description = "Zundamonotify for macOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/cf57e270b44b895e94fcce4b69c80ae5867e5d0b";

  outputs =
    { self, nixpkgs }:
    let
      system = "aarch64-darwin";
      pkgs = nixpkgs.legacyPackages.${system};
      package = pkgs.callPackage ./nix/package.nix { };
    in
    {
      apps.${system}.default = {
        type = "app";
        program = "${package}/bin/zundamonotify";
      };

      checks.${system} = {
        inherit package;
        module = import ./nix/module-test.nix {
          inherit pkgs;
          module = self.darwinModules.default;
        };
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.cargo
          pkgs.clippy
          pkgs.rustc
          pkgs.rustfmt
        ];
      };

      darwinModules.default = import ./nix/module.nix { inherit self; };

      packages.${system}.default = package;
    };
}
