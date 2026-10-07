use anchor_lang_idl::build::IdlBuilder;
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let program = PathBuf::from(args.next().ok_or("program directory required")?).canonicalize()?;
    let output = PathBuf::from(args.next().ok_or("output path required")?);
    // anchor-lang-idl 0.1.4 passes the literal "+{toolchain}" when Rustup sets
    // RUSTUP_TOOLCHAIN. Use the resolved Cargo binary of this running build,
    // preserving the selected compiler while avoiding that upstream branch.
    if let Some(cargo) = env::var_os("CARGO") {
        if let Some(bin) = PathBuf::from(cargo).parent() {
            let mut paths = vec![bin.to_path_buf()];
            paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
            env::set_var("PATH", env::join_paths(paths)?);
        }
    }
    env::remove_var("RUSTUP_TOOLCHAIN");
    let idl = IdlBuilder::new().program_path(program).build()?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        &output,
        format!("{}\n", serde_json::to_string_pretty(&idl)?),
    )?;
    println!(
        "Generated {} instructions into {}",
        idl.instructions.len(),
        output.display()
    );
    Ok(())
}
