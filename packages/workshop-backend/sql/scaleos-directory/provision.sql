-- ScaleOS Directory: Provisioning Script (#28)
--
-- Configures reader binding and database grants for scaleos_directory.
--
-- Uso:
--   psql "$ADMIN_DATABASE_URL" -v TARGET_ORG_ID="<org-id>" -f provision.sql
--

\set ON_ERROR_STOP on

\if :{?TARGET_ORG_ID}
\else
  \warn 'ERRO: TARGET_ORG_ID deve ser definido explicitamente, por exemplo:'
  \warn 'psql "$ADMIN_DATABASE_URL" -v TARGET_ORG_ID="<org-id>" -f provision.sql'
  DO $abort$ BEGIN RAISE EXCEPTION 'TARGET_ORG_ID é obrigatório'; END $abort$;
\endif

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Initialize Group Version Clock (starts at 0)
-- -----------------------------------------------------------------------------

INSERT INTO scaleos_directory.group_versions (org_id, version)
VALUES (:'TARGET_ORG_ID', 0)
ON CONFLICT (org_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Reader Binding for vault_app
-- -----------------------------------------------------------------------------
-- Explicit provisioning never remaps an existing binding to a different org.

DO $binding$
DECLARE
    v_existing text;
    v_target text := :'TARGET_ORG_ID';
BEGIN
    SELECT org_id INTO v_existing
    FROM scaleos_directory.reader_bindings
    WHERE login_role = 'vault_app';

    IF v_existing IS NOT NULL AND v_existing <> v_target THEN
        RAISE EXCEPTION 'CONFLICT: reader_binding para vault_app já configurado com org_id % diferente do alvo %', v_existing, v_target;
    END IF;

    INSERT INTO scaleos_directory.reader_bindings (login_role, org_id)
    VALUES ('vault_app', v_target)
    ON CONFLICT (login_role) DO NOTHING;
END $binding$;

-- -----------------------------------------------------------------------------
-- 3. Security: Revoke Public and Unprivileged Access
-- -----------------------------------------------------------------------------

REVOKE ALL ON SCHEMA scaleos_directory FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA scaleos_directory FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA scaleos_directory FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA scaleos_directory FROM PUBLIC, anon, authenticated;

-- Ensure vault_app has no table or DML permissions
REVOKE ALL ON ALL TABLES IN SCHEMA scaleos_directory FROM vault_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA scaleos_directory FROM vault_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA scaleos_directory FROM vault_app;

-- -----------------------------------------------------------------------------
-- 4. Grants for OS Backend (service_role)
-- -----------------------------------------------------------------------------
-- service_role is the trusted backend identity executing mutations and reads

GRANT USAGE ON SCHEMA scaleos_directory TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scaleos_directory TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA scaleos_directory TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Grants for Vault Reader (vault_app)
-- -----------------------------------------------------------------------------
-- vault_app has only USAGE and EXECUTE on its designated reader functions.
-- No DML, no direct SELECT on tables, no SELECT on auth.users.

GRANT USAGE ON SCHEMA scaleos_directory TO vault_app;
GRANT EXECUTE ON FUNCTION scaleos_directory.get_reader_binding() TO vault_app;
GRANT EXECUTE ON FUNCTION scaleos_directory.list_invitable_groups() TO vault_app;
GRANT EXECUTE ON FUNCTION scaleos_directory.get_group_invitation_snapshot(uuid) TO vault_app;

-- -----------------------------------------------------------------------------
-- 6. Post-Provisioning Verification
-- -----------------------------------------------------------------------------

DO $verify$
DECLARE
    v_has_table_priv boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.table_privileges
        WHERE table_schema = 'scaleos_directory'
          AND grantee = 'vault_app'
    ) INTO v_has_table_priv;

    IF v_has_table_priv THEN
        RAISE EXCEPTION 'Falha de segurança: vault_app possui privilégios diretos em tabelas de scaleos_directory';
    END IF;
END $verify$;

COMMIT;
