use crate::{Error, Result};
use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "calendar", rename_all = "snake_case", deny_unknown_fields)]
pub enum Schedule {
    Duration { seconds: u64 },
    Daily { hour: u8, minute: u8 },
    Monthly { day: u8, hour: u8, minute: u8 },
}

impl Default for Schedule {
    fn default() -> Self {
        Self::Monthly {
            day: 1,
            hour: 0,
            minute: 0,
        }
    }
}

impl Schedule {
    pub fn validate(&self) -> Result<()> {
        match *self {
            Self::Duration { seconds } if seconds > 0 && seconds <= i64::MAX as u64 / 1000 => {
                Ok(())
            }
            Self::Daily { hour, minute } if hour < 24 && minute < 60 => Ok(()),
            Self::Monthly { day, hour, minute }
                if (1..=31).contains(&day) && hour < 24 && minute < 60 =>
            {
                Ok(())
            }
            _ => Err(Error::Config("invalid UTC schedule")),
        }
    }

    /// Persist this exact instant. Catch-up callers pass now, not each missed due date.
    /// Monthly days absent in a month are clamped to that month's last day.
    pub fn next_after(&self, now: DateTime<Utc>) -> Result<DateTime<Utc>> {
        self.validate()?;
        let invalid = || Error::Config("schedule exceeds datetime range");
        match *self {
            Self::Duration { seconds } => now
                .checked_add_signed(Duration::seconds(seconds as i64))
                .ok_or_else(invalid),
            Self::Daily { hour, minute } => {
                let today = Utc
                    .with_ymd_and_hms(
                        now.year(),
                        now.month(),
                        now.day(),
                        hour.into(),
                        minute.into(),
                        0,
                    )
                    .single()
                    .ok_or_else(invalid)?;
                if today > now {
                    Ok(today)
                } else {
                    today
                        .checked_add_signed(Duration::days(1))
                        .ok_or_else(invalid)
                }
            }
            Self::Monthly { day, hour, minute } => {
                let mut year = now.year();
                let mut month = now.month();
                for _ in 0..2 {
                    let mut d = u32::from(day);
                    let candidate = loop {
                        if let Some(date) = Utc
                            .with_ymd_and_hms(year, month, d, hour.into(), minute.into(), 0)
                            .single()
                        {
                            break date;
                        }
                        if d == 1 {
                            return Err(invalid());
                        }
                        d -= 1;
                    };
                    if candidate > now {
                        return Ok(candidate);
                    }
                    if month == 12 {
                        year = year.checked_add(1).ok_or_else(invalid)?;
                        month = 1;
                    } else {
                        month += 1;
                    }
                }
                Err(invalid())
            }
        }
    }
}
