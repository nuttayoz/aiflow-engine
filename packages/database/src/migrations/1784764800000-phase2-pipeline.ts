import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase2Pipeline1784764800000 implements MigrationInterface {
  readonly name = 'Phase2Pipeline1784764800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE documents
      ADD COLUMN content_sha256 varchar(64),
      ADD COLUMN content_sha256_verified_at timestamptz,
      ADD CONSTRAINT documents_content_sha256_check CHECK (
        content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'
      ),
      ADD CONSTRAINT documents_content_verification_check CHECK (
        content_sha256_verified_at IS NULL OR content_sha256 IS NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE processing_artifacts (
        tenant_id varchar(180) NOT NULL,
        execution_id uuid NOT NULL,
        stage varchar(16) NOT NULL,
        storage_object_id uuid NOT NULL,
        schema_version integer NOT NULL,
        payload_sha256 varchar(64),
        status varchar(16) NOT NULL DEFAULT 'RESERVED',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, execution_id, stage),
        CONSTRAINT processing_artifacts_storage_unique UNIQUE (tenant_id, storage_object_id),
        CONSTRAINT processing_artifacts_execution_fk FOREIGN KEY (tenant_id, execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT processing_artifacts_storage_fk FOREIGN KEY (tenant_id, storage_object_id)
          REFERENCES storage_objects (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT processing_artifacts_stage_check CHECK (stage IN ('EXTRACT', 'MAP')),
        CONSTRAINT processing_artifacts_status_check CHECK (status IN ('RESERVED', 'AVAILABLE')),
        CONSTRAINT processing_artifacts_schema_check CHECK (schema_version > 0),
        CONSTRAINT processing_artifacts_payload_hash_check CHECK (
          payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$'
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE extraction_requests (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        execution_id uuid NOT NULL,
        stage_attempt_id uuid NOT NULL,
        profile_id varchar(180) NOT NULL,
        profile_version_id varchar(180) NOT NULL,
        adapter_id varchar(180) NOT NULL,
        callback_correlation_id varchar(180) NOT NULL,
        provider_operation_ref varchar(512),
        result_storage_object_id uuid NOT NULL,
        result_schema_version integer NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'SUBMITTING',
        state_version bigint NOT NULL DEFAULT 0,
        next_check_at timestamptz NOT NULL,
        deadline_at timestamptz NOT NULL,
        failure_code varchar(180),
        submitted_at timestamptz,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT extraction_requests_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT extraction_requests_execution_unique UNIQUE (tenant_id, execution_id),
        CONSTRAINT extraction_requests_callback_unique UNIQUE (adapter_id, callback_correlation_id),
        CONSTRAINT extraction_requests_provider_unique UNIQUE (adapter_id, provider_operation_ref),
        CONSTRAINT extraction_requests_execution_fk FOREIGN KEY (tenant_id, execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT extraction_requests_attempt_fk FOREIGN KEY (tenant_id, stage_attempt_id)
          REFERENCES stage_attempts (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT extraction_requests_result_fk FOREIGN KEY (tenant_id, result_storage_object_id)
          REFERENCES storage_objects (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT extraction_requests_status_check CHECK (
          status IN ('SUBMITTING', 'ACCEPTED', 'RESULT_AVAILABLE', 'COMPLETED', 'FAILED')
        ),
        CONSTRAINT extraction_requests_state_version_check CHECK (state_version >= 0),
        CONSTRAINT extraction_requests_schema_check CHECK (result_schema_version > 0),
        CONSTRAINT extraction_requests_deadline_check CHECK (deadline_at > created_at),
        CONSTRAINT extraction_requests_completion_check CHECK (
          (status = 'COMPLETED' AND completed_at IS NOT NULL)
          OR (status <> 'COMPLETED' AND completed_at IS NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX extraction_requests_due_idx
      ON extraction_requests (next_check_at, tenant_id, id)
      WHERE status IN ('SUBMITTING', 'ACCEPTED', 'RESULT_AVAILABLE')
    `);

    await queryRunner.query(`
      CREATE TABLE extraction_callback_events (
        id uuid PRIMARY KEY,
        adapter_id varchar(180) NOT NULL,
        provider_event_id varchar(180) NOT NULL,
        extraction_request_id uuid NOT NULL,
        tenant_id varchar(180) NOT NULL,
        body_sha256 varchar(64) NOT NULL,
        safe_status varchar(32) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT extraction_callback_events_unique UNIQUE (adapter_id, provider_event_id),
        CONSTRAINT extraction_callback_events_request_fk
          FOREIGN KEY (tenant_id, extraction_request_id)
          REFERENCES extraction_requests (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT extraction_callback_events_body_hash_check CHECK (
          body_sha256 ~ '^[a-f0-9]{64}$'
        ),
        CONSTRAINT extraction_callback_events_status_check CHECK (
          safe_status IN ('COMPLETED', 'FAILED')
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE delivery_operations (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        root_execution_id uuid NOT NULL,
        current_execution_id uuid NOT NULL,
        connector_id varchar(180) NOT NULL,
        action_id varchar(180) NOT NULL,
        action_version integer NOT NULL,
        company_resource_id varchar(180) NOT NULL,
        effect_key varchar(180) NOT NULL,
        payload_sha256 varchar(64) NOT NULL,
        input_storage_object_id uuid NOT NULL,
        input_schema_version integer NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'READY',
        state_version bigint NOT NULL DEFAULT 0,
        next_check_at timestamptz,
        reconciliation_deadline_at timestamptz NOT NULL,
        external_resource_type varchar(180),
        external_resource_id varchar(180),
        external_resource_number varchar(180),
        external_version varchar(512),
        applied_at timestamptz,
        failure_code varchar(180),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT delivery_operations_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT delivery_operations_effect_unique UNIQUE (tenant_id, connector_id, effect_key),
        CONSTRAINT delivery_operations_root_action_unique UNIQUE (
          tenant_id, root_execution_id, connector_id, action_id, action_version
        ),
        CONSTRAINT delivery_operations_root_fk FOREIGN KEY (tenant_id, root_execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT delivery_operations_current_fk FOREIGN KEY (tenant_id, current_execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT delivery_operations_input_fk FOREIGN KEY (tenant_id, input_storage_object_id)
          REFERENCES storage_objects (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT delivery_operations_status_check CHECK (
          status IN ('READY', 'SUBMITTING', 'UNKNOWN', 'APPLIED', 'FAILED')
        ),
        CONSTRAINT delivery_operations_state_version_check CHECK (state_version >= 0),
        CONSTRAINT delivery_operations_action_version_check CHECK (action_version > 0),
        CONSTRAINT delivery_operations_schema_check CHECK (input_schema_version > 0),
        CONSTRAINT delivery_operations_payload_hash_check CHECK (
          payload_sha256 ~ '^[a-f0-9]{64}$'
        ),
        CONSTRAINT delivery_operations_deadline_check CHECK (
          reconciliation_deadline_at > created_at
        ),
        CONSTRAINT delivery_operations_applied_check CHECK (
          (status = 'APPLIED' AND external_resource_type IS NOT NULL
            AND external_resource_id IS NOT NULL AND applied_at IS NOT NULL)
          OR (status <> 'APPLIED' AND applied_at IS NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX delivery_operations_due_idx
      ON delivery_operations (next_check_at, tenant_id, id)
      WHERE status IN ('SUBMITTING', 'UNKNOWN')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS delivery_operations');
    await queryRunner.query('DROP TABLE IF EXISTS extraction_callback_events');
    await queryRunner.query('DROP TABLE IF EXISTS extraction_requests');
    await queryRunner.query('DROP TABLE IF EXISTS processing_artifacts');
    await queryRunner.query(`
      ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_content_verification_check,
      DROP CONSTRAINT IF EXISTS documents_content_sha256_check,
      DROP COLUMN IF EXISTS content_sha256_verified_at,
      DROP COLUMN IF EXISTS content_sha256
    `);
  }
}
