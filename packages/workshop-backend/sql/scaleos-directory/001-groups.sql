-- ScaleOS Directory: Central Groups Schema and Functions (#28)
--
-- Schema scaleos_directory: authoritative relational storage for groups,
-- group memberships, group clocks, idempotent mutation receipts, and audit events.
-- Exposed to the OS backend via PostgREST RPC and to Vault via limited reader functions.

CREATE SCHEMA IF NOT EXISTS scaleos_directory;

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

-- Groups: authoritative group entity per organization.
CREATE TABLE IF NOT EXISTS scaleos_directory.groups (
    org_id text NOT NULL,
    group_id uuid NOT NULL,
    name text NOT NULL,
    name_key text NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT pk_groups PRIMARY KEY (org_id, group_id),
    CONSTRAINT uq_groups_org_name_key UNIQUE (org_id, name_key),
    CONSTRAINT chk_groups_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT chk_groups_revision CHECK (revision > 0)
);

-- Group members: group-to-user membership rows.
CREATE TABLE IF NOT EXISTS scaleos_directory.group_members (
    org_id text NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    CONSTRAINT pk_group_members PRIMARY KEY (org_id, group_id, user_id),
    CONSTRAINT fk_group_members_group FOREIGN KEY (org_id, group_id)
        REFERENCES scaleos_directory.groups (org_id, group_id) ON DELETE CASCADE,
    CONSTRAINT fk_group_members_user FOREIGN KEY (user_id)
        REFERENCES auth.users (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_group_members_org_user_group
    ON scaleos_directory.group_members (org_id, user_id, group_id);

-- Group versions: monotonic central group policy version per organization.
CREATE TABLE IF NOT EXISTS scaleos_directory.group_versions (
    org_id text NOT NULL,
    version bigint NOT NULL DEFAULT 0,
    CONSTRAINT pk_group_versions PRIMARY KEY (org_id),
    CONSTRAINT chk_group_versions_version CHECK (version >= 0)
);

-- Group mutations: idempotent mutation log and receipts.
CREATE TABLE IF NOT EXISTS scaleos_directory.group_mutations (
    org_id text NOT NULL,
    actor_id uuid NOT NULL,
    operation text NOT NULL,
    mutation_id uuid NOT NULL,
    request_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT pk_group_mutations PRIMARY KEY (org_id, actor_id, operation, mutation_id),
    CONSTRAINT chk_group_mutations_operation CHECK (operation IN (
        'createGroup', 'renameGroup', 'replaceGroupMembers', 'deleteGroup'
    ))
);

-- Group audit events: durable local audit events for group administrative actions.
CREATE TABLE IF NOT EXISTS scaleos_directory.group_audit_events (
    org_id text NOT NULL,
    event_id text NOT NULL,
    event jsonb NOT NULL,
    timestamp timestamptz NOT NULL,
    CONSTRAINT pk_group_audit_events PRIMARY KEY (org_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_group_audit_events_org_timestamp
    ON scaleos_directory.group_audit_events (org_id, timestamp DESC, event_id DESC);

-- Reader bindings: binds a database login role (e.g. vault_app) to its assigned org_id.
CREATE TABLE IF NOT EXISTS scaleos_directory.reader_bindings (
    login_role name NOT NULL,
    org_id text NOT NULL,
    CONSTRAINT pk_reader_bindings PRIMARY KEY (login_role)
);

-- -----------------------------------------------------------------------------
-- 2. Vault Reader Functions (derive org_id from session_user via reader_bindings)
-- -----------------------------------------------------------------------------

-- Returns {orgId} derived solely from reader_bindings for the current session_user.
CREATE OR REPLACE FUNCTION scaleos_directory.get_reader_binding()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_org_id text;
BEGIN
    SELECT rb.org_id
    INTO v_org_id
    FROM scaleos_directory.reader_bindings rb
    WHERE rb.login_role = session_user;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    RETURN pg_catalog.jsonb_build_object('orgId', v_org_id);
END;
$$;

-- Lists invitable groups with active member count for the caller's bound organization.
CREATE OR REPLACE FUNCTION scaleos_directory.list_invitable_groups()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_org_id text;
    v_result jsonb;
BEGIN
    SELECT rb.org_id
    INTO v_org_id
    FROM scaleos_directory.reader_bindings rb
    WHERE rb.login_role = session_user;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT coalesce(pg_catalog.jsonb_agg(sub.item), '[]'::jsonb)
    INTO v_result
    FROM (
        SELECT pg_catalog.jsonb_build_object(
            'groupId', g.group_id,
            'name', g.name,
            'memberCount', (
                SELECT count(gm.user_id)
                FROM scaleos_directory.group_members gm
                JOIN auth.users u ON u.id = gm.user_id
                WHERE gm.org_id = v_org_id
                  AND gm.group_id = g.group_id
                  AND u.deleted_at IS NULL
                  AND (u.banned_until IS NULL OR u.banned_until <= pg_catalog.clock_timestamp())
            )
        ) AS item
        FROM scaleos_directory.groups g
        WHERE g.org_id = v_org_id
        ORDER BY g.group_id ASC
    ) sub;

    RETURN v_result;
END;
$$;

-- Returns a complete invitation snapshot for one group in the caller's bound organization.
CREATE OR REPLACE FUNCTION scaleos_directory.get_group_invitation_snapshot(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_org_id text;
    v_group_id uuid;
    v_name text;
    v_revision bigint;
    v_members jsonb;
BEGIN
    SELECT rb.org_id
    INTO v_org_id
    FROM scaleos_directory.reader_bindings rb
    WHERE rb.login_role = session_user;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT g.group_id, g.name, g.revision
    INTO v_group_id, v_name, v_revision
    FROM scaleos_directory.groups g
    WHERE g.org_id = v_org_id AND g.group_id = p_group_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_FOUND';
    END IF;

    SELECT coalesce(pg_catalog.jsonb_agg(m.item ORDER BY m.user_id_text ASC), '[]'::jsonb)
    INTO v_members
    FROM (
        SELECT
            gm.user_id::text AS user_id_text,
            pg_catalog.jsonb_build_object(
                'userId', gm.user_id,
                'email', u.email,
                'displayName', coalesce(
                    nullif(pg_catalog.btrim(u.raw_user_meta_data->>'display_name'), ''),
                    nullif(pg_catalog.btrim(u.raw_user_meta_data->>'full_name'), ''),
                    u.email
                )
            ) AS item
        FROM scaleos_directory.group_members gm
        JOIN auth.users u ON u.id = gm.user_id
        WHERE gm.org_id = v_org_id
          AND gm.group_id = p_group_id
          AND u.deleted_at IS NULL
          AND (u.banned_until IS NULL OR u.banned_until <= pg_catalog.clock_timestamp())
    ) m;

    RETURN pg_catalog.jsonb_build_object(
        'groupId', v_group_id,
        'name', v_name,
        'revision', v_revision,
        'members', v_members
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Backend Read Functions (OS service_role)
-- -----------------------------------------------------------------------------

-- Lists all groups for an organization ordered by name_key and groupId.
CREATE OR REPLACE FUNCTION scaleos_directory.list_groups(p_org_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_result jsonb;
BEGIN
    SELECT coalesce(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'groupId', g.group_id,
                'name', g.name,
                'createdAt', pg_catalog.to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'updatedAt', pg_catalog.to_char(g.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
            ORDER BY g.name_key ASC, g.group_id ASC
        ),
        '[]'::jsonb
    )
    INTO v_result
    FROM scaleos_directory.groups g
    WHERE g.org_id = p_org_id;

    RETURN v_result;
END;
$$;

-- Returns member user IDs for a group; raises NOT_FOUND if group is missing.
CREATE OR REPLACE FUNCTION scaleos_directory.get_group_members(p_org_id text, p_group_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_members uuid[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM scaleos_directory.groups g
        WHERE g.org_id = p_org_id AND g.group_id = p_group_id
    ) THEN
        RAISE EXCEPTION 'NOT_FOUND';
    END IF;

    SELECT coalesce(pg_catalog.array_agg(gm.user_id ORDER BY gm.user_id ASC), ARRAY[]::uuid[])
    INTO v_members
    FROM scaleos_directory.group_members gm
    WHERE gm.org_id = p_org_id AND gm.group_id = p_group_id;

    RETURN v_members;
END;
$$;

-- Resolves which of the requested group IDs the subject is currently a member of.
CREATE OR REPLACE FUNCTION scaleos_directory.resolve_group_memberships(
    p_org_id text,
    p_subject uuid,
    p_group_ids uuid[]
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_result uuid[];
BEGIN
    IF p_group_ids IS NULL OR pg_catalog.array_length(p_group_ids, 1) IS NULL THEN
        RETURN ARRAY[]::uuid[];
    END IF;

    SELECT coalesce(pg_catalog.array_agg(gm.group_id ORDER BY gm.group_id ASC), ARRAY[]::uuid[])
    INTO v_result
    FROM scaleos_directory.group_members gm
    JOIN scaleos_directory.groups g ON g.org_id = gm.org_id AND g.group_id = gm.group_id
    WHERE gm.org_id = p_org_id
      AND gm.user_id = p_subject
      AND gm.group_id = ANY(p_group_ids);

    RETURN v_result;
END;
$$;

-- Filters an array of candidate group IDs to those that exist in the organization.
CREATE OR REPLACE FUNCTION scaleos_directory.existing_group_ids(
    p_org_id text,
    p_group_ids uuid[]
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_result uuid[];
BEGIN
    IF p_group_ids IS NULL OR pg_catalog.array_length(p_group_ids, 1) IS NULL THEN
        RETURN ARRAY[]::uuid[];
    END IF;

    SELECT coalesce(pg_catalog.array_agg(g.group_id ORDER BY g.group_id ASC), ARRAY[]::uuid[])
    INTO v_result
    FROM scaleos_directory.groups g
    WHERE g.org_id = p_org_id
      AND g.group_id = ANY(p_group_ids);

    RETURN v_result;
END;
$$;

-- Returns group-to-member mappings for candidate groups in one batch.
CREATE OR REPLACE FUNCTION scaleos_directory.get_groups_members(
    p_org_id text,
    p_group_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_result jsonb;
BEGIN
    IF p_group_ids IS NULL OR pg_catalog.array_length(p_group_ids, 1) IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    SELECT coalesce(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'groupId', gm.group_id,
                'userId', gm.user_id
            )
            ORDER BY gm.group_id ASC, gm.user_id ASC
        ),
        '[]'::jsonb
    )
    INTO v_result
    FROM scaleos_directory.group_members gm
    JOIN scaleos_directory.groups g ON g.org_id = gm.org_id AND g.group_id = gm.group_id
    WHERE gm.org_id = p_org_id
      AND gm.group_id = ANY(p_group_ids);

    RETURN v_result;
END;
$$;

-- Lists the newest group audit events up to the specified limit (1..200, default 50).
CREATE OR REPLACE FUNCTION scaleos_directory.list_group_audit_events(
    p_org_id text,
    p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_effective_limit integer;
    v_result jsonb;
BEGIN
    v_effective_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

    SELECT coalesce(
        pg_catalog.jsonb_agg(
            sub.event
            ORDER BY sub.timestamp DESC, sub.event_id DESC
        ),
        '[]'::jsonb
    )
    INTO v_result
    FROM (
        SELECT gae.event, gae.timestamp, gae.event_id
        FROM scaleos_directory.group_audit_events gae
        WHERE gae.org_id = p_org_id
        ORDER BY gae.timestamp DESC, gae.event_id DESC
        LIMIT v_effective_limit
    ) sub;

    RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Atomic Group Mutation Function (OS service_role)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION scaleos_directory.apply_group_mutation(
    p_org_id text,
    p_actor_id uuid,
    p_operation text,
    p_mutation_id uuid,
    p_request_hash text,
    p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_current_version bigint;
    v_next_version bigint;
    v_prev_hash text;
    v_prev_result jsonb;
    v_now_dt timestamptz;
    v_now_iso text;
    v_event_id text;
    v_event_obj jsonb;
    v_result jsonb;

    -- createGroup vars
    v_new_group_id uuid;
    v_group_name text;
    v_group_name_key text;
    v_created_at_iso text;
    v_group_obj jsonb;
    v_receipt_obj jsonb;

    -- renameGroup vars
    v_target_group_id uuid;
    v_old_name text;
    v_old_revision bigint;

    -- replaceGroupMembers vars
    v_next_user_ids uuid[];
    v_before_count bigint;
    v_before_user_ids uuid[];
    v_after_count integer;
    v_invalid_user_count bigint;

    -- deleteGroup vars
    v_deleted_name text;
BEGIN
    -- 1. Validate mutation operation
    IF p_operation NOT IN ('createGroup', 'renameGroup', 'replaceGroupMembers', 'deleteGroup') THEN
        RAISE EXCEPTION 'INVALID_INPUT';
    END IF;

    -- 2. Transaction serialization: advisory lock per org + row lock on group_versions
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_org_id), 0);

    INSERT INTO scaleos_directory.group_versions (org_id, version)
    VALUES (p_org_id, 0)
    ON CONFLICT (org_id) DO NOTHING;

    SELECT gv.version
    INTO v_current_version
    FROM scaleos_directory.group_versions gv
    WHERE gv.org_id = p_org_id
    FOR UPDATE;

    -- 3. Check for idempotent replay
    SELECT gm.request_hash, gm.result
    INTO v_prev_hash, v_prev_result
    FROM scaleos_directory.group_mutations gm
    WHERE gm.org_id = p_org_id
      AND gm.actor_id = p_actor_id
      AND gm.operation = p_operation
      AND gm.mutation_id = p_mutation_id;

    IF FOUND THEN
        IF v_prev_hash = p_request_hash THEN
            RETURN v_prev_result;
        ELSE
            RAISE EXCEPTION 'CONFLICT';
        END IF;
    END IF;

    v_now_dt := pg_catalog.clock_timestamp();
    v_now_iso := pg_catalog.to_char(v_now_dt AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_next_version := v_current_version + 1;
    v_event_id := pg_catalog.gen_random_uuid()::text;

    -- 4. Execute operation
    IF p_operation = 'createGroup' THEN
        v_group_name := pg_catalog.btrim(p_payload->>'name');
        IF v_group_name IS NULL
           OR pg_catalog.char_length(v_group_name) < 1
           OR pg_catalog.char_length(v_group_name) > 80 THEN
            RAISE EXCEPTION 'INVALID_INPUT';
        END IF;

        v_group_name_key := coalesce(
            p_payload->>'nameKey',
            pg_catalog.lower(v_group_name)
        );

        IF EXISTS (
            SELECT 1 FROM scaleos_directory.groups g
            WHERE g.org_id = p_org_id AND g.name_key = v_group_name_key
        ) THEN
            RAISE EXCEPTION 'CONFLICT';
        END IF;

        IF p_payload->>'groupId' IS NOT NULL THEN
            BEGIN
                v_new_group_id := (p_payload->>'groupId')::uuid;
            EXCEPTION WHEN OTHERS THEN
                RAISE EXCEPTION 'INVALID_INPUT';
            END;
        ELSE
            v_new_group_id := pg_catalog.gen_random_uuid();
        END IF;

        v_created_at_iso := coalesce(p_payload->>'createdAt', v_now_iso);

        INSERT INTO scaleos_directory.groups (
            org_id, group_id, name, name_key, revision, created_at, updated_at
        ) VALUES (
            p_org_id, v_new_group_id, v_group_name, v_group_name_key, 1, v_now_dt, v_now_dt
        );

        UPDATE scaleos_directory.group_versions
        SET version = v_next_version
        WHERE org_id = p_org_id;

        v_group_obj := pg_catalog.jsonb_build_object(
            'groupId', v_new_group_id,
            'name', v_group_name,
            'createdAt', v_created_at_iso,
            'updatedAt', v_now_iso
        );

        v_receipt_obj := pg_catalog.jsonb_build_object(
            'mutationId', p_mutation_id,
            'policyVersion', v_next_version,
            'confirmedAt', v_now_iso
        );

        v_result := pg_catalog.jsonb_build_object(
            'group', v_group_obj,
            'receipt', v_receipt_obj
        );

        v_event_obj := pg_catalog.jsonb_build_object(
            'eventId', v_event_id,
            'occurredAt', v_now_iso,
            'tenantId', p_org_id,
            'actorUserId', p_actor_id,
            'resourceType', 'directoryGroup',
            'resourceId', v_new_group_id,
            'action', 'createGroup',
            'beforeVersion', v_current_version,
            'afterVersion', v_next_version,
            'result', 'succeeded',
            'reasonCode', 'DIRECTORY_GROUP_CREATED',
            'correlationId', p_mutation_id,
            'idempotencyKey', p_mutation_id,
            'change', pg_catalog.jsonb_build_object(
                'field', 'name',
                'before', null,
                'after', v_group_name
            )
        );

    ELSIF p_operation = 'renameGroup' THEN
        BEGIN
            v_target_group_id := (p_payload->>'groupId')::uuid;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'INVALID_INPUT';
        END;

        SELECT g.name, g.revision
        INTO v_old_name, v_old_revision
        FROM scaleos_directory.groups g
        WHERE g.org_id = p_org_id AND g.group_id = v_target_group_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'NOT_FOUND';
        END IF;

        v_group_name := pg_catalog.btrim(p_payload->>'name');
        IF v_group_name IS NULL
           OR pg_catalog.char_length(v_group_name) < 1
           OR pg_catalog.char_length(v_group_name) > 80 THEN
            RAISE EXCEPTION 'INVALID_INPUT';
        END IF;

        v_group_name_key := coalesce(
            p_payload->>'nameKey',
            pg_catalog.lower(v_group_name)
        );

        IF EXISTS (
            SELECT 1 FROM scaleos_directory.groups g
            WHERE g.org_id = p_org_id
              AND g.name_key = v_group_name_key
              AND g.group_id <> v_target_group_id
        ) THEN
            RAISE EXCEPTION 'CONFLICT';
        END IF;

        UPDATE scaleos_directory.groups
        SET name = v_group_name,
            name_key = v_group_name_key,
            revision = revision + 1,
            updated_at = v_now_dt
        WHERE org_id = p_org_id AND group_id = v_target_group_id;

        UPDATE scaleos_directory.group_versions
        SET version = v_next_version
        WHERE org_id = p_org_id;

        v_result := pg_catalog.jsonb_build_object(
            'mutationId', p_mutation_id,
            'policyVersion', v_next_version,
            'confirmedAt', v_now_iso
        );

        v_event_obj := pg_catalog.jsonb_build_object(
            'eventId', v_event_id,
            'occurredAt', v_now_iso,
            'tenantId', p_org_id,
            'actorUserId', p_actor_id,
            'resourceType', 'directoryGroup',
            'resourceId', v_target_group_id,
            'action', 'renameGroup',
            'beforeVersion', v_current_version,
            'afterVersion', v_next_version,
            'result', 'succeeded',
            'reasonCode', 'DIRECTORY_GROUP_RENAMED',
            'correlationId', p_mutation_id,
            'idempotencyKey', p_mutation_id,
            'change', pg_catalog.jsonb_build_object(
                'field', 'name',
                'before', v_old_name,
                'after', v_group_name
            )
        );

    ELSIF p_operation = 'replaceGroupMembers' THEN
        BEGIN
            v_target_group_id := (p_payload->>'groupId')::uuid;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'INVALID_INPUT';
        END;

        IF NOT EXISTS (
            SELECT 1 FROM scaleos_directory.groups g
            WHERE g.org_id = p_org_id AND g.group_id = v_target_group_id
        ) THEN
            RAISE EXCEPTION 'NOT_FOUND';
        END IF;

        IF p_payload->'userIds' IS NULL OR pg_catalog.jsonb_typeof(p_payload->'userIds') <> 'array' THEN
            RAISE EXCEPTION 'INVALID_INPUT';
        END IF;

        BEGIN
            SELECT coalesce(pg_catalog.array_agg(DISTINCT elem::uuid), ARRAY[]::uuid[])
            INTO v_next_user_ids
            FROM pg_catalog.jsonb_array_elements_text(p_payload->'userIds') AS elem;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'INVALID_INPUT';
        END;

        SELECT count(*), coalesce(pg_catalog.array_agg(gm.user_id), ARRAY[]::uuid[])
        INTO v_before_count, v_before_user_ids
        FROM scaleos_directory.group_members gm
        WHERE gm.org_id = p_org_id AND gm.group_id = v_target_group_id;

        -- Validate every member exists in auth.users, and new members must be active.
        IF pg_catalog.array_length(v_next_user_ids, 1) > 0 THEN
            SELECT count(*)
            INTO v_invalid_user_count
            FROM pg_catalog.unnest(v_next_user_ids) AS u_id
            LEFT JOIN auth.users u ON u.id = u_id
            WHERE u.id IS NULL
               OR (
                   NOT (u_id = ANY(v_before_user_ids))
                   AND (u.deleted_at IS NOT NULL OR (u.banned_until IS NOT NULL AND u.banned_until > pg_catalog.clock_timestamp()))
               );

            IF v_invalid_user_count > 0 THEN
                RAISE EXCEPTION 'INVALID_INPUT';
            END IF;
        END IF;

        DELETE FROM scaleos_directory.group_members
        WHERE org_id = p_org_id
          AND group_id = v_target_group_id
          AND NOT (user_id = ANY(v_next_user_ids));

        IF pg_catalog.array_length(v_next_user_ids, 1) > 0 THEN
            INSERT INTO scaleos_directory.group_members (org_id, group_id, user_id)
            SELECT p_org_id, v_target_group_id, u_id
            FROM pg_catalog.unnest(v_next_user_ids) AS u_id
            ON CONFLICT (org_id, group_id, user_id) DO NOTHING;
        END IF;

        v_after_count := coalesce(pg_catalog.array_length(v_next_user_ids, 1), 0);

        UPDATE scaleos_directory.groups
        SET revision = revision + 1,
            updated_at = v_now_dt
        WHERE org_id = p_org_id AND group_id = v_target_group_id;

        UPDATE scaleos_directory.group_versions
        SET version = v_next_version
        WHERE org_id = p_org_id;

        v_result := pg_catalog.jsonb_build_object(
            'mutationId', p_mutation_id,
            'policyVersion', v_next_version,
            'confirmedAt', v_now_iso
        );

        v_event_obj := pg_catalog.jsonb_build_object(
            'eventId', v_event_id,
            'occurredAt', v_now_iso,
            'tenantId', p_org_id,
            'actorUserId', p_actor_id,
            'resourceType', 'directoryGroup',
            'resourceId', v_target_group_id,
            'action', 'replaceGroupMembers',
            'beforeVersion', v_current_version,
            'afterVersion', v_next_version,
            'result', 'succeeded',
            'reasonCode', 'DIRECTORY_GROUP_MEMBERS_CHANGED',
            'correlationId', p_mutation_id,
            'idempotencyKey', p_mutation_id,
            'change', pg_catalog.jsonb_build_object(
                'field', 'members',
                'before', v_before_count::text,
                'after', v_after_count::text
            )
        );

    ELSIF p_operation = 'deleteGroup' THEN
        BEGIN
            v_target_group_id := (p_payload->>'groupId')::uuid;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'INVALID_INPUT';
        END;

        SELECT g.name
        INTO v_deleted_name
        FROM scaleos_directory.groups g
        WHERE g.org_id = p_org_id AND g.group_id = v_target_group_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'NOT_FOUND';
        END IF;

        DELETE FROM scaleos_directory.groups
        WHERE org_id = p_org_id AND group_id = v_target_group_id;

        UPDATE scaleos_directory.group_versions
        SET version = v_next_version
        WHERE org_id = p_org_id;

        v_result := pg_catalog.jsonb_build_object(
            'mutationId', p_mutation_id,
            'policyVersion', v_next_version,
            'confirmedAt', v_now_iso
        );

        v_event_obj := pg_catalog.jsonb_build_object(
            'eventId', v_event_id,
            'occurredAt', v_now_iso,
            'tenantId', p_org_id,
            'actorUserId', p_actor_id,
            'resourceType', 'directoryGroup',
            'resourceId', v_target_group_id,
            'action', 'deleteGroup',
            'beforeVersion', v_current_version,
            'afterVersion', v_next_version,
            'result', 'succeeded',
            'reasonCode', 'DIRECTORY_GROUP_DELETED',
            'correlationId', p_mutation_id,
            'idempotencyKey', p_mutation_id,
            'change', pg_catalog.jsonb_build_object(
                'field', 'name',
                'before', v_deleted_name,
                'after', null
            )
        );
    END IF;

    -- 5. Store audit event and mutation record atomically
    INSERT INTO scaleos_directory.group_audit_events (
        org_id, event_id, event, timestamp
    ) VALUES (
        p_org_id, v_event_id, v_event_obj, v_now_dt
    );

    INSERT INTO scaleos_directory.group_mutations (
        org_id, actor_id, operation, mutation_id, request_hash, result, created_at
    ) VALUES (
        p_org_id, p_actor_id, p_operation, p_mutation_id, p_request_hash, v_result, v_now_dt
    );

    RETURN v_result;
END;
$$;
