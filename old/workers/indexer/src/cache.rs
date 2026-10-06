use redis::AsyncCommands;
use std::time::Duration;
use uuid::Uuid;

const CACHE_IO_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;

#[derive(Clone)]
pub struct Cache {
    client: redis::Client,
}

impl Cache {
    pub fn new(url: &str) -> Result<Self, redis::RedisError> {
        Ok(Self {
            client: redis::Client::open(url)?,
        })
    }

    pub async fn invalidate(&self, package_id: Uuid) -> Result<(), redis::RedisError> {
        let mut connection = self.connection().await?;
        let _: usize = connection
            .del(format!("assetlibrary:catalog:package:{package_id}"))
            .await?;
        let _: i64 = connection
            .incr("assetlibrary:catalog:generation", 1_i64)
            .await?;
        Ok(())
    }

    pub async fn invalidate_all(&self) -> Result<(), redis::RedisError> {
        let mut connection = self.connection().await?;
        let _: i64 = connection
            .incr("assetlibrary:catalog:generation", 1_i64)
            .await?;
        Ok(())
    }

    async fn connection(&self) -> Result<redis::aio::MultiplexedConnection, redis::RedisError> {
        // A timeout is an unknown execution result, not evidence of no write.
        // DEL is idempotent; retrying INCR may advance the cache epoch again,
        // which only discards more cache entries. It is never a billing counter.
        let config = redis::AsyncConnectionConfig::new()
            .set_connection_timeout(Some(CACHE_IO_TIMEOUT))
            .set_response_timeout(Some(CACHE_IO_TIMEOUT));
        self.client
            .get_multiplexed_async_connection_with_config(&config)
            .await
    }
}
