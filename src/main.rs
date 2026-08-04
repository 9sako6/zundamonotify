use std::env;
use std::process::ExitCode;
use std::sync::Arc;
use zundamonotify::launchd::inspect_launch_agent;
use zundamonotify::monitor::start_default_monitors;
use zundamonotify::notifier::{AssetFiles, Notifier};
use zundamonotify::server::{NotificationHandler, Server};

const HELP: &str = "zundamonotify - AIエージェントの作業が終わったら、ずんだもんの声で知らせるのだ

使い方:
  zundamonotify status                 稼働状態を確認する
  zundamonotify --help                 ヘルプを表示する
  zundamonotify --version              バージョンを表示する

開発用:
  zundamonotify serve [--port <PORT>]  通知サーバーをフォアグラウンドで起動する";

fn main() -> ExitCode {
    match run(env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            if !message.is_empty() {
                eprintln!("{message}");
            }
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<(), String> {
    match args.first().map(String::as_str) {
        None | Some("--help" | "-h") => {
            println!("{HELP}");
            Ok(())
        }
        Some("--version" | "-v") => {
            println!(env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("status") => {
            for line in inspect_launch_agent().lines() {
                println!("{line}");
            }
            Ok(())
        }
        Some("serve") => serve(parse_port(&args[1..])?),
        Some(_) => {
            println!("{HELP}");
            Err(String::new())
        }
    }
}

fn parse_port(args: &[String]) -> Result<u16, String> {
    let value = match args {
        [] => "12378",
        [flag, value] if flag == "--port" || flag == "-p" => value,
        _ => return Err("ポートには 0〜65535 の整数を指定してほしいのだ".to_owned()),
    };
    value
        .parse::<u16>()
        .map_err(|_| "ポートには 0〜65535 の整数を指定してほしいのだ".to_owned())
}

fn serve(port: u16) -> Result<(), String> {
    let assets = AssetFiles::install()
        .map_err(|error| format!("音声ファイルを用意できなかったのだ：{error}"))?;
    let notifier = Notifier::new(assets);
    let notification_handler: NotificationHandler = {
        let notifier = notifier.clone();
        Arc::new(move |event| notifier.notify(event))
    };
    let server = Server::bind(port, notification_handler).map_err(|error| match error.kind() {
        std::io::ErrorKind::AddrInUse => format!("ポート {port} は使用中なのだ"),
        _ => format!("通知サーバーを起動できなかったのだ：{error}"),
    })?;
    let active_port = server
        .port()
        .map_err(|error| format!("通知サーバーのポートを確認できなかったのだ：{error}"))?;
    println!("通知サーバーを起動したのだ：http://127.0.0.1:{active_port}");
    println!("イベント受信先：POST /agent-events");

    let completion_handler =
        Arc::new(move || notifier.notify(zundamonotify::NotificationEvent::Stop));
    start_default_monitors(completion_handler);
    server
        .run()
        .map_err(|error| format!("通知サーバーが停止したのだ：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_default_and_explicit_ports() {
        assert_eq!(parse_port(&[]).unwrap(), 12378);
        assert_eq!(parse_port(&["--port".into(), "0".into()]).unwrap(), 0);
        assert_eq!(parse_port(&["-p".into(), "65535".into()]).unwrap(), 65535);
    }

    #[test]
    fn rejects_invalid_ports_and_arguments() {
        for args in [
            vec!["--port".into(), "abc".into()],
            vec!["--port".into(), "99999".into()],
            vec!["--port".into(), "3.14".into()],
            vec!["--unknown".into()],
        ] {
            assert!(parse_port(&args).is_err());
        }
    }
}
