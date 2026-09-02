-- 011 — the paperwork behind an issue.
--
-- An OFS is created by a document: the NSE circular, the BSE notice, the member
-- notice the desk received. When someone asks in six months "why did we bid at that
-- floor price?", the answer is that document — so it belongs ON the issue, not in
-- somebody's Downloads folder.
--
-- Two kinds of row, one table:
--   storage = 'link'  the public circular URL. Nothing stored but the address.
--   storage = 'file'  a PDF the desk uploaded, because member notices are not public.
--
-- Files live on disk (OFS_DOC_DIR), not in Postgres: a bidding-window database
-- should not be carrying 5MB blobs, and a checksum here is enough to prove the file
-- on disk is the one that was uploaded.
CREATE TABLE IF NOT EXISTS ofs.ofs_issue_doc (
  id         bigserial   PRIMARY KEY,
  issue_id   bigint      NOT NULL REFERENCES ofs.ofs_issue(id) ON DELETE CASCADE,
  kind       text        NOT NULL DEFAULT 'circular',  -- circular | notice | allotment | other
  source     text        NOT NULL DEFAULT 'manual',    -- NSE | BSE | manual
  title      text        NOT NULL,
  storage    text        NOT NULL DEFAULT 'link',      -- link | file
  url        text,                                     -- storage='link'
  file_name  text,                                     -- storage='file', on disk
  orig_name  text,
  mime       text,
  bytes      bigint,
  sha256     text,
  circular_id bigint     REFERENCES ofs.ofs_circular(id) ON DELETE SET NULL,
  added_by   text,
  added_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ofs_issue_doc_kind_ck    CHECK (kind IN ('circular','notice','allotment','other')),
  CONSTRAINT ofs_issue_doc_storage_ck CHECK (storage IN ('link','file')),
  -- A row must actually point at something.
  CONSTRAINT ofs_issue_doc_target_ck  CHECK (
    (storage = 'link' AND url IS NOT NULL AND url <> '') OR
    (storage = 'file' AND file_name IS NOT NULL AND file_name <> ''))
);

CREATE INDEX IF NOT EXISTS ofs_issue_doc_issue_ix ON ofs.ofs_issue_doc (issue_id, added_at DESC);
-- The same circular attached twice to one issue is a mistake, not a second document.
CREATE UNIQUE INDEX IF NOT EXISTS ofs_issue_doc_link_uq
  ON ofs.ofs_issue_doc (issue_id, url) WHERE storage = 'link';
