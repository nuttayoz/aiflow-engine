import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SharePointHardening1784937600000 implements MigrationInterface {
  readonly name = 'SharePointHardening1784937600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sharepoint_drive_watches
      ADD COLUMN inventory_generation bigint NOT NULL DEFAULT 1,
      ADD CONSTRAINT sharepoint_drive_watches_inventory_generation_check
        CHECK (inventory_generation > 0)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sharepoint_drive_watches
      DROP CONSTRAINT IF EXISTS sharepoint_drive_watches_inventory_generation_check,
      DROP COLUMN IF EXISTS inventory_generation
    `);
  }
}
