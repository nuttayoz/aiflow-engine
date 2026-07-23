import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SharePointEntry1784851200000 implements MigrationInterface {
  readonly name = 'SharePointEntry1784851200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE connector_provisioning_bindings (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        workflow_id uuid NOT NULL,
        workflow_version_id uuid NOT NULL,
        connector_id varchar(180) NOT NULL,
        capability varchar(32) NOT NULL,
        capability_version integer NOT NULL,
        configuration_schema_version integer NOT NULL,
        connection_id uuid NOT NULL,
        configuration_hash varchar(64) NOT NULL,
        capability_hash varchar(64) NOT NULL,
        provisioning_key uuid NOT NULL,
        provider_resource_ref varchar(180),
        status varchar(32) NOT NULL DEFAULT 'PREPARING',
        health varchar(32) NOT NULL DEFAULT 'UNKNOWN',
        accepting_new_documents boolean NOT NULL DEFAULT false,
        generation bigint NOT NULL DEFAULT 1,
        state_version bigint NOT NULL DEFAULT 0,
        drain_deadline_at timestamptz,
        failure_code varchar(180),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        retired_at timestamptz,
        CONSTRAINT connector_provisioning_bindings_tenant_id_id_unique
          UNIQUE (tenant_id, id),
        CONSTRAINT connector_provisioning_bindings_version_unique
          UNIQUE (
            tenant_id,
            workflow_version_id,
            connector_id,
            capability,
            capability_version
          ),
        CONSTRAINT connector_provisioning_bindings_provisioning_key_unique
          UNIQUE (provisioning_key),
        CONSTRAINT connector_provisioning_bindings_workflow_version_fk
          FOREIGN KEY (tenant_id, workflow_id, workflow_version_id)
          REFERENCES workflow_versions (tenant_id, workflow_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT connector_provisioning_bindings_connection_fk
          FOREIGN KEY (tenant_id, connection_id)
          REFERENCES connections (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT connector_provisioning_bindings_capability_check
          CHECK (capability = 'ENTRY'),
        CONSTRAINT connector_provisioning_bindings_status_check
          CHECK (
            status IN ('PREPARING', 'ACTIVE', 'DRAINING', 'RETIRED', 'FAILED')
          ),
        CONSTRAINT connector_provisioning_bindings_health_check
          CHECK (health IN ('HEALTHY', 'DEGRADED', 'UNKNOWN')),
        CONSTRAINT connector_provisioning_bindings_versions_check
          CHECK (
            capability_version > 0
            AND configuration_schema_version > 0
            AND generation > 0
            AND state_version >= 0
          ),
        CONSTRAINT connector_provisioning_bindings_hashes_check
          CHECK (
            configuration_hash ~ '^[a-f0-9]{64}$'
            AND capability_hash ~ '^[a-f0-9]{64}$'
          ),
        CONSTRAINT connector_provisioning_bindings_intake_check
          CHECK (
            NOT accepting_new_documents
            OR status IN ('ACTIVE', 'DRAINING')
          ),
        CONSTRAINT connector_provisioning_bindings_resource_check
          CHECK (
            status NOT IN ('ACTIVE', 'DRAINING')
            OR provider_resource_ref IS NOT NULL
          ),
        CONSTRAINT connector_provisioning_bindings_retired_check
          CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX connector_provisioning_bindings_workflow_idx
      ON connector_provisioning_bindings (
        tenant_id,
        workflow_id,
        status,
        workflow_version_id
      )
    `);

    await queryRunner.query(`
      CREATE TABLE sharepoint_drive_watches (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        connection_id uuid NOT NULL,
        external_tenant_id varchar(180) NOT NULL,
        site_id varchar(512) NOT NULL,
        drive_id varchar(512) NOT NULL,
        root_item_id varchar(512) NOT NULL,
        resource varchar(768) NOT NULL,
        change_type varchar(32) NOT NULL,
        subscription_id varchar(512),
        subscription_expires_at timestamptz,
        client_state_key_version integer NOT NULL,
        client_state_digest varchar(64) NOT NULL,
        committed_delta_cursor_ciphertext bytea,
        scan_next_cursor_ciphertext bytea,
        baseline_status varchar(32) NOT NULL DEFAULT 'PENDING',
        subscription_status varchar(32) NOT NULL DEFAULT 'ABSENT',
        health varchar(32) NOT NULL DEFAULT 'UNKNOWN',
        notification_generation bigint NOT NULL DEFAULT 0,
        sync_command_pending boolean NOT NULL DEFAULT false,
        state_version bigint NOT NULL DEFAULT 0,
        next_reconcile_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        lease_owner varchar(180),
        lease_expires_at timestamptz,
        failure_code varchar(180),
        last_notification_at timestamptz,
        last_reconciled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT sharepoint_drive_watches_tenant_id_id_unique
          UNIQUE (tenant_id, id),
        CONSTRAINT sharepoint_drive_watches_scope_unique
          UNIQUE (tenant_id, connection_id, drive_id),
        CONSTRAINT sharepoint_drive_watches_subscription_unique
          UNIQUE (subscription_id),
        CONSTRAINT sharepoint_drive_watches_connection_fk
          FOREIGN KEY (tenant_id, connection_id)
          REFERENCES connections (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sharepoint_drive_watches_change_type_check
          CHECK (change_type = 'updated'),
        CONSTRAINT sharepoint_drive_watches_baseline_check
          CHECK (
            baseline_status IN (
              'PENDING',
              'RUNNING',
              'COMPLETE',
              'RECONCILING',
              'FAILED'
            )
          ),
        CONSTRAINT sharepoint_drive_watches_subscription_status_check
          CHECK (
            subscription_status IN (
              'ABSENT',
              'CREATING',
              'ACTIVE',
              'RENEWING',
              'DELETING',
              'UNKNOWN',
              'FAILED'
            )
          ),
        CONSTRAINT sharepoint_drive_watches_health_check
          CHECK (health IN ('HEALTHY', 'DEGRADED', 'UNKNOWN')),
        CONSTRAINT sharepoint_drive_watches_version_check
          CHECK (
            client_state_key_version > 0
            AND notification_generation >= 0
            AND state_version >= 0
          ),
        CONSTRAINT sharepoint_drive_watches_client_state_check
          CHECK (client_state_digest ~ '^[a-f0-9]{64}$'),
        CONSTRAINT sharepoint_drive_watches_active_subscription_check
          CHECK (
            subscription_status <> 'ACTIVE'
            OR (
              subscription_id IS NOT NULL
              AND subscription_expires_at IS NOT NULL
            )
          ),
        CONSTRAINT sharepoint_drive_watches_lease_check
          CHECK (
            (lease_owner IS NULL AND lease_expires_at IS NULL)
            OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
          )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX sharepoint_drive_watches_due_idx
      ON sharepoint_drive_watches (next_reconcile_at, tenant_id, id)
      WHERE subscription_status <> 'ABSENT'
         OR baseline_status <> 'COMPLETE'
         OR sync_command_pending
    `);

    await queryRunner.query(`
      CREATE TABLE sharepoint_binding_scopes (
        tenant_id varchar(180) NOT NULL,
        binding_id uuid NOT NULL,
        watch_id uuid NOT NULL,
        site_id varchar(512) NOT NULL,
        drive_id varchar(512) NOT NULL,
        folder_id varchar(512) NOT NULL,
        include_subfolders boolean NOT NULL,
        binding_generation bigint NOT NULL,
        drain_barrier_cursor_ciphertext bytea,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, binding_id),
        CONSTRAINT sharepoint_binding_scopes_binding_fk
          FOREIGN KEY (tenant_id, binding_id)
          REFERENCES connector_provisioning_bindings (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sharepoint_binding_scopes_watch_fk
          FOREIGN KEY (tenant_id, watch_id)
          REFERENCES sharepoint_drive_watches (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sharepoint_binding_scopes_generation_check
          CHECK (binding_generation > 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX sharepoint_binding_scopes_watch_idx
      ON sharepoint_binding_scopes (tenant_id, watch_id, folder_id, binding_id)
    `);

    await queryRunner.query(`
      CREATE TABLE sharepoint_drive_items (
        tenant_id varchar(180) NOT NULL,
        watch_id uuid NOT NULL,
        item_id varchar(512) NOT NULL,
        parent_item_id varchar(512),
        item_kind varchar(16) NOT NULL,
        name varchar(512),
        content_type varchar(255),
        size_bytes bigint,
        c_tag varchar(512),
        e_tag varchar(512),
        last_observed_generation bigint NOT NULL,
        observed_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, watch_id, item_id),
        CONSTRAINT sharepoint_drive_items_watch_fk
          FOREIGN KEY (tenant_id, watch_id)
          REFERENCES sharepoint_drive_watches (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sharepoint_drive_items_kind_check
          CHECK (item_kind IN ('FILE', 'FOLDER', 'DELETED')),
        CONSTRAINT sharepoint_drive_items_generation_check
          CHECK (last_observed_generation >= 0),
        CONSTRAINT sharepoint_drive_items_size_check
          CHECK (size_bytes IS NULL OR size_bytes >= 0),
        CONSTRAINT sharepoint_drive_items_file_check
          CHECK (
            item_kind <> 'FILE'
            OR (
              name IS NOT NULL
              AND size_bytes IS NOT NULL
              AND (c_tag IS NOT NULL OR e_tag IS NOT NULL)
            )
          )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX sharepoint_drive_items_parent_idx
      ON sharepoint_drive_items (
        tenant_id,
        watch_id,
        parent_item_id,
        item_id
      )
    `);

    await queryRunner.query(`
      CREATE TABLE sharepoint_notification_events (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        watch_id uuid NOT NULL,
        event_key_hash varchar(64) NOT NULL,
        body_sha256 varchar(64) NOT NULL,
        notification_kind varchar(32) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT sharepoint_notification_events_unique
          UNIQUE (tenant_id, watch_id, event_key_hash),
        CONSTRAINT sharepoint_notification_events_watch_fk
          FOREIGN KEY (tenant_id, watch_id)
          REFERENCES sharepoint_drive_watches (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT sharepoint_notification_events_hashes_check
          CHECK (
            event_key_hash ~ '^[a-f0-9]{64}$'
            AND body_sha256 ~ '^[a-f0-9]{64}$'
          ),
        CONSTRAINT sharepoint_notification_events_kind_check
          CHECK (
            notification_kind IN ('CHANGE', 'REAUTHORIZATION_REQUIRED')
          ),
        CONSTRAINT sharepoint_notification_events_expiry_check
          CHECK (expires_at > received_at)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX sharepoint_notification_events_expiry_idx
      ON sharepoint_notification_events (expires_at, id)
    `);

    await queryRunner.query(`
      CREATE TABLE document_ingestions (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        connector_provisioning_binding_id uuid NOT NULL,
        watch_id uuid NOT NULL,
        workflow_id uuid NOT NULL,
        workflow_version_id uuid NOT NULL,
        connector_id varchar(180) NOT NULL,
        drive_id varchar(512) NOT NULL,
        item_id varchar(512) NOT NULL,
        source_version_kind varchar(16) NOT NULL,
        source_version varchar(512) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'PENDING',
        state_version bigint NOT NULL DEFAULT 0,
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        lease_owner varchar(180),
        lease_expires_at timestamptz,
        storage_object_id uuid,
        document_id uuid,
        execution_id uuid,
        failure_code varchar(180),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        CONSTRAINT document_ingestions_tenant_id_id_unique
          UNIQUE (tenant_id, id),
        CONSTRAINT document_ingestions_source_unique
          UNIQUE (
            tenant_id,
            connector_provisioning_binding_id,
            drive_id,
            item_id,
            source_version_kind,
            source_version
          ),
        CONSTRAINT document_ingestions_binding_fk
          FOREIGN KEY (tenant_id, connector_provisioning_binding_id)
          REFERENCES connector_provisioning_bindings (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT document_ingestions_item_fk
          FOREIGN KEY (tenant_id, watch_id, item_id)
          REFERENCES sharepoint_drive_items (tenant_id, watch_id, item_id)
          ON DELETE RESTRICT,
        CONSTRAINT document_ingestions_workflow_version_fk
          FOREIGN KEY (tenant_id, workflow_id, workflow_version_id)
          REFERENCES workflow_versions (tenant_id, workflow_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT document_ingestions_storage_fk
          FOREIGN KEY (tenant_id, storage_object_id)
          REFERENCES storage_objects (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT document_ingestions_document_fk
          FOREIGN KEY (tenant_id, document_id)
          REFERENCES documents (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT document_ingestions_execution_fk
          FOREIGN KEY (tenant_id, execution_id)
          REFERENCES executions (tenant_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT document_ingestions_source_version_check
          CHECK (source_version_kind IN ('CTAG', 'ETAG')),
        CONSTRAINT document_ingestions_status_check
          CHECK (
            status IN (
              'PENDING',
              'RUNNING',
              'WAITING_RETRY',
              'SUCCEEDED',
              'SKIPPED',
              'FAILED'
            )
          ),
        CONSTRAINT document_ingestions_state_check
          CHECK (state_version >= 0 AND attempt_count >= 0),
        CONSTRAINT document_ingestions_lease_check
          CHECK (
            (status = 'RUNNING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
            OR (
              status <> 'RUNNING'
              AND lease_owner IS NULL
              AND lease_expires_at IS NULL
            )
          ),
        CONSTRAINT document_ingestions_completion_check
          CHECK (
            (
              status = 'SUCCEEDED'
              AND storage_object_id IS NOT NULL
              AND document_id IS NOT NULL
              AND execution_id IS NOT NULL
              AND completed_at IS NOT NULL
            )
            OR (
              status IN ('SKIPPED', 'FAILED')
              AND document_id IS NULL
              AND execution_id IS NULL
              AND completed_at IS NOT NULL
            )
            OR (
              status IN ('PENDING', 'RUNNING', 'WAITING_RETRY')
              AND document_id IS NULL
              AND execution_id IS NULL
              AND completed_at IS NULL
            )
          )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX document_ingestions_due_idx
      ON document_ingestions (next_attempt_at, tenant_id, id)
      WHERE status IN ('PENDING', 'WAITING_RETRY')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS document_ingestions');
    await queryRunner.query(
      'DROP TABLE IF EXISTS sharepoint_notification_events',
    );
    await queryRunner.query('DROP TABLE IF EXISTS sharepoint_drive_items');
    await queryRunner.query('DROP TABLE IF EXISTS sharepoint_binding_scopes');
    await queryRunner.query('DROP TABLE IF EXISTS sharepoint_drive_watches');
    await queryRunner.query(
      'DROP TABLE IF EXISTS connector_provisioning_bindings',
    );
  }
}
