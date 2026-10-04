fn main() {
    #[cfg(windows)]
    {
        let args: Vec<_> = std::env::args().collect();
        let result = if args.len() == 4
            && args[1] == "--mivlet-execution-setup"
            && matches!(args[3].as_str(), "repair" | "cleanup")
        {
            mivlet_windows_executor::setup::configure(&args[2], args[3] == "cleanup")
        } else {
            Err("Only bounded native execution setup/cleanup is supported.".to_owned())
        };
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
    #[cfg(not(windows))]
    std::process::exit(2);
}
