-- tobackup.t_image definition

-- Drop table

-- DROP TABLE tobackup.t_image;

CREATE TABLE tobackup.t_image (
	tid int8 NOT NULL,
	image bytea NULL,
	"mode" int4 NOT NULL,
	roi text NOT NULL,
	revision int8 NULL,
	CONSTRAINT t_image_pkey PRIMARY KEY (tid)
);
CREATE INDEX idx_image_revision ON tobackup.t_image USING btree (revision DESC);

-- Table Triggers

create trigger insert_revision_image after
insert
    on
    tobackup.t_image for each row execute function insert_revision_image();


-- tobackup.t_image foreign keys

ALTER TABLE tobackup.t_image ADD CONSTRAINT t_image_tid_fkey FOREIGN KEY (tid) REFERENCES tobackup.t_log(tid) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;