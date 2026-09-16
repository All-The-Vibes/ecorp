//! RPC metadata may contain finite ratio floats. Monetary fields remain typed integer quantities.
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;

struct RpcValue(Value);
impl<'de> Deserialize<'de> for RpcValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RpcVisitor;
        impl<'de> Visitor<'de> for RpcVisitor {
            type Value = RpcValue;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("finite JSON with unique object keys")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<RpcValue, E> {
                Ok(RpcValue(Value::Bool(value)))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<RpcValue, E> {
                Ok(RpcValue(Value::Number(value.into())))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<RpcValue, E> {
                Ok(RpcValue(Value::Number(value.into())))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<RpcValue, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| RpcValue(Value::Number(number)))
                    .ok_or_else(|| E::custom("nonfinite RPC number"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<RpcValue, E> {
                Ok(RpcValue(Value::String(value.into())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<RpcValue, E> {
                Ok(RpcValue(Value::String(value)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<RpcValue, E> {
                Ok(RpcValue(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> Result<RpcValue, E> {
                Ok(RpcValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<RpcValue, A::Error> {
                let mut values = Vec::new();
                while let Some(RpcValue(value)) = sequence.next_element::<RpcValue>()? {
                    values.push(value);
                }
                Ok(RpcValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RpcValue, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate RPC object key"));
                    }
                    values.insert(key, map.next_value::<RpcValue>()?.0);
                }
                Ok(RpcValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(RpcVisitor)
    }
}
pub(crate) fn parse(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    // serde_json's normal recursion bound and complete-input check remain enabled.
    serde_json::from_slice::<RpcValue>(bytes).map(|value| value.0)
}

#[cfg(test)]
mod tests {
    use super::parse;
    #[test]
    fn rejects_duplicate_escaped_keys_nonfinite_overflow_and_trailing_input() {
        for input in [
            br#"{"x":1,"\u0078":2}"#.as_slice(),
            br#"{"ratio":NaN}"#,
            br#"{"ratio":1e400}"#,
            br#"{"ratio":0.5} true"#,
            br#"{"nested":[{"x":0.1,"x":0.2}]}"#,
        ] {
            assert!(parse(input).is_err());
        }
        assert_eq!(
            parse(br#"{"ratio":0.5,"fees":"0xffff"}"#).unwrap()["ratio"],
            0.5
        );
        assert!(crony_audit::parse_json::<serde_json::Value>(br#"{"ratio":0.5}"#).is_err());
    }
}
