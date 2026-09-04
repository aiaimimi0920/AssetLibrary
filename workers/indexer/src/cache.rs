use redis::AsyncCommands;
use uuid::Uuid;

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
        let mut connection = self.client.get_multiplexed_async_connection().await?;
        let _: usize = connection
            .del(format!("assetlibrary:catalog:package:{package_id}"))
            .await?;
        let _: i64 = connection
            .incr("assetlibrary:catalog:generation", 1_i64)
            .await?;
        Ok(())
    }

    pub async fn invalidate_all(&self) -> Result<(), redis::RedisError> {
        let mut connection = self.client.get_multiplexed_async_connection().await?;
        let _: i64 = connection
            .incr("assetlibrary:catalog:generation", 1_i64)
            .await?;
        Ok(())
    }
}
