import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV30(this: OrchestrationDb, current: number): void {
  if (current >= 30) {
    return
  }
  if (!this.hasColumn('runs', 'coordinator_client_fingerprint')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN coordinator_client_fingerprint TEXT')
  }
  this.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_external_coordinator
      ON runs(coordinator_client_fingerprint)
      WHERE coordinator_client_fingerprint IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS trg_runs_terminal_binding_revokes_external
    AFTER UPDATE OF coordinator_handle, coordinator_pane_key ON runs
    WHEN NEW.coordinator_handle IS NOT NULL OR NEW.coordinator_pane_key IS NOT NULL
    BEGIN
      UPDATE runs
      SET coordinator_client_fingerprint = NULL
      WHERE id = NEW.id AND coordinator_client_fingerprint IS NOT NULL;
    END;
  `)
}
