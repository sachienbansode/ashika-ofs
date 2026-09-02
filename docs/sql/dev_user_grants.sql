-- ============================================================================
-- dev_ashikatech — a login role with read + write + execute on chosen databases.
--
-- RUN IN pgAdmin. Postgres grants are PER DATABASE, so this is not one script you
-- run once: STEP 1 runs once for the whole server, then STEP 2 runs again for each
-- database, WITH PGADMIN CONNECTED TO THAT DATABASE. Running STEP 2 while connected
-- to `postgres` grants nothing in `ofs_bids`, silently.
--
-- Run as a superuser (or as the owner of the objects being granted).
-- ============================================================================


-- ============================================================================
-- STEP 1 — create the role. Once per SERVER; roles are cluster-wide.
-- Connect to any database (e.g. postgres) and run this block.
-- ============================================================================

-- Set the password in pgAdmin's Login/Group Roles dialog rather than typing it
-- here, so it does not end up in the query history or in a saved .sql file.
-- If you do set it here, change it afterwards and clear the query history.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ashikatech') THEN
    CREATE ROLE dev_ashikatech
      LOGIN
      PASSWORD 'CHANGE_ME_BEFORE_RUNNING'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      CONNECTION LIMIT 20;              -- a runaway dev tool cannot exhaust the server
    RAISE NOTICE 'created role dev_ashikatech';
  ELSE
    RAISE NOTICE 'role dev_ashikatech already exists — leaving it alone';
  END IF;
END $$;

-- Optional: expire the password so it must be rotated.
-- ALTER ROLE dev_ashikatech VALID UNTIL '2027-03-31';


-- ============================================================================
-- STEP 2 — grant inside ONE database.
--
-- Repeat for each database. In pgAdmin, open a Query Tool ON THAT DATABASE
-- (right-click the database → Query Tool) and run this whole block:
--
--     ofs_bids
--     uat_ananta_staging
--     ...any other
--
-- Edit `v_schemas` below to name the schemas this role should reach.
-- ============================================================================

DO $$
DECLARE
  v_role    text := 'dev_ashikatech';

  -- The schemas to grant. Name them explicitly rather than looping over every
  -- schema in the database: see the note about "admin-staging-api" at the bottom.
  --   ofs_bids            -> ARRAY['public','ofs']
  --   uat_ananta_staging  -> ARRAY['public','dwh','stg']            (see note)
  v_schemas text[] := ARRAY['public','ofs'];

  s         text;
  owner     text;
BEGIN
  -- Connect to this database at all.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), v_role);

  FOREACH s IN ARRAY v_schemas LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
      RAISE NOTICE 'skipping %.% — no such schema here', current_database(), s;
      CONTINUE;
    END IF;

    -- USAGE is what makes the schema's contents addressable at all. Without it
    -- every grant below is invisible to the role.
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, v_role);

    -- READ + WRITE on what exists today.
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA %I TO %I', s, v_role);

    -- Sequences: an INSERT into a table with a bigserial id fails with
    -- "permission denied for sequence" without USAGE here. UPDATE covers setval.
    EXECUTE format(
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', s, v_role);

    -- EXECUTE on functions AND procedures. ROUTINES covers both; on PostgreSQL 10
    -- and older use FUNCTIONS instead.
    EXECUTE format(
      'GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %I TO %I', s, v_role);

    -- Everything above applies only to objects that exist RIGHT NOW. A table
    -- created tomorrow is invisible to the role unless default privileges are set,
    -- and they attach to the ROLE THAT CREATES the object — not to the role running
    -- this script. So set them for every role that already owns something here.
    FOR owner IN
      SELECT DISTINCT pg_get_userbyid(c.relowner)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = s AND c.relkind IN ('r','p','v','m','S')
      UNION
      SELECT DISTINCT pg_get_userbyid(p.proowner)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = s
    LOOP
      BEGIN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
             GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO %I', owner, s, v_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
             GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', owner, s, v_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I
             GRANT EXECUTE ON ROUTINES TO %I', owner, s, v_role);
        RAISE NOTICE 'future objects owned by % in %.% -> %', owner, current_database(), s, v_role;
      EXCEPTION WHEN insufficient_privilege THEN
        -- Only a superuser, or a member of `owner`, may set that owner's defaults.
        RAISE WARNING 'could not set default privileges for owner % in schema % — run as superuser or as %', owner, s, owner;
      END;
    END LOOP;

    RAISE NOTICE 'granted %.% to %', current_database(), s, v_role;
  END LOOP;
END $$;


-- ============================================================================
-- STEP 3 — verify. Run in the SAME database.
-- ============================================================================

-- Can it connect?
SELECT has_database_privilege('dev_ashikatech', current_database(), 'CONNECT') AS can_connect;

-- What can it do on each schema's tables? Expect r/w on every row.
SELECT n.nspname AS schema,
       count(*)                                                                     AS tables,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'SELECT')) AS can_select,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'INSERT')) AS can_insert,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'UPDATE')) AS can_update,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'DELETE')) AS can_delete
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
 GROUP BY n.nspname ORDER BY n.nspname;

-- Are future objects covered? One row per owner per schema.
SELECT n.nspname AS schema, pg_get_userbyid(d.defaclrole) AS for_owner,
       d.defaclobjtype AS obj_type, d.defaclacl AS grants
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
 ORDER BY 1, 2, 3;


-- ============================================================================
-- NOTES
-- ============================================================================
--
-- 1. "admin-staging-api" is NOT in the default schema list above, deliberately.
--    It holds the portal's users and roles — bcrypt password hashes, MFA flags,
--    active sessions. Read-write there means being able to grant yourself any role
--    in either app. Add it only if the person behind this login is meant to have
--    that, and prefer read-only if they are not:
--
--      GRANT USAGE ON SCHEMA "admin-staging-api" TO dev_ashikatech;
--      GRANT SELECT ON ALL TABLES IN SCHEMA "admin-staging-api" TO dev_ashikatech;
--
-- 2. This role can read and write DATA but cannot create or drop TABLES, because it
--    has no CREATE on any schema. If it needs to run migrations, add per schema:
--
--      GRANT CREATE ON SCHEMA ofs TO dev_ashikatech;
--
--    Note that objects it then creates are owned BY IT, so other roles will need
--    their own default privileges for its objects.
--
-- 3. Simpler but broader alternative (PostgreSQL 14+): the built-in roles cover
--    every table in whichever database the role connects to, present and future,
--    with no schema list to maintain — and no way to exclude "admin-staging-api".
--
--      GRANT pg_read_all_data, pg_write_all_data TO dev_ashikatech;
--
--    They do not grant EXECUTE on functions, so STEP 2's routine grants are still
--    needed. Use this only if the role is genuinely meant to reach everything.
--
-- 4. Server access still has to allow the login: pg_hba.conf must have a line for
--    this role/host, and the AWS security group must allow the developer's IP.
--
-- 5. To undo everything:
--      REASSIGN OWNED BY dev_ashikatech TO postgres;   -- per database
--      DROP OWNED BY dev_ashikatech;                   -- per database, drops grants
--      DROP ROLE dev_ashikatech;                       -- once, after the above
