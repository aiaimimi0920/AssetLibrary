use async_nats::jetstream::consumer::{AckPolicy, Config};
use std::time::Duration;

pub fn validate(config: &Config, name: &str, subject: &str) -> Result<(), std::io::Error> {
    if config.durable_name.as_deref() != Some(name)
        || config.filter_subject != subject
        || !config.filter_subjects.is_empty()
        || config.deliver_subject.is_some()
        || config.headers_only
        || config.ack_policy != AckPolicy::Explicit
        || config.ack_wait != Duration::from_secs(60)
        || config.max_deliver != 20
        || config.max_ack_pending != 1
    {
        return Err(std::io::Error::other(
            "existing indexer consumer configuration conflicts with required catalog contract",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected() -> Config {
        Config {
            durable_name: Some("indexer-test".into()),
            filter_subject: "assetlibrary.catalog.invalidated.v1".into(),
            ack_policy: AckPolicy::Explicit,
            ack_wait: Duration::from_secs(60),
            max_deliver: 20,
            max_ack_pending: 1,
            ..Default::default()
        }
    }

    fn check(config: &Config) -> Result<(), std::io::Error> {
        validate(
            config,
            "indexer-test",
            "assetlibrary.catalog.invalidated.v1",
        )
    }

    #[test]
    fn refuses_another_workers_durable_and_unsafe_ack_contract() {
        assert!(check(&expected()).is_ok());
        for change in [
            |c: &mut Config| {
                c.filter_subject = "assetlibrary.artifact.verification_requested.v1".into()
            },
            |c: &mut Config| c.filter_subjects.push("assetlibrary.>".into()),
            |c: &mut Config| c.durable_name = Some("scanner-test".into()),
            |c: &mut Config| c.ack_policy = AckPolicy::None,
            |c: &mut Config| c.max_ack_pending = 2,
            |c: &mut Config| c.max_deliver = -1,
            |c: &mut Config| c.ack_wait = Duration::from_secs(180),
            |c: &mut Config| c.headers_only = true,
            |c: &mut Config| c.deliver_subject = Some("push".into()),
        ] {
            let mut config = expected();
            change(&mut config);
            assert!(check(&config).is_err());
        }
    }
}
