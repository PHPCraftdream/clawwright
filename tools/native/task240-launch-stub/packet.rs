//! Safe, allocation-free parser for the OCARGV01 launch packet.
//!
//! The wire format mirrors `stub.c`: magic, big-endian argc, length-prefixed
//! argv, big-endian envc, then length-prefixed environment entries.

pub const MAX_PACKET: usize = 4096;
pub const MAX_ARGS: usize = 16;
pub const MAX_ENV: usize = 2;
pub const ARGV_CAPACITY: usize = 3072;
pub const ENV_CAPACITY: usize = 1024;
const MAGIC: &[u8; 8] = b"OCARGV01";

#[derive(Eq, PartialEq)]
pub struct Packet {
    pub argv: [u8; ARGV_CAPACITY],
    pub env: [u8; ENV_CAPACITY],
    /// Byte offsets into `argv`; each value identifies a NUL-terminated arg.
    pub argv_offsets: [usize; MAX_ARGS],
    /// Byte offsets into `env`; each value identifies a NUL-terminated entry.
    pub env_offsets: [usize; MAX_ENV],
    pub argc: usize,
    pub envc: usize,
    /// Number of initialized bytes, including terminators.
    pub argv_used: usize,
    /// Number of initialized bytes, including terminators.
    pub env_used: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseError {
    PacketTooLarge,
    Truncated,
    BadMagic,
    InvalidArgumentCount,
    InvalidEnvironmentCount,
    InvalidArgumentLength,
    InvalidEnvironmentLength,
    InvalidUtf8,
    EmbeddedNul,
    ArgumentBudgetExceeded,
    EnvironmentBudgetExceeded,
    InvalidEnvironmentKey,
    DuplicateEnvironmentKey,
    TrailingBytes,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Prefix {
    NeedMore,
    Complete(usize),
}

/// Validate every fully available field without waiting for its body or EOF.
pub fn validate_prefix(input: &[u8]) -> Result<Prefix, ParseError> {
    if input.len() > MAX_PACKET {
        return Err(ParseError::PacketTooLarge);
    }
    if input.len() >= 8 && &input[..8] != MAGIC {
        return Err(ParseError::BadMagic);
    }
    if input.len() < 12 {
        return Ok(Prefix::NeedMore);
    }

    let mut cursor = 8;
    let argc = read_u32(input, &mut cursor)? as usize;
    if !(1..=MAX_ARGS).contains(&argc) {
        return Err(ParseError::InvalidArgumentCount);
    }

    let mut argv_used = 0usize;
    for _ in 0..argc {
        let len = match prefix_word(input, &mut cursor)? {
            Some(value) => value as usize,
            None => return Ok(Prefix::NeedMore),
        };
        if len == 0 || len > 1024 {
            return Err(ParseError::InvalidArgumentLength);
        }
        let end = argv_used
            .checked_add(len + 1)
            .ok_or(ParseError::ArgumentBudgetExceeded)?;
        if end > ARGV_CAPACITY {
            return Err(ParseError::ArgumentBudgetExceeded);
        }
        if cursor
            .checked_add(len)
            .filter(|&end| end <= MAX_PACKET)
            .is_none()
        {
            return Err(ParseError::PacketTooLarge);
        }
        if input.len() < cursor + len {
            return Ok(Prefix::NeedMore);
        }
        validate_string(&input[cursor..cursor + len])?;
        argv_used = end;
        cursor += len;
    }

    let envc = match prefix_word(input, &mut cursor)? {
        Some(value) => value as usize,
        None => return Ok(Prefix::NeedMore),
    };
    if envc > MAX_ENV {
        return Err(ParseError::InvalidEnvironmentCount);
    }

    let mut env_used = 0usize;
    let mut keys: [Option<&[u8]>; MAX_ENV] = [None; MAX_ENV];
    for index in 0..envc {
        let len = match prefix_word(input, &mut cursor)? {
            Some(value) => value as usize,
            None => return Ok(Prefix::NeedMore),
        };
        if !(3..=768).contains(&len) {
            return Err(ParseError::InvalidEnvironmentLength);
        }
        let end = env_used
            .checked_add(len + 1)
            .ok_or(ParseError::EnvironmentBudgetExceeded)?;
        if end > ENV_CAPACITY {
            return Err(ParseError::EnvironmentBudgetExceeded);
        }
        if cursor
            .checked_add(len)
            .filter(|&at| at <= MAX_PACKET)
            .is_none()
        {
            return Err(ParseError::PacketTooLarge);
        }
        if input.len() < cursor + len {
            return Ok(Prefix::NeedMore);
        }
        let bytes = &input[cursor..cursor + len];
        validate_string(bytes)?;
        let eq = bytes
            .iter()
            .position(|&b| b == b'=')
            .ok_or(ParseError::InvalidEnvironmentKey)?;
        let key = &bytes[..eq];
        if key != b"OPENCLAW_CONFIG_PATH" && key != b"CLAWWRIGHT_NATIVE_SOCKET" {
            return Err(ParseError::InvalidEnvironmentKey);
        }
        if keys[..index].iter().any(|previous| *previous == Some(key)) {
            return Err(ParseError::DuplicateEnvironmentKey);
        }
        keys[index] = Some(key);
        env_used = end;
        cursor += len;
    }

    if cursor < input.len() {
        return Err(ParseError::TrailingBytes);
    }
    Ok(Prefix::Complete(cursor))
}

pub fn parse(input: &[u8]) -> Result<Packet, ParseError> {
    match validate_prefix(input)? {
        Prefix::NeedMore => return Err(ParseError::Truncated),
        Prefix::Complete(_) => {}
    }
    if input.len() > MAX_PACKET {
        return Err(ParseError::PacketTooLarge);
    }
    let mut cursor = 0;
    if take(input, &mut cursor, 8)? != MAGIC {
        return Err(ParseError::BadMagic);
    }
    let argc = read_u32(input, &mut cursor)? as usize;
    if !(1..=MAX_ARGS).contains(&argc) {
        return Err(ParseError::InvalidArgumentCount);
    }

    let mut packet = Packet {
        argv: [0; ARGV_CAPACITY],
        env: [0; ENV_CAPACITY],
        argv_offsets: [0; MAX_ARGS],
        env_offsets: [0; MAX_ENV],
        argc,
        envc: 0,
        argv_used: 0,
        env_used: 0,
    };

    for index in 0..argc {
        let len = read_u32(input, &mut cursor)? as usize;
        if len == 0 || len > 1024 {
            return Err(ParseError::InvalidArgumentLength);
        }
        let bytes = take(input, &mut cursor, len)?;
        validate_string(bytes)?;
        let end = packet.argv_used.checked_add(len).and_then(|n| n.checked_add(1))
            .ok_or(ParseError::ArgumentBudgetExceeded)?;
        if end > ARGV_CAPACITY {
            return Err(ParseError::ArgumentBudgetExceeded);
        }
        packet.argv_offsets[index] = packet.argv_used;
        packet.argv[packet.argv_used..packet.argv_used + len].copy_from_slice(bytes);
        packet.argv[packet.argv_used + len] = 0;
        packet.argv_used = end;
    }

    let envc = read_u32(input, &mut cursor)? as usize;
    if envc > MAX_ENV {
        return Err(ParseError::InvalidEnvironmentCount);
    }
    packet.envc = envc;
    for index in 0..envc {
        let len = read_u32(input, &mut cursor)? as usize;
        if !(3..=768).contains(&len) {
            return Err(ParseError::InvalidEnvironmentLength);
        }
        let bytes = take(input, &mut cursor, len)?;
        validate_string(bytes)?;
        let eq = bytes.iter().position(|&b| b == b'=').ok_or(ParseError::InvalidEnvironmentKey)?;
        let key = &bytes[..eq];
        if key != b"OPENCLAW_CONFIG_PATH" && key != b"CLAWWRIGHT_NATIVE_SOCKET" {
            return Err(ParseError::InvalidEnvironmentKey);
        }
        for previous in 0..index {
            let start = packet.env_offsets[previous];
            let entry = &packet.env[start..packet.env_used - 1];
            let previous_eq = entry.iter().position(|&b| b == b'=').ok_or(ParseError::InvalidEnvironmentKey)?;
            if &entry[..previous_eq] == key {
                return Err(ParseError::DuplicateEnvironmentKey);
            }
        }
        let end = packet.env_used.checked_add(len).and_then(|n| n.checked_add(1))
            .ok_or(ParseError::EnvironmentBudgetExceeded)?;
        if end > ENV_CAPACITY {
            return Err(ParseError::EnvironmentBudgetExceeded);
        }
        packet.env_offsets[index] = packet.env_used;
        packet.env[packet.env_used..packet.env_used + len].copy_from_slice(bytes);
        packet.env[packet.env_used + len] = 0;
        packet.env_used = end;
    }
    if cursor != input.len() {
        return Err(ParseError::TrailingBytes);
    }
    Ok(packet)
}

fn take<'a>(input: &'a [u8], cursor: &mut usize, len: usize) -> Result<&'a [u8], ParseError> {
    let end = cursor.checked_add(len).ok_or(ParseError::Truncated)?;
    let bytes = input.get(*cursor..end).ok_or(ParseError::Truncated)?;
    *cursor = end;
    Ok(bytes)
}

