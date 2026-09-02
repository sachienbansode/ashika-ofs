-- ============================================================================
-- dev_ashikatech — read + write + execute on  ashikawdn  and  ofs_bids
--
-- The role already exists. This is the grant half only.
--
-- HOW TO RUN IT: grants are per database. Run the block below TWICE — once with
-- pgAdmin's Query Tool open ON ashikawdn, once ON ofs_bids. Right-click the
-- database in the browser tree → Query Tool. Running it while connected to
-- `postgres` grants nothing in either, and reports no error.
--
-- Run as a superuser (postgres), or as the owner of the objects being granted.
-- ============================================================================

DO $$
DECLARE
  v_role text := 'dev_ashikatech';

  -- Every schema in this database except the system ones and the two below.
  -- "admin-staging-api" is excluded on purpose: it holds the portal's users and
  -- roles — bcrypt password hashes, MFA flags, live sessions — so read-write there
  -- means being able to grant yourself any role in either app. Grant it separately,
  -- read-only, if this developer genuinely needs it (see the note at the bottom).
  v_skip  text[] := ARRAY['information_schema', 'admin-staging-api'];

  s      text;
  owner  text;
  n_tab  int;
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), v_role);
  RAISE NOTICE '--- % ---', current_database();

  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg\_%'
       AND NOT (nspname = ANY (v_skip))
     ORDER BY nspname
  LOOP
    -- USAGE first: without it every grant below is invisible to the role. This is
    -- the usual cause of "I granted everything and it still says permission denied".
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, v_role);

    -- READ + WRITE on what exists now.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER '
                   'ON ALL TABLES IN SCHEMA %I TO %I', s, v_role);

    -- Sequences. An INSERT into any bigserial table fails with "permission denied
    -- for sequence" without this, however complete the table grants look.
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', s, v_role);

    -- EXECUTE. ROUTINES covers functions and procedures both.
    EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %I TO %I', s, v_role);

    -- All of the above covers only objects that exist RIGHT NOW. Default privileges
    -- cover what gets created later — and they attach to the role that CREATES the
    -- object, not to whoever runs this script. So set them for each role that
    -- already owns something here.
    FOR owner IN
      SELECT DISTINCT pg_get_userbyid(c.relowner)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = s AND c.relkind IN ('r','p','v','m','S')
      UNION
      SELECT DISTINCT pg_get_userbyid(p.proowner)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = s
    LOOP
      BEGIN
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                       'GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO %I',
                       owner, s, v_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                       'GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', owner, s, v_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                       'GRANT EXECUTE ON ROUTINES TO %I', owner, s, v_role);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE WARNING 'schema %: could not set future-object grants for owner "%" '
                      '— re-run as superuser or as that role', s, owner;
      END;
    END LOOP;

    SELECT count(*) INTO n_tab
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = s AND c.relkind IN ('r','p');
    RAISE NOTICE 'schema % : % table(s) granted', s, n_tab;
  END LOOP;
END $$;


-- ============================================================================
-- VERIFY — run in the same database. can_select/insert/update/delete should
-- equal `tables` on every row.
-- ============================================================================
SELECT current_database() AS db,
       has_database_privilege('dev_ashikatech', current_database(), 'CONNECT') AS can_connect;

SELECT n.nspname AS schema,
       count(*)                                                                       AS tables,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'SELECT')) AS can_select,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'INSERT')) AS can_insert,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'UPDATE')) AS can_update,
       count(*) FILTER (WHERE has_table_privilege('dev_ashikatech', c.oid, 'DELETE')) AS can_delete
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p')
   AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
 GROUP BY n.nspname ORDER BY n.nspname;

-- Future objects: one row per owner per schema. An empty result means new tables
-- will NOT be visible to dev_ashikatech.
SELECT n.nspname AS schema, pg_get_userbyid(d.defaclrole) AS for_owner,
       CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
                            WHEN 'f' THEN 'routines' ELSE d.defaclobjtype::text END AS applies_to
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
 ORDER BY 1, 2, 3;


-- ============================================================================
-- NOTES
-- ============================================================================
-- • This grants DATA access only. The role cannot CREATE or DROP tables, because it
--   has no CREATE on any schema. If it must run migrations, add per schema:
--       GRANT CREATE ON SCHEMA ofs TO dev_ashikatech;
--   Objects it then creates are owned by it, so other roles need their own default
--   privileges for them.
--
-- • If "admin-staging-api" access is genuinely needed, keep it read-only:
--       GRANT USAGE ON SCHEMA "admin-staging-api" TO dev_ashikatech;
--       GRANT SELECT ON ALL TABLES IN SCHEMA "admin-staging-api" TO dev_ashikatech;
--
-- • Connecting still needs pg_hba.conf to have a line for this role/host, and the
--   AWS security group to allow the developer's IP.
--
-- • To undo, per database:  DROP OWNED BY dev_ashikatech;
--   then once:              DROP ROLE dev_ashikatech;
