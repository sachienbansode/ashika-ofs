CREATE SCHEMA IF NOT EXISTS dwh;
CREATE SCHEMA IF NOT EXISTS stg;
CREATE SCHEMA IF NOT EXISTS "admin-staging-api";

CREATE TABLE dwh.tbl_user_info (
  ucc text, name_asper_pan text, client_name text,
  first_name text, middle_name text, last_name text,
  pan text, mobile text, email text,
  depository text, dp_name text, dp_account_no text,
  ucc_client_category text, city text, state text,
  status text, etl_loaded_at timestamptz DEFAULT now()
);
CREATE TABLE stg.ask_clientmast (
  ctermcode text, name_asper_pan text, cclientname text, mobile text, email_id text,
  client_category text, branch_id text, residential_status text, city text, state text,
  cstatus text, activation_status text, last_traded_date date, account_opened date
);
CREATE TABLE stg.branchho (
  branchcode text, branchname text, firmnumber text, branchtype text,
  active text, email text, cmobileno text, contactperson text, ccity text, cstate text
);
CREATE TABLE "admin-staging-api".roles (
  id serial PRIMARY KEY, name text, permissions jsonb,
  requires_mfa boolean DEFAULT false, use_m365 boolean DEFAULT false
);
CREATE TABLE "admin-staging-api".users (
  id serial PRIMARY KEY, email text, first_name text, last_name text,
  password_hash text, is_active boolean DEFAULT true, mfa_enabled boolean DEFAULT false,
  auth_provider text DEFAULT 'local', role_id int, active_sid text, last_login_at timestamptz
);
CREATE TABLE "admin-staging-api".page_registry (
  id serial PRIMARY KEY, key text, label text, module text, sort_order int
);
CREATE TABLE "admin-staging-api".smtp_settings (
  id serial PRIMARY KEY, host text, port int, username text,
  password_encrypted text, from_email text, from_name text, secure boolean, is_active boolean
);

-- ---- roles & staff -------------------------------------------------------
INSERT INTO "admin-staging-api".roles (id, name, permissions) VALUES
  (1, 'SuperAdmin', '{"pages":["*"]}'),
  (2, 'OFS Desk',   '{"pages":["ofs-desk"]}'),
  (3, 'No Access',  '{"pages":["other-module"]}');

-- bcrypt hash of 'Passw0rd!TestOnly'
INSERT INTO "admin-staging-api".users (id, email, first_name, last_name, password_hash, role_id) VALUES
  (1, 'desk@example.com', 'Desk', 'User',  '$2a$10$NfhM4gf.Dx3AKQ4MAhIS3erjnV4iDMqbQ8UTG/YGNlhYYq6zTXEsK', 1),
  (2, 'view@example.com', 'View', 'Only',  '$2a$10$NfhM4gf.Dx3AKQ4MAhIS3erjnV4iDMqbQ8UTG/YGNlhYYq6zTXEsK', 2),
  (3, 'none@example.com', 'No',   'Access','$2a$10$NfhM4gf.Dx3AKQ4MAhIS3erjnV4iDMqbQ8UTG/YGNlhYYq6zTXEsK', 3);

-- ---- branches ------------------------------------------------------------
INSERT INTO stg.branchho (branchcode, branchname, firmnumber, branchtype, active, email, cmobileno, contactperson, ccity, cstate)
VALUES ('A016','Andheri Branch','ASK-000001','B','Y','branch.a016@example.com','9000000016','Branch Head','Mumbai','MH'),
       ('A017','Pune Branch',   'ASK-000001','B','N','branch.a017@example.com','9000000017','Head Two','Pune','MH');

-- ---- clients -------------------------------------------------------------
-- active, belongs to A016
INSERT INTO dwh.tbl_user_info (ucc,name_asper_pan,pan,mobile,email,ucc_client_category,city,state,status)
VALUES ('ASH1001','ACTIVE CLIENT ONE','AAAPZ1234A','9811100001','client1@example.com','Individual','Mumbai','MH','Active'),
       ('ASH1002','ACTIVE CLIENT TWO','AAAPZ1234B','9811100002','client2@example.com','Individual','Mumbai','MH','Active'),
       ('ASH9001','INACTIVE CLIENT',  'AAAPZ9999Z','9811109001','client9@example.com','Individual','Pune','MH','Inactive'),
       ('ASH2001','OTHER BRANCH CLI', 'AAAPZ2222C','9811102001','client3@example.com','Individual','Pune','MH','Active'),
       -- Held in the user table, but with NO row in the client master below. This
       -- is the client that used to come out ACTIVE and could bid: each status fell
       -- back to the other, so the one source that was present answered for both.
       ('ASH7001','ORPHAN NO MASTER', 'AAAPZ7777D','9811107001','client7@example.com','Individual','Thane','MH','Active'),
       -- In the master, but with no status recorded either side. A blank is not a yes.
       ('ASH7002','BLANK STATUS',     'AAAPZ7778E','9811107002','client8@example.com','Individual','Thane','MH','');
INSERT INTO stg.ask_clientmast (ctermcode,cclientname,mobile,email_id,client_category,branch_id,cstatus,activation_status)
VALUES ('ASH1001','ACTIVE CLIENT ONE','9811100001','client1@example.com','Individual','A016','Active','Y'),
       ('ASH1002','ACTIVE CLIENT TWO','9811100002','client2@example.com','Individual','A016','Active','Y'),
       ('ASH9001','INACTIVE CLIENT',  '9811109001','client9@example.com','Individual','A016','Inactive','N'),
       ('ASH2001','OTHER BRANCH CLI', '9811102001','client3@example.com','Individual','A017','Active','Y'),
       ('ASH7002','BLANK STATUS',     '9811107002','client8@example.com','Individual','A016','','Y');
