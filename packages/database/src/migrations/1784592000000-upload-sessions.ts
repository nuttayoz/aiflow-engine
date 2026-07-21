import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UploadSessions1784592000000 implements MigrationInterface {
  readonly name = 'UploadSessions1784592000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE upload_sessions (
        id uuid PRIMARY KEY,
        tenant_id varchar(180) NOT NULL,
        project_id varchar(180) NOT NULL,
        workflow_id uuid NOT NULL,
        workflow_version_id uuid NOT NULL,
        storage_object_id uuid NOT NULL,
        plan_type varchar(32) NOT NULL,
        part_size_bytes bigint,
        part_count integer,
        multipart_upload_reference varchar(1024),
        status varchar(32) NOT NULL DEFAULT 'ACTIVE',
        state_version bigint NOT NULL DEFAULT 0,
        original_filename varchar(512) NOT NULL,
        content_type varchar(255) NOT NULL,
        size_bytes bigint NOT NULL,
        client_checksum_algorithm varchar(32) NOT NULL,
        client_checksum_value varchar(256) NOT NULL,
        document_id uuid,
        execution_id uuid,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        aborted_at timestamptz,
        CONSTRAINT upload_sessions_tenant_id_id_unique UNIQUE (tenant_id, id),
        CONSTRAINT upload_sessions_storage_unique UNIQUE (tenant_id, storage_object_id),
        CONSTRAINT upload_sessions_document_unique UNIQUE (tenant_id, document_id),
        CONSTRAINT upload_sessions_execution_unique UNIQUE (tenant_id, execution_id),
        CONSTRAINT upload_sessions_workflow_version_fk
          FOREIGN KEY (tenant_id, workflow_id, workflow_version_id)
          REFERENCES workflow_versions (tenant_id, workflow_id, id) ON DELETE RESTRICT,
        CONSTRAINT upload_sessions_storage_fk FOREIGN KEY (tenant_id, storage_object_id)
          REFERENCES storage_objects (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT upload_sessions_document_fk FOREIGN KEY (tenant_id, document_id)
          REFERENCES documents (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT upload_sessions_execution_fk FOREIGN KEY (tenant_id, execution_id)
          REFERENCES executions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT upload_sessions_plan_check CHECK (
          (plan_type = 'SINGLE_PUT' AND part_size_bytes IS NULL AND part_count IS NULL
            AND multipart_upload_reference IS NULL)
          OR
          (plan_type = 'MULTIPART' AND part_size_bytes > 0 AND part_count > 1
            AND part_count = ((size_bytes + part_size_bytes - 1) / part_size_bytes))
        ),
        CONSTRAINT upload_sessions_status_check CHECK (
          status IN ('ACTIVE', 'COMPLETED', 'ABORTED', 'EXPIRED')
        ),
        CONSTRAINT upload_sessions_checksum_check CHECK (
          client_checksum_algorithm = 'SHA256'
        ),
        CONSTRAINT upload_sessions_size_check CHECK (size_bytes > 0),
        CONSTRAINT upload_sessions_state_version_check CHECK (state_version >= 0),
        CONSTRAINT upload_sessions_expiry_check CHECK (expires_at > created_at),
        CONSTRAINT upload_sessions_terminal_check CHECK (
          (status = 'ACTIVE' AND document_id IS NULL AND execution_id IS NULL
            AND completed_at IS NULL AND aborted_at IS NULL)
          OR
          (status = 'COMPLETED' AND document_id IS NOT NULL AND execution_id IS NOT NULL
            AND completed_at IS NOT NULL AND aborted_at IS NULL)
          OR
          (status IN ('ABORTED', 'EXPIRED') AND document_id IS NULL AND execution_id IS NULL
            AND completed_at IS NULL AND aborted_at IS NOT NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX upload_sessions_active_tenant_idx
      ON upload_sessions (tenant_id, created_at, id)
      WHERE status = 'ACTIVE'
    `);
    await queryRunner.query(`
      CREATE INDEX upload_sessions_expiry_idx
      ON upload_sessions (expires_at, id)
      WHERE status = 'ACTIVE'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS upload_sessions');
  }
}
