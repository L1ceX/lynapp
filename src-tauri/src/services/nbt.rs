use flate2::read::GzDecoder;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum NbtValue {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<u8>),
    String(String),
    List(Vec<NbtValue>),
    Compound(HashMap<String, NbtValue>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

impl NbtValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            NbtValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            NbtValue::Byte(v) => Some(*v as i64),
            NbtValue::Short(v) => Some(*v as i64),
            NbtValue::Int(v) => Some(*v as i64),
            NbtValue::Long(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_compound(&self) -> Option<&HashMap<String, NbtValue>> {
        match self {
            NbtValue::Compound(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[NbtValue]> {
        match self {
            NbtValue::List(l) => Some(l.as_slice()),
            _ => None,
        }
    }
}

fn decode_mutf8(bytes: &[u8]) -> Result<String, String> {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Ok(s.to_string());
    }
    let mut units: Vec<u16> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if (c & 0x80) == 0 {
            units.push(c as u16);
            i += 1;
        } else if (c & 0xe0) == 0xc0 {
            if i + 1 >= bytes.len() {
                return Err("Malformed MUTF-8".to_string());
            }
            let c2 = bytes[i + 1];
            units.push((((c & 0x1f) as u16) << 6) | ((c2 & 0x3f) as u16));
            i += 2;
        } else if (c & 0xf0) == 0xe0 {
            if i + 2 >= bytes.len() {
                return Err("Malformed MUTF-8".to_string());
            }
            let c2 = bytes[i + 1];
            let c3 = bytes[i + 2];
            units.push(
                (((c & 0x0f) as u16) << 12) | (((c2 & 0x3f) as u16) << 6) | ((c3 & 0x3f) as u16),
            );
            i += 3;
        } else {
            return Err("Malformed MUTF-8".to_string());
        }
    }
    Ok(String::from_utf16_lossy(&units))
}

fn encode_mutf8(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for unit in s.encode_utf16() {
        if unit >= 0x0001 && unit <= 0x007f {
            out.push(unit as u8);
        } else if unit > 0x07ff {
            out.push(0xe0 | ((unit >> 12) & 0x0f) as u8);
            out.push(0x80 | ((unit >> 6) & 0x3f) as u8);
            out.push(0x80 | (unit & 0x3f) as u8);
        } else {
            out.push(0xc0 | ((unit >> 6) & 0x1f) as u8);
            out.push(0x80 | (unit & 0x3f) as u8);
        }
    }
    out
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.buf.len() {
            return Err("Unexpected end of NBT data".to_string());
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_bytes(1)?[0])
    }

    fn read_i16(&mut self) -> Result<i16, String> {
        let b = self.read_bytes(2)?;
        Ok(i16::from_be_bytes([b[0], b[1]]))
    }

    fn read_u16(&mut self) -> Result<u16, String> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn read_i32(&mut self) -> Result<i32, String> {
        let b = self.read_bytes(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_i64(&mut self) -> Result<i64, String> {
        let b = self.read_bytes(8)?;
        Ok(i64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn read_f32(&mut self) -> Result<f32, String> {
        let b = self.read_bytes(4)?;
        Ok(f32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_f64(&mut self) -> Result<f64, String> {
        let b = self.read_bytes(8)?;
        Ok(f64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn read_string(&mut self) -> Result<String, String> {
        let len = self.read_u16()? as usize;
        let bytes = self.read_bytes(len)?;
        decode_mutf8(bytes)
    }

    fn read_payload(&mut self, tag: u8) -> Result<NbtValue, String> {
        match tag {
            1 => Ok(NbtValue::Byte(self.read_u8()? as i8)),
            2 => Ok(NbtValue::Short(self.read_i16()?)),
            3 => Ok(NbtValue::Int(self.read_i32()?)),
            4 => Ok(NbtValue::Long(self.read_i64()?)),
            5 => Ok(NbtValue::Float(self.read_f32()?)),
            6 => Ok(NbtValue::Double(self.read_f64()?)),
            7 => {
                let len = self.read_i32()?;
                if len < 0 {
                    return Err("Negative byte array".to_string());
                }
                Ok(NbtValue::ByteArray(self.read_bytes(len as usize)?.to_vec()))
            }
            8 => Ok(NbtValue::String(self.read_string()?)),
            9 => {
                let elem_type = self.read_u8()?;
                let len = self.read_i32()?;
                if len < 0 || len > 1_000_000 {
                    return Err("Invalid NBT list length".to_string());
                }
                let mut out = Vec::with_capacity(len as usize);
                for _ in 0..len {
                    out.push(self.read_payload(elem_type)?);
                }
                Ok(NbtValue::List(out))
            }
            10 => {
                let mut map = HashMap::new();
                loop {
                    let t = self.read_u8()?;
                    if t == 0 {
                        break;
                    }
                    let name = self.read_string()?;
                    let val = self.read_payload(t)?;
                    map.insert(name, val);
                }
                Ok(NbtValue::Compound(map))
            }
            11 => {
                let len = self.read_i32()?;
                if len < 0 {
                    return Err("Negative int array".to_string());
                }
                let mut out = Vec::with_capacity(len as usize);
                for _ in 0..len {
                    out.push(self.read_i32()?);
                }
                Ok(NbtValue::IntArray(out))
            }
            12 => {
                let len = self.read_i32()?;
                if len < 0 {
                    return Err("Negative long array".to_string());
                }
                let mut out = Vec::with_capacity(len as usize);
                for _ in 0..len {
                    out.push(self.read_i64()?);
                }
                Ok(NbtValue::LongArray(out))
            }
            _ => Err(format!("Unsupported NBT tag {tag}")),
        }
    }
}

pub fn parse_nbt(raw: &[u8]) -> Result<HashMap<String, NbtValue>, String> {
    let data = if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let mut gz = GzDecoder::new(raw);
        let mut out = Vec::new();
        gz.read_to_end(&mut out).map_err(|e| e.to_string())?;
        out
    } else {
        raw.to_vec()
    };
    let mut reader = Reader { buf: &data, pos: 0 };
    let root_tag = reader.read_u8()?;
    if root_tag != 10 {
        return Err("Root NBT tag is not a compound".to_string());
    }
    let _ = reader.read_string()?;
    match reader.read_payload(10)? {
        NbtValue::Compound(m) => Ok(m),
        _ => Err("Invalid root compound".to_string()),
    }
}

#[derive(Debug, Clone)]
pub struct RawServerNbtEntry {
    pub name: String,
    pub ip: String,
    pub icon: Option<String>,
    pub accept_textures: Option<i8>,
    pub hidden: Option<i8>,
}

fn push_nbt_string(out: &mut Vec<u8>, s: &str) -> Result<(), String> {
    let bytes = encode_mutf8(s);
    if bytes.len() > 65535 {
        return Err("NBT string exceeds 65535 bytes".to_string());
    }
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(&bytes);
    Ok(())
}

pub fn write_servers_dat(servers: &[RawServerNbtEntry]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    out.push(10);
    push_nbt_string(&mut out, "")?;
    out.push(9);
    push_nbt_string(&mut out, "servers")?;
    out.push(10);
    out.extend_from_slice(&(servers.len() as i32).to_be_bytes());
    for srv in servers {
        out.push(8);
        push_nbt_string(&mut out, "name")?;
        push_nbt_string(&mut out, &srv.name)?;
        out.push(8);
        push_nbt_string(&mut out, "ip")?;
        push_nbt_string(&mut out, &srv.ip)?;
        if let Some(icon) = &srv.icon {
            out.push(8);
            push_nbt_string(&mut out, "icon")?;
            push_nbt_string(&mut out, icon)?;
        }
        if let Some(at) = srv.accept_textures {
            out.push(1);
            push_nbt_string(&mut out, "acceptTextures")?;
            out.push(at as u8);
        }
        if let Some(h) = srv.hidden {
            out.push(1);
            push_nbt_string(&mut out, "hidden")?;
            out.push(h as u8);
        }
        out.push(0);
    }
    out.push(0);
    Ok(out)
}
