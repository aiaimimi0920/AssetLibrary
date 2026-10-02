//! Never recycle a connection whose transaction lifecycle was interrupted.
use sqlx::{PgConnection, PgPool, Postgres, pool::PoolConnection};

pub(super) struct SearchConnection {
    connection: PoolConnection<Postgres>,
    completed: bool,
}

impl SearchConnection {
    pub(super) async fn acquire(pool: &PgPool) -> Result<Self, sqlx::Error> {
        Ok(Self {
            connection: pool.acquire().await?,
            completed: false,
        })
    }

    pub(super) fn connection(&mut self) -> &mut PgConnection {
        &mut self.connection
    }

    pub(super) fn release(mut self) {
        self.completed = true;
    }
}

impl Drop for SearchConnection {
    fn drop(&mut self) {
        // SQLx 0.8 cannot track a BEGIN whose ReadyForQuery has not arrived yet.
        // Install this guard before BEGIN, and recycle only after COMMIT returns.
        // Cancellation during acquisition never hands a connection to this guard.
        if !self.completed {
            self.connection.close_on_drop();
        }
    }
}