fn prefix_word(input: &[u8], cursor: &mut usize) -> Result<Option<u32>, ParseError> {
    let field_end = cursor
        .checked_add(4)
        .filter(|&end| end <= MAX_PACKET)
        .ok_or(ParseError::PacketTooLarge)?;
    if input.len() < field_end {
        return Ok(None);
    }
    Ok(Some(read_u32(input, cursor)?))
}

fn read_u32(input: &[u8], cursor: &mut usize) -> Result<u32, ParseError> {
    let bytes = take(input, cursor, 4)?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn validate_string(bytes: &[u8]) -> Result<(), ParseError> {
    if bytes.contains(&0) {
        return Err(ParseError::EmbeddedNul);
    }
    core::str::from_utf8(bytes).map(|_| ()).map_err(|_| ParseError::InvalidUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(args: &[&[u8]], env: &[&[u8]]) -> Vec<u8> {
        let mut out = MAGIC.to_vec();
        put_len(&mut out, args.len());
        for arg in args { put_len(&mut out, arg.len()); out.extend_from_slice(arg); }
        put_len(&mut out, env.len());
        for entry in env { put_len(&mut out, entry.len()); out.extend_from_slice(entry); }
        out
    }
    fn put_len(out: &mut Vec<u8>, len: usize) { out.extend_from_slice(&(len as u32).to_be_bytes()); }

    #[test]
    fn prefix_rejects_invalid_fields_without_waiting_for_bodies() {
        let mut bad_magic = b"BADMAGIC".to_vec(); bad_magic.extend_from_slice(&0u32.to_be_bytes());
        assert_eq!(validate_prefix(&bad_magic).err(), Some(ParseError::BadMagic));
        let mut zero = MAGIC.to_vec(); put_len(&mut zero, 0);
        assert_eq!(validate_prefix(&zero).err(), Some(ParseError::InvalidArgumentCount));
        let mut many = MAGIC.to_vec(); put_len(&mut many, 17);
        assert_eq!(validate_prefix(&many).err(), Some(ParseError::InvalidArgumentCount));
        let mut long = MAGIC.to_vec(); put_len(&mut long, 1); put_len(&mut long, 1025);
        assert_eq!(validate_prefix(&long).err(), Some(ParseError::InvalidArgumentLength));
        let mut over_budget = MAGIC.to_vec(); put_len(&mut over_budget, 4);
        for len in [1023, 1023, 1023, 1] { put_len(&mut over_budget, len); if len != 1 { over_budget.extend(std::iter::repeat(b'x').take(len)); } }
        assert_eq!(validate_prefix(&over_budget).err(), Some(ParseError::ArgumentBudgetExceeded));
        let mut env = fixture(&[b"x"], &[]); env[17..21].copy_from_slice(&3u32.to_be_bytes());
        assert_eq!(validate_prefix(&env).err(), Some(ParseError::InvalidEnvironmentCount));
        let mut env_long = fixture(&[b"x"], &[]); env_long[17..21].copy_from_slice(&1u32.to_be_bytes()); put_len(&mut env_long, 769);
        assert_eq!(validate_prefix(&env_long).err(), Some(ParseError::InvalidEnvironmentLength));
        assert_eq!(validate_prefix(&fixture(&[b"x"], &[])).unwrap(), Prefix::Complete(fixture(&[b"x"], &[]).len()));
        let mut trailing = fixture(&[b"x"], &[]); trailing.push(0);
        assert_eq!(validate_prefix(&trailing).err(), Some(ParseError::TrailingBytes));
    }

    #[test]
    fn prefix_reports_complete_frame_length() {
        assert_eq!(validate_prefix(&fixture(&[b"x"], &[])).unwrap(), Prefix::Complete(fixture(&[b"x"], &[]).len()));
    }
    #[test]
    fn parses_owned_buffers_and_offsets() {
        let parsed = parse(&fixture(&[b"program", "λ".as_bytes()], &[b"OPENCLAW_CONFIG_PATH=/tmp/cfg"])).unwrap();
        assert_eq!(parsed.argc, 2);
        assert_eq!(&parsed.argv[parsed.argv_offsets[0]..parsed.argv_offsets[0] + 8], b"program\0");
        assert_eq!(&parsed.argv[parsed.argv_offsets[1]..parsed.argv_used], "λ\0".as_bytes());
        assert_eq!(&parsed.env[parsed.env_offsets[0]..parsed.env_used], b"OPENCLAW_CONFIG_PATH=/tmp/cfg\0");
    }

    #[test]
    fn every_truncated_prefix_is_rejected() {
        let encoded = fixture(&[b"program", b"argument"], &[b"CLAWWRIGHT_NATIVE_SOCKET=/tmp/sock"]);
        for offset in 0..encoded.len() {
            assert_eq!(validate_prefix(&encoded[..offset]), Ok(Prefix::NeedMore), "prefix {offset}");
            assert!(parse(&encoded[..offset]).is_err(), "prefix {offset} accepted");
        }
        assert_eq!(validate_prefix(&encoded), Ok(Prefix::Complete(encoded.len())));
        assert!(parse(&encoded).is_ok());
    }

    #[test]
    fn accepts_exact_argument_and_environment_budgets() {
        let args = [vec![b'a'; 1023], vec![b'b'; 1023], vec![b'c'; 1023]];
        let arg_refs: Vec<&[u8]> = args.iter().map(Vec::as_slice).collect();
        let encoded = fixture(&arg_refs, &[]);
        assert_eq!(parse(&encoded).unwrap().argv_used, ARGV_CAPACITY);

        let mut first = b"OPENCLAW_CONFIG_PATH=x".to_vec();
        first.resize(511, b'x');
        let mut second = b"CLAWWRIGHT_NATIVE_SOCKET=".to_vec();
        second.resize(511, b'x');
        let encoded_env = fixture(&[b"x"], &[&first, &second]);
        assert_eq!(parse(&encoded_env).unwrap().env_used, ENV_CAPACITY);
    }

    #[test]
    fn rejects_budget_overflow() {
        let args = [vec![b'a'; 1023], vec![b'b'; 1023], vec![b'c'; 1023], vec![b'd'; 1]];
        let arg_refs: Vec<&[u8]> = args.iter().map(Vec::as_slice).collect();
        assert_eq!(parse(&fixture(&arg_refs, &[])).err(), Some(ParseError::ArgumentBudgetExceeded));

        let first = b"OPENCLAW_CONFIG_PATH=".to_vec();
        let mut first = first;
        first.resize(512, b'x');
        let mut second = b"CLAWWRIGHT_NATIVE_SOCKET=".to_vec();
        second.resize(512, b'x');
        assert_eq!(parse(&fixture(&[b"x"], &[&first, &second])).err(), Some(ParseError::EnvironmentBudgetExceeded));
    }

    #[test]
    fn rejects_utf8_nul_and_invalid_environment_entries() {
        assert_eq!(parse(&fixture(&[b"\xff"], &[])).err(), Some(ParseError::InvalidUtf8));
        assert_eq!(parse(&fixture(&[b"a\0b"], &[])).err(), Some(ParseError::EmbeddedNul));
        assert_eq!(parse(&fixture(&[b"ok"], &[b"UNKNOWN=x"])).err(), Some(ParseError::InvalidEnvironmentKey));
        assert_eq!(parse(&fixture(&[b"ok"], &[b"OPENCLAW_CONFIG_PATH=x", b"OPENCLAW_CONFIG_PATH=y"])).err(), Some(ParseError::DuplicateEnvironmentKey));
    }

    #[test]
    fn rejects_counts_lengths_and_trailing_data() {
        let mut bad_args = MAGIC.to_vec(); put_len(&mut bad_args, 17);
        assert_eq!(parse(&bad_args).err(), Some(ParseError::InvalidArgumentCount));
        let mut bad_env = fixture(&[b"x"], &[]); bad_env[17..21].copy_from_slice(&3u32.to_be_bytes());
        assert_eq!(parse(&bad_env).err(), Some(ParseError::InvalidEnvironmentCount));
        let mut too_long = MAGIC.to_vec(); put_len(&mut too_long, 1); put_len(&mut too_long, 1025);
        assert_eq!(parse(&too_long).err(), Some(ParseError::InvalidArgumentLength));
        assert_eq!(parse(&fixture(&[b"x"], &[]).into_iter().chain([0]).collect::<Vec<_>>()).err(), Some(ParseError::TrailingBytes));
        assert_eq!(parse(&vec![0; MAX_PACKET + 1]).err(), Some(ParseError::PacketTooLarge));
    }
}
