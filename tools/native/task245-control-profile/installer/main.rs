#![cfg(target_arch = "x86_64")]

mod filters;
mod linux;

use std::ffi::{CString, OsStr};
use std::io;
use std::os::unix::ffi::OsStrExt;

const MAX_REF_BYTES: usize = 32_768;
const ALLOWED_MODES: &[&str] = &["golden", "withheld", "unknown", "cancel"];

fn valid_ref(bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes.len() <= MAX_REF_BYTES
        && bytes != b"."
        && bytes != b".."
        && !bytes.contains(&b'/')
        && !bytes.iter().any(|byte| *byte < 0x20 || *byte == 0x7f)
        && !bytes.contains(&0)
}

fn cstring(value: Vec<u8>) -> io::Result<CString> {
    CString::new(value).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

fn environment_entry(key: &str, value: &OsStr) -> io::Result<CString> {
    if value.as_bytes().is_empty() {
        return Err(invalid_input());
    }
    let mut entry = key.as_bytes().to_vec();
    entry.push(b'=');
    entry.extend_from_slice(value.as_bytes());
    cstring(entry)
}

fn build_environment() -> io::Result<Vec<CString>> {
    let mut environment = Vec::new();
    for key in [
        "SSJACK_ENV_TOKEN",
        "SSJACK_SESSION",
        "SSJACK_ENDPOINT",
        "SSJACK_CERTIFICATE_SHA256",
    ] {
        let value = std::env::var_os(key).ok_or_else(invalid_input)?;
        if value.as_os_str().as_bytes().is_empty() {
            return Err(invalid_input());
        }
        environment.push(environment_entry(key, value.as_os_str())?);
    }
    environment.push(cstring(b"PATH=/lab/bin".to_vec())?);
    environment.push(cstring(b"LANG=C".to_vec())?);
    environment.push(cstring(b"LC_ALL=C".to_vec())?);
    Ok(environment)
}

fn run() -> io::Result<()> {
    let mut args = std::env::args_os();
    let _program = args.next();
    let reference = args.next().ok_or_else(invalid_input)?;
    let mode = args.next().ok_or_else(invalid_input)?;
    if args.next().is_some() {
        return Err(invalid_input());
    }

    let reference_bytes = reference.as_os_str().as_bytes();
    if !valid_ref(reference_bytes) {
        return Err(invalid_input());
    }
    let mode = mode.into_string().map_err(|_| invalid_input())?;
    if !ALLOWED_MODES.contains(&mode.as_str()) {
        return Err(invalid_input());
    }

    let mut argv = Vec::with_capacity(3);
    argv.push(cstring(b"/lab/bin/harness".to_vec())?);
    argv.push(cstring(reference_bytes.to_vec())?);
    argv.push(cstring(mode.as_bytes().to_vec())?);
    let environment = build_environment()?;

    linux::prepare(&mode)?;
    let golden = mode == "golden";
    linux::close_inherited(golden)?;
    if !golden {
        linux::reserve_cancel_fd()?;
        linux::handoff(&filters::metadata_filter())?;
    }
    linux::confine(&filters::control_filter())?;
    linux::exec(&argv, &environment)
}

fn invalid_input() -> io::Error {
    io::Error::from(io::ErrorKind::InvalidInput)
}

fn main() {
    if run().is_err() {
        eprintln!("installer: error 126");
        std::process::exit(126);
    }
}

#[cfg(test)]
mod tests {
    use super::{environment_entry, valid_ref, OsStr};

    #[test]
    fn environment_entries_require_nonempty_nul_free_values() {
        assert_eq!(
            environment_entry("KEY", OsStr::new("value")).unwrap().as_bytes(),
            b"KEY=value"
        );
        assert!(environment_entry("KEY", OsStr::new("")).is_err());
        assert!(environment_entry("KEY", OsStr::new("bad\0value")).is_err());
    }

    #[test]
    fn reference_bytes_are_bounded_and_path_safe() {
        assert!(valid_ref(b"ref-1"));
        assert!(valid_ref(&[0xff, b'x']));
        assert!(!valid_ref(b""));
        assert!(!valid_ref(b".."));
        assert!(!valid_ref(b"a/b"));
        assert!(!valid_ref(b"a\0b"));
        assert!(!valid_ref(&vec![b'x'; super::MAX_REF_BYTES + 1]));
    }
}
