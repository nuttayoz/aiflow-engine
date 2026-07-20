\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiflow_migration') THEN
    CREATE ROLE aiflow_migration
      LOGIN
      PASSWORD 'local-migration-only'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiflow_app') THEN
    CREATE ROLE aiflow_app
      LOGIN
      PASSWORD 'local-application-only'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE aiflow TO aiflow_migration, aiflow_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS aiflow AUTHORIZATION aiflow_migration;
ALTER SCHEMA aiflow OWNER TO aiflow_migration;
GRANT USAGE ON SCHEMA aiflow TO aiflow_app;

ALTER ROLE aiflow_migration IN DATABASE aiflow
  SET search_path TO aiflow, public;
ALTER ROLE aiflow_app IN DATABASE aiflow
  SET search_path TO aiflow, public;

ALTER DEFAULT PRIVILEGES FOR ROLE aiflow_migration IN SCHEMA aiflow
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aiflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aiflow_migration IN SCHEMA aiflow
  GRANT USAGE, SELECT ON SEQUENCES TO aiflow_app;
