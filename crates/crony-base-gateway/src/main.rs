use std::{path::PathBuf, process::ExitCode};

#[tokio::main]
async fn main() -> ExitCode {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let check_only = arguments.len() == 1 && arguments[0] == "--check-config";
    if !arguments.is_empty() && !check_only {
        eprintln!(
            "usage: crony-base-gateway [--check-config]; set ECORP_BASE_GATEWAY_CONFIG to a non-secret JSON configuration path"
        );
        return ExitCode::FAILURE;
    }
    let Some(path) = std::env::var_os("ECORP_BASE_GATEWAY_CONFIG") else {
        println!("Base signing gateway disabled: ECORP_BASE_GATEWAY_CONFIG is not set");
        return ExitCode::SUCCESS;
    };
    let result = async {
        let (config, trust) = crony_base_gateway::load_configuration(&PathBuf::from(path)).await?;
        if check_only {
            println!("Gateway configuration and independently pinned manifest chain verified; no connectivity or signing performed");
            Ok(())
        } else {
            crony_base_gateway::serve(config, trust).await
        }
    }.await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Base signing gateway refused startup: {error}");
            ExitCode::FAILURE
        }
    }
}
