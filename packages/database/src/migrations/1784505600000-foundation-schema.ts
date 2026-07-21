import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FoundationSchema1784505600000 implements MigrationInterface {
  readonly name = 'FoundationSchema1784505600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE connections (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        connector_id varchar(180) NOT NULL,
        display_name varchar(180) NOT NULL,
        configuration_schema_version integer NOT NULL,
        configuration jsonb NOT NULL,
        secret_reference varchar(512),
        status varchar(32) NOT NULL,
        health varchar(32) NOT NULL,
        state_version bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT connections_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT connections_status_check CHECK (status IN ('ACTIVE', 'DISABLED', 'REVOKED')),
        CONSTRAINT connections_health_check CHECK (health IN ('HEALTHY', 'DEGRADED', 'UNKNOWN')),
        CONSTRAINT connections_schema_version_check CHECK (configuration_schema_version > 0),
        CONSTRAINT connections_configuration_object_check CHECK (jsonb_typeof(configuration) = 'object')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE workflows (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        name varchar(180) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'INACTIVE',
        active_version_id uuid,
        accepting_new_documents boolean NOT NULL DEFAULT false,
        cleanup_required boolean NOT NULL DEFAULT false,
        health varchar(32) NOT NULL DEFAULT 'UNKNOWN',
        state_version bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        archived_at timestamptz,
        CONSTRAINT workflows_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT workflows_status_check CHECK (status IN ('INACTIVE', 'ACTIVE', 'ARCHIVED')),
        CONSTRAINT workflows_health_check CHECK (health IN ('HEALTHY', 'DEGRADED', 'UNKNOWN')),
        CONSTRAINT workflows_activation_consistency_check CHECK (
          (status = 'ACTIVE' AND active_version_id IS NOT NULL AND accepting_new_documents)
          OR (status <> 'ACTIVE' AND active_version_id IS NULL AND NOT accepting_new_documents)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE workflow_versions (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        workflow_id uuid NOT NULL,
        version_number integer NOT NULL,
        definition_schema_version integer NOT NULL,
        definition jsonb NOT NULL,
        definition_hash varchar(128) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'VALID',
        created_by_actor_type varchar(16) NOT NULL,
        created_by_actor_id varchar(180) NOT NULL,
        correlation_id varchar(180) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT workflow_versions_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT workflow_versions_workflow_id_id_unique UNIQUE (tenant_id, workflow_id, id),
        CONSTRAINT workflow_versions_number_unique UNIQUE (tenant_id, workflow_id, version_number),
        CONSTRAINT workflow_versions_workflow_fk FOREIGN KEY (tenant_id, workflow_id)
          REFERENCES workflows (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT workflow_versions_status_check CHECK (status = 'VALID'),
        CONSTRAINT workflow_versions_actor_type_check CHECK (created_by_actor_type IN ('USER', 'SERVICE', 'SYSTEM')),
        CONSTRAINT workflow_versions_version_check CHECK (version_number > 0 AND definition_schema_version > 0),
        CONSTRAINT workflow_versions_definition_object_check CHECK (jsonb_typeof(definition) = 'object')
      )
    `);

    await queryRunner.query(`
      ALTER TABLE workflows
      ADD CONSTRAINT workflows_active_version_fk
      FOREIGN KEY (tenant_id, id, active_version_id)
      REFERENCES workflow_versions (tenant_id, workflow_id, id)
      ON DELETE RESTRICT
    `);

    await queryRunner.query(`
      CREATE TABLE workflow_version_connection_refs (
        tenant_id varchar(180) NOT NULL,
        workflow_version_id uuid NOT NULL,
        connection_id uuid NOT NULL,
        purpose varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, workflow_version_id, connection_id, purpose),
        CONSTRAINT workflow_version_connection_refs_version_fk FOREIGN KEY (tenant_id, workflow_version_id)
          REFERENCES workflow_versions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT workflow_version_connection_refs_connection_fk FOREIGN KEY (tenant_id, connection_id)
          REFERENCES connections (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT workflow_version_connection_refs_purpose_check CHECK (purpose IN ('ENTRY', 'DESTINATION'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE workflow_version_profile_refs (
        tenant_id varchar(180) NOT NULL,
        workflow_version_id uuid NOT NULL,
        profile_id varchar(180) NOT NULL,
        profile_version_id varchar(180) NOT NULL,
        profile_kind varchar(32) NOT NULL,
        output_schema_hash varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, workflow_version_id),
        CONSTRAINT workflow_version_profile_refs_version_fk FOREIGN KEY (tenant_id, workflow_version_id)
          REFERENCES workflow_versions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT workflow_version_profile_refs_kind_check CHECK (profile_kind IN ('SYSTEM', 'CUSTOM'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE workflow_activation_operations (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        workflow_id uuid NOT NULL,
        target_version_id uuid,
        previous_version_id uuid,
        kind varchar(16) NOT NULL,
        status varchar(32) NOT NULL,
        current_step varchar(32) NOT NULL,
        definition_hash varchar(128),
        capability_set_hash varchar(128),
        state_version bigint NOT NULL DEFAULT 0,
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        lease_owner varchar(180),
        lease_expires_at timestamptz,
        reconciliation_deadline_at timestamptz,
        failure_code varchar(180),
        failure_category varchar(32),
        actor_type varchar(16) NOT NULL,
        actor_id varchar(180) NOT NULL,
        correlation_id varchar(180) NOT NULL,
        causation_id varchar(180) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        CONSTRAINT workflow_activation_operations_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT workflow_activation_operations_workflow_fk FOREIGN KEY (tenant_id, workflow_id)
          REFERENCES workflows (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT workflow_activation_operations_target_fk FOREIGN KEY (tenant_id, target_version_id)
          REFERENCES workflow_versions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT workflow_activation_operations_previous_fk FOREIGN KEY (tenant_id, previous_version_id)
          REFERENCES workflow_versions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT workflow_activation_operations_kind_check CHECK (kind IN ('ACTIVATE', 'DEACTIVATE')),
        CONSTRAINT workflow_activation_operations_status_check CHECK (status IN ('PENDING', 'RUNNING', 'WAITING_RETRY', 'RECONCILING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT workflow_activation_operations_step_check CHECK (current_step IN ('VALIDATE', 'PROVISION', 'SWITCH', 'DEPROVISION', 'RECONCILE')),
        CONSTRAINT workflow_activation_operations_failure_category_check CHECK (failure_category IS NULL OR failure_category IN ('TRANSIENT', 'PERMANENT', 'UNKNOWN_OUTCOME', 'POLICY')),
        CONSTRAINT workflow_activation_operations_actor_type_check CHECK (actor_type IN ('USER', 'SERVICE', 'SYSTEM')),
        CONSTRAINT workflow_activation_operations_attempt_check CHECK (attempt_count >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX workflow_activation_operations_one_active_idx
      ON workflow_activation_operations (tenant_id, workflow_id)
      WHERE status IN ('PENDING', 'RUNNING', 'WAITING_RETRY', 'RECONCILING')
    `);

    await queryRunner.query(`
      CREATE TABLE storage_objects (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        kind varchar(32) NOT NULL,
        status varchar(32) NOT NULL,
        state_version bigint NOT NULL DEFAULT 0,
        location_alias varchar(64) NOT NULL,
        object_key varchar(512) NOT NULL,
        version_id varchar(512),
        size_bytes bigint,
        content_type varchar(255),
        checksum_algorithm varchar(32),
        checksum_type varchar(32),
        checksum_value varchar(256),
        encryption_mode varchar(64),
        encryption_key_ref varchar(512),
        retention_until timestamptz NOT NULL,
        reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        available_at timestamptz,
        deleted_at timestamptz,
        failure_code varchar(180),
        delete_attempt_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT storage_objects_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT storage_objects_location_key_unique UNIQUE (location_alias, object_key),
        CONSTRAINT storage_objects_kind_check CHECK (kind IN ('SOURCE_DOCUMENT', 'EXTRACTION_RESULT', 'MAPPING_RESULT', 'REVIEW_ARTIFACT', 'DELIVERY_ARTIFACT')),
        CONSTRAINT storage_objects_status_check CHECK (status IN ('RESERVED', 'AVAILABLE', 'DELETE_PENDING', 'DELETED', 'ABANDONED')),
        CONSTRAINT storage_objects_checksum_algorithm_check CHECK (checksum_algorithm IS NULL OR checksum_algorithm = 'SHA256'),
        CONSTRAINT storage_objects_checksum_type_check CHECK (checksum_type IS NULL OR checksum_type IN ('FULL_OBJECT', 'COMPOSITE')),
        CONSTRAINT storage_objects_size_check CHECK (size_bytes IS NULL OR size_bytes >= 0),
        CONSTRAINT storage_objects_available_fields_check CHECK (
          status <> 'AVAILABLE'
          OR (version_id IS NOT NULL AND size_bytes IS NOT NULL AND content_type IS NOT NULL
              AND checksum_algorithm IS NOT NULL AND checksum_type IS NOT NULL
              AND checksum_value IS NOT NULL AND encryption_mode IS NOT NULL AND available_at IS NOT NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE documents (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        source_connector_id varchar(180) NOT NULL,
        source_identity varchar(512) NOT NULL,
        source_version varchar(512) NOT NULL,
        source_storage_object_id uuid NOT NULL,
        size_bytes bigint NOT NULL,
        content_type varchar(255) NOT NULL,
        checksum_algorithm varchar(32) NOT NULL,
        checksum_value varchar(256) NOT NULL,
        original_filename varchar(512),
        staged_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT documents_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT documents_source_unique UNIQUE (tenant_id, source_connector_id, source_identity, source_version),
        CONSTRAINT documents_storage_unique UNIQUE (tenant_id, source_storage_object_id),
        CONSTRAINT documents_storage_fk FOREIGN KEY (tenant_id, source_storage_object_id)
          REFERENCES storage_objects (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT documents_size_check CHECK (size_bytes >= 0),
        CONSTRAINT documents_checksum_algorithm_check CHECK (checksum_algorithm = 'SHA256')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE executions (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        workflow_id uuid NOT NULL,
        workflow_version_id uuid NOT NULL,
        document_id uuid NOT NULL,
        root_execution_id uuid NOT NULL,
        retry_of_execution_id uuid,
        status varchar(32) NOT NULL,
        current_stage varchar(16) NOT NULL,
        state_version bigint NOT NULL DEFAULT 0,
        failure_code varchar(180),
        failure_category varchar(32),
        failure_message varchar(512),
        actor_type varchar(16) NOT NULL,
        actor_id varchar(180) NOT NULL,
        correlation_id varchar(180) NOT NULL,
        causation_id varchar(180) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        started_at timestamptz,
        transitioned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        CONSTRAINT executions_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT executions_retry_parent_unique UNIQUE (tenant_id, retry_of_execution_id),
        CONSTRAINT executions_workflow_fk FOREIGN KEY (tenant_id, workflow_id)
          REFERENCES workflows (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT executions_workflow_version_fk FOREIGN KEY (tenant_id, workflow_version_id)
          REFERENCES workflow_versions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT executions_document_fk FOREIGN KEY (tenant_id, document_id)
          REFERENCES documents (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT executions_root_fk FOREIGN KEY (tenant_id, root_execution_id)
          REFERENCES executions (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT executions_retry_parent_fk FOREIGN KEY (tenant_id, retry_of_execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT executions_status_check CHECK (status IN ('QUEUED', 'EXTRACTING', 'MAPPING', 'AWAITING_REVIEW', 'DELIVERING', 'SUCCEEDED', 'FAILED', 'REJECTED')),
        CONSTRAINT executions_stage_check CHECK (current_stage IN ('EXTRACT', 'MAP', 'REVIEW', 'DELIVER')),
        CONSTRAINT executions_failure_category_check CHECK (failure_category IS NULL OR failure_category IN ('TRANSIENT', 'PERMANENT', 'UNKNOWN_OUTCOME', 'POLICY')),
        CONSTRAINT executions_actor_type_check CHECK (actor_type IN ('USER', 'SERVICE', 'SYSTEM')),
        CONSTRAINT executions_terminal_time_check CHECK ((status IN ('SUCCEEDED', 'FAILED', 'REJECTED')) = (completed_at IS NOT NULL))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX executions_one_active_root_idx
      ON executions (tenant_id, root_execution_id)
      WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'REJECTED')
    `);

    await queryRunner.query(`
      CREATE TABLE execution_stages (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        execution_id uuid NOT NULL,
        stage varchar(16) NOT NULL,
        status varchar(32) NOT NULL,
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        lease_owner varchar(180),
        lease_expires_at timestamptz,
        failure_code varchar(180),
        failure_category varchar(32),
        state_version bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT execution_stages_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT execution_stages_execution_stage_unique UNIQUE (tenant_id, execution_id, stage),
        CONSTRAINT execution_stages_execution_fk FOREIGN KEY (tenant_id, execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT execution_stages_stage_check CHECK (stage IN ('EXTRACT', 'MAP', 'REVIEW', 'DELIVER')),
        CONSTRAINT execution_stages_status_check CHECK (status IN ('PENDING', 'RUNNING', 'WAITING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
        CONSTRAINT execution_stages_failure_category_check CHECK (failure_category IS NULL OR failure_category IN ('TRANSIENT', 'PERMANENT', 'UNKNOWN_OUTCOME', 'POLICY')),
        CONSTRAINT execution_stages_attempt_count_check CHECK (attempt_count >= 0),
        CONSTRAINT execution_stages_lease_check CHECK (
          (status = 'RUNNING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR (status <> 'RUNNING' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE stage_attempts (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        execution_id uuid NOT NULL,
        execution_stage_id uuid NOT NULL,
        stage varchar(16) NOT NULL,
        attempt_number integer NOT NULL,
        status varchar(16) NOT NULL,
        lease_owner varchar(180) NOT NULL,
        lease_expires_at timestamptz NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        failure_code varchar(180),
        failure_category varchar(32),
        output_storage_object_id uuid,
        output_schema_version integer,
        CONSTRAINT stage_attempts_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT stage_attempts_number_unique UNIQUE (tenant_id, execution_id, stage, attempt_number),
        CONSTRAINT stage_attempts_execution_fk FOREIGN KEY (tenant_id, execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT stage_attempts_stage_fk FOREIGN KEY (tenant_id, execution_stage_id)
          REFERENCES execution_stages (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT stage_attempts_output_fk FOREIGN KEY (tenant_id, output_storage_object_id)
          REFERENCES storage_objects (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT stage_attempts_stage_check CHECK (stage IN ('EXTRACT', 'MAP', 'REVIEW', 'DELIVER')),
        CONSTRAINT stage_attempts_status_check CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT')),
        CONSTRAINT stage_attempts_failure_category_check CHECK (failure_category IS NULL OR failure_category IN ('TRANSIENT', 'PERMANENT', 'UNKNOWN_OUTCOME', 'POLICY')),
        CONSTRAINT stage_attempts_number_check CHECK (attempt_number > 0),
        CONSTRAINT stage_attempts_terminal_time_check CHECK ((status = 'RUNNING') = (finished_at IS NULL))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE idempotency_records (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        operation_scope varchar(180) NOT NULL,
        idempotency_key varchar(256) NOT NULL,
        request_fingerprint varchar(128) NOT NULL,
        status varchar(16) NOT NULL,
        resource_type varchar(64),
        resource_id varchar(180),
        response jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        expires_at timestamptz NOT NULL,
        CONSTRAINT idempotency_records_unique UNIQUE (tenant_id, operation_scope, idempotency_key),
        CONSTRAINT idempotency_records_status_check CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT idempotency_records_completion_check CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        message_id varchar(180) NOT NULL UNIQUE,
        message_type varchar(180) NOT NULL,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        aggregate_type varchar(64) NOT NULL,
        aggregate_id varchar(180) NOT NULL,
        envelope jsonb NOT NULL,
        available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        publish_lease_owner varchar(180),
        publish_lease_expires_at timestamptz,
        publish_attempt_count integer NOT NULL DEFAULT 0,
        published_at timestamptz,
        last_error_code varchar(180),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT outbox_messages_envelope_object_check CHECK (jsonb_typeof(envelope) = 'object'),
        CONSTRAINT outbox_messages_attempt_check CHECK (publish_attempt_count >= 0),
        CONSTRAINT outbox_messages_lease_check CHECK (
          (publish_lease_owner IS NULL AND publish_lease_expires_at IS NULL)
          OR (publish_lease_owner IS NOT NULL AND publish_lease_expires_at IS NOT NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        id uuid PRIMARY KEY,
        consumer_name varchar(180) NOT NULL,
        message_id varchar(180) NOT NULL,
        message_type varchar(180) NOT NULL,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        target_type varchar(64),
        target_id varchar(180),
        outcome varchar(16) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT inbox_messages_unique UNIQUE (consumer_name, message_id),
        CONSTRAINT inbox_messages_outcome_check CHECK (outcome IN ('CLAIMED', 'DUPLICATE', 'STALE', 'REJECTED'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE audit_events (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180),
        actor_type varchar(16) NOT NULL,
        actor_id varchar(180) NOT NULL,
        action varchar(180) NOT NULL,
        resource_type varchar(64) NOT NULL,
        resource_id varchar(180) NOT NULL,
        outcome varchar(32) NOT NULL,
        error_code varchar(180),
        correlation_id varchar(180) NOT NULL,
        causation_id varchar(180) NOT NULL,
        workflow_version_id uuid,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN ('USER', 'SERVICE', 'SYSTEM')),
        CONSTRAINT audit_events_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE scheduler_leases (
        job_name varchar(180) PRIMARY KEY,
        lease_owner varchar(180) NOT NULL,
        lease_expires_at timestamptz NOT NULL,
        fencing_version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT scheduler_leases_fencing_check CHECK (fencing_version > 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX workflows_project_list_idx
      ON workflows (tenant_id, project_id, created_at, id)
    `);
    await queryRunner.query(`
      CREATE INDEX workflow_versions_history_idx
      ON workflow_versions (tenant_id, workflow_id, version_number)
    `);
    await queryRunner.query(`
      CREATE INDEX workflow_activation_operations_due_idx
      ON workflow_activation_operations (next_attempt_at, id)
      WHERE status IN ('WAITING_RETRY', 'RECONCILING')
    `);
    await queryRunner.query(`
      CREATE INDEX workflow_activation_operations_lease_idx
      ON workflow_activation_operations (lease_expires_at, id)
      WHERE status = 'RUNNING'
    `);
    await queryRunner.query(`
      CREATE INDEX storage_objects_retention_idx
      ON storage_objects (retention_until, id)
      WHERE status IN ('RESERVED', 'AVAILABLE', 'DELETE_PENDING')
    `);
    await queryRunner.query(`
      CREATE INDEX executions_workflow_list_idx
      ON executions (tenant_id, workflow_id, created_at, id)
    `);
    await queryRunner.query(`
      CREATE INDEX execution_stages_retry_idx
      ON execution_stages (next_attempt_at, execution_id)
      WHERE status IN ('RETRY_SCHEDULED', 'WAITING')
    `);
    await queryRunner.query(`
      CREATE INDEX execution_stages_lease_idx
      ON execution_stages (lease_expires_at, execution_id)
      WHERE status = 'RUNNING'
    `);
    await queryRunner.query(`
      CREATE INDEX outbox_messages_unpublished_idx
      ON outbox_messages (available_at, id)
      WHERE published_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX audit_events_resource_idx
      ON audit_events (tenant_id, resource_type, resource_id, occurred_at, id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS scheduler_leases');
    await queryRunner.query('DROP TABLE IF EXISTS audit_events');
    await queryRunner.query('DROP TABLE IF EXISTS inbox_messages');
    await queryRunner.query('DROP TABLE IF EXISTS outbox_messages');
    await queryRunner.query('DROP TABLE IF EXISTS idempotency_records');
    await queryRunner.query('DROP TABLE IF EXISTS stage_attempts');
    await queryRunner.query('DROP TABLE IF EXISTS execution_stages');
    await queryRunner.query('DROP TABLE IF EXISTS executions');
    await queryRunner.query('DROP TABLE IF EXISTS documents');
    await queryRunner.query('DROP TABLE IF EXISTS storage_objects');
    await queryRunner.query(
      'DROP TABLE IF EXISTS workflow_activation_operations',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS workflow_version_profile_refs',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS workflow_version_connection_refs',
    );
    await queryRunner.query(
      'ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_active_version_fk',
    );
    await queryRunner.query('DROP TABLE IF EXISTS workflow_versions');
    await queryRunner.query('DROP TABLE IF EXISTS workflows');
    await queryRunner.query('DROP TABLE IF EXISTS connections');
  }
}
