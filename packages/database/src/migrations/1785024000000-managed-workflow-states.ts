import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ManagedWorkflowStates1785024000000 implements MigrationInterface {
  readonly name = 'ManagedWorkflowStates1785024000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE workflows
      DROP CONSTRAINT workflows_activation_consistency_check,
      ADD CONSTRAINT workflows_activation_consistency_check CHECK (
        (
          status = 'ACTIVE'
          AND active_version_id IS NOT NULL
          AND NOT cleanup_required
          AND (accepting_new_documents OR health = 'DEGRADED')
        )
        OR (
          status = 'INACTIVE'
          AND NOT accepting_new_documents
          AND (
            (cleanup_required AND active_version_id IS NOT NULL)
            OR (NOT cleanup_required AND active_version_id IS NULL)
          )
        )
        OR (
          status = 'ARCHIVED'
          AND active_version_id IS NULL
          AND NOT accepting_new_documents
          AND NOT cleanup_required
        )
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE workflows
      DROP CONSTRAINT workflows_activation_consistency_check,
      ADD CONSTRAINT workflows_activation_consistency_check CHECK (
        (
          status = 'ACTIVE'
          AND active_version_id IS NOT NULL
          AND accepting_new_documents
        )
        OR (
          status <> 'ACTIVE'
          AND active_version_id IS NULL
          AND NOT accepting_new_documents
        )
      )
    `);
  }
}
