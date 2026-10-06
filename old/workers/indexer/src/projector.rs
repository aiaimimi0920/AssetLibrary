use crate::{
    cache::Cache, edge_policy::EdgePolicy, opensearch::OpenSearch, repository::Repository,
};
use uuid::Uuid;

struct SearchProjection {
    client: OpenSearch,
    cache: Cache,
}

pub struct Projector {
    repository: Repository,
    search: Option<SearchProjection>,
    projection: &'static str,
    edge: Option<EdgePolicy>,
}

impl Projector {
    pub fn new(
        pool: sqlx::PgPool,
        config: &crate::config::Config,
    ) -> Result<Self, crate::DynError> {
        let search = config
            .search
            .as_ref()
            .map(|settings| -> Result<_, crate::DynError> {
                Ok(SearchProjection {
                    client: OpenSearch::new(settings)?,
                    cache: Cache::new(&settings.valkey_url)?,
                })
            })
            .transpose()?;
        Ok(Self {
            repository: Repository::new(pool),
            search,
            projection: config.mode.projection(),
            edge: config
                .edge_policy
                .clone()
                .map(EdgePolicy::new)
                .transpose()?,
        })
    }

    pub async fn ensure_live_index(&self) -> Result<(), String> {
        if let Some(search) = self.search.as_ref() {
            search.client.ensure_live_index().await?;
        }
        Ok(())
    }

    pub async fn project(&self, event_id: Uuid, package_id: Uuid) -> Result<(), String> {
        let guard = self.repository.projection_guard().await.map_err(database)?;
        if self
            .repository
            .was_processed(self.projection, event_id)
            .await
            .map_err(database)?
        {
            guard.commit().await.map_err(database)?;
            return Ok(());
        }
        let document = self
            .repository
            .document(package_id)
            .await
            .map_err(database)?;
        if let Some(search) = self.search.as_ref() {
            match document.as_ref() {
                Some(document) => search.client.upsert(&search.client.alias, document).await?,
                None => {
                    search
                        .client
                        .delete(&search.client.alias, package_id)
                        .await?
                }
            }
        }
        if let Some(edge) = self.edge.as_ref() {
            edge.reconcile(&self.repository, package_id, document.as_ref())
                .await?;
        }
        if let Some(search) = self.search.as_ref() {
            search
                .cache
                .invalidate(package_id)
                .await
                .map_err(|_| "Valkey invalidation failed".to_owned())?;
        }
        self.repository
            .mark_processed(self.projection, event_id, package_id)
            .await
            .map_err(database)?;
        guard.commit().await.map_err(database)
    }

    pub async fn rebuild(&self) -> Result<String, String> {
        let search = self
            .search
            .as_ref()
            .ok_or("rebuild requires search-edge mode")?;
        let guard = self.repository.projection_guard().await.map_err(database)?;
        let index = search.client.create_rebuild_index().await?;
        if let Err(error) = self.populate_rebuild(&index).await {
            let _ = search.client.delete_if_unaliased(&index).await;
            return Err(error);
        }
        if let Err(error) = search.client.swap_alias(&index).await {
            let _ = search.client.delete_if_unaliased(&index).await;
            return Err(error);
        }
        self.repository
            .set_active_index(&search.client.alias, &index)
            .await
            .map_err(database)?;
        search
            .cache
            .invalidate_all()
            .await
            .map_err(|_| "Valkey generation invalidation failed".to_owned())?;
        guard.commit().await.map_err(database)?;
        Ok(index)
    }

    async fn populate_rebuild(&self, index: &str) -> Result<(), String> {
        let search = self
            .search
            .as_ref()
            .ok_or("rebuild requires search-edge mode")?;
        let mut after = None;
        loop {
            let ids = self
                .repository
                .package_ids(after, 200)
                .await
                .map_err(database)?;
            if ids.is_empty() {
                break;
            }
            for package_id in ids.iter().copied() {
                let document = self
                    .repository
                    .document(package_id)
                    .await
                    .map_err(database)?;
                if let Some(document) = document.as_ref() {
                    search.client.upsert_for_rebuild(&index, document).await?;
                }
            }
            after = ids.last().copied();
        }
        search.client.refresh(&index).await?;
        Ok(())
    }
}

fn database(error: sqlx::Error) -> String {
    format!("indexer database operation failed: {error}")
}
