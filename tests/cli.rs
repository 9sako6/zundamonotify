use std::process::Command;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_zundamonotify"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn help_and_no_arguments_succeed() {
    for args in [&[][..], &["help"][..], &["--help"][..], &["-h"][..]] {
        let output = run(args);
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("zundamonotify"));
        assert!(stdout.contains("status"));
        assert!(stdout.contains("serve"));
        assert!(stdout.contains("zundamonotify help"));
        assert!(stdout.contains("zundamonotify version"));
        assert!(!stdout.contains("zundamonotify --help"));
        assert!(!stdout.contains("zundamonotify --version"));
        assert!(!stdout.contains("install"));
        assert!(!stdout.contains("uninstall"));
    }
}

#[test]
fn version_comes_from_the_cargo_manifest() {
    for command in ["version", "--version", "-v"] {
        let output = run(&[command]);
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            env!("CARGO_PKG_VERSION")
        );
    }
}

#[test]
fn status_includes_the_version_from_the_cargo_manifest() {
    let output = run(&["status"]);
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains(&format!("バージョン：{}", env!("CARGO_PKG_VERSION")))
    );
}

#[test]
fn unknown_commands_print_help_and_fail() {
    let output = run(&["unknown"]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("使い方:")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_ports_explain_the_valid_range() {
    for port in ["abc", "99999", "3.14"] {
        let output = run(&["serve", "--port", port]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("ポートには 0〜65535 の整数を指定してほしいのだ")
        );
    }
}
