import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UploadSessionParts1784678400000 implements MigrationInterface {
  readonly name = 'UploadSessionParts1784678400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE upload_session_parts (
        tenant_id varchar(180) NOT NULL,
        upload_session_id uuid NOT NULL,
        part_number integer NOT NULL,
        size_bytes bigint NOT NULL,
        checksum_algorithm varchar(32) NOT NULL,
        checksum_value varchar(256) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id, upload_session_id, part_number),
        CONSTRAINT upload_session_parts_session_fk
          FOREIGN KEY (tenant_id, upload_session_id)
          REFERENCES upload_sessions (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT upload_session_parts_number_check
          CHECK (part_number BETWEEN 1 AND 10000),
        CONSTRAINT upload_session_parts_size_check CHECK (size_bytes > 0),
        CONSTRAINT upload_session_parts_checksum_check
          CHECK (checksum_algorithm = 'SHA256')
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS upload_session_parts');
  }
}
