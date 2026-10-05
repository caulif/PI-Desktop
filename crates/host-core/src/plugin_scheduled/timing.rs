use super::*;

pub(super) fn latest_due(
    schedule: &scheduled::timing::Schedule,
    cadence: &str,
    zone: &Tz,
    first: i64,
    now: i64,
) -> Result<(i64, i64)> {
    if let Some(period) = match cadence {
        "hourly" => Some(3_600_000i64),
        "interval" => schedule
            .interval_minutes
            .map(|minutes| i64::from(minutes) * 60_000),
        _ => None,
    } {
        let count = (now - first).div_euclid(period);
        let last = first
            .checked_add(
                count
                    .checked_mul(period)
                    .ok_or_else(|| anyhow::anyhow!("schedule overflow"))?,
            )
            .ok_or_else(|| anyhow::anyhow!("schedule overflow"))?;
        return Ok((
            last,
            last.checked_add(period)
                .ok_or_else(|| anyhow::anyhow!("schedule overflow"))?,
        ));
    }
    let scan_from = now.saturating_sub(if cadence == "hourly_at" {
        26 * 60 * 60 * 1000
    } else {
        8 * 24 * 60 * 60 * 1000
    });
    let mut candidate = if first >= scan_from {
        first
    } else {
        schedule
            .next_in(cadence, scan_from, zone)
            .ok_or_else(|| anyhow::anyhow!("schedule has no next occurrence"))?
    };
    let mut last = first;
    for _ in 0..if cadence == "hourly_at" { 32 } else { 10 } {
        if candidate > now {
            return Ok((last, candidate));
        }
        last = candidate;
        candidate = schedule
            .next_in(cadence, candidate, zone)
            .ok_or_else(|| anyhow::anyhow!("schedule has no next occurrence"))?;
    }
    bail!("calendar schedule exceeded catch-up bound")
}
